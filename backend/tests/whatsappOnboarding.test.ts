/**
 * WhatsApp onboarding building blocks - pure unit tests: the credential vault,
 * reading Meta's answer, the eligibility rules and the Meta adapter's handling
 * of errors and secrets (with a fake HTTP client - nothing leaves the process).
 *
 * Run: npx tsx --test backend/tests/whatsappOnboarding.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { CredentialVaultError, isVaultConfigured, openCredential, sealCredential } from '../src/services/credentialVault';
import { maskId, statusFromMeta } from '../src/services/whatsappOnboardingService';
import { embeddedSenderProblems, ownerMayUseSender, ownerRefusal } from '../src/services/senderEligibility';
import { createMetaOnboardingApi, MetaOnboardingError, type MetaHttp } from '../src/services/metaOnboardingApi';

const keyEnv = () => ({ WHATSAPP_CREDENTIAL_KEY: crypto.randomBytes(32).toString('base64') }) as NodeJS.ProcessEnv;

describe('credential vault', () => {
  test('round-trips, with a fresh IV each time, and the ciphertext never contains the plaintext', () => {
    const env = keyEnv();
    const a = sealCredential('secret-token-value', env);
    const b = sealCredential('secret-token-value', env);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.equal(JSON.stringify(a).includes('secret-token-value'), false);
    assert.equal(openCredential(a, env), 'secret-token-value');
  });

  test('a tampered value, a different key, or no key never decrypts to something', () => {
    const env = keyEnv();
    const sealed = sealCredential('secret-token-value', env);
    const flipped = Buffer.from(sealed.ciphertext, 'base64');
    flipped[0] ^= 0xff;
    assert.throws(() => openCredential({ ...sealed, ciphertext: flipped.toString('base64') }, env), (e: any) => e instanceof CredentialVaultError && e.code === 'CORRUPT');
    assert.throws(() => openCredential(sealed, keyEnv()), (e: any) => e.code === 'KEY_MISMATCH');
    assert.throws(() => openCredential({ ...sealed, keyId: undefined as any }, keyEnv()), (e: any) => e.code === 'CORRUPT');
    assert.throws(() => sealCredential('x', {} as NodeJS.ProcessEnv), (e: any) => e.code === 'NOT_CONFIGURED');
    assert.throws(() => openCredential(null, env), (e: any) => e.code === 'CORRUPT');
  });

  test('the key must be exactly 32 bytes; errors never echo it', () => {
    assert.equal(isVaultConfigured(keyEnv()), true);
    assert.equal(isVaultConfigured({ WHATSAPP_CREDENTIAL_KEY: Buffer.alloc(16).toString('base64') } as any), false);
    assert.equal(isVaultConfigured({} as any), false);
    try {
      sealCredential('x', { WHATSAPP_CREDENTIAL_KEY: 'c2hvcnQ=' } as any);
    } catch (e: any) {
      assert.equal(e.message.includes('c2hvcnQ='), false);
    }
  });
});

describe("reading Meta's answer about a number", () => {
  const node = (over: Record<string, unknown>) => ({ id: '123456', displayPhoneNumber: null, verifiedName: null, status: null, qualityRating: null, codeVerificationStatus: null, nameStatus: null, platformType: null, ...over }) as any;

  test('on Cloud API and CONNECTED is connected; on Cloud API otherwise needs action; not on Cloud API needs registration', () => {
    assert.equal(statusFromMeta(node({ platformType: 'CLOUD_API', status: 'CONNECTED' })).status, 'connected');
    const flagged = statusFromMeta(node({ platformType: 'CLOUD_API', status: 'FLAGGED' }));
    assert.equal(flagged.status, 'action_required');
    assert.match(flagged.nextActionMessage!, /FLAGGED/);
    for (const platformType of ['NOT_APPLICABLE', null, 'ON_PREMISE']) {
      const pending = statusFromMeta(node({ platformType, status: 'CONNECTED' }));
      assert.equal(pending.status, 'pending_registration', String(platformType));
      assert.equal(pending.nextAction, 'register');
    }
  });

  test('ids are masked to their last four characters', () => {
    assert.equal(maskId('106540352242922'), '…2922');
    assert.equal(maskId('12'), '…');
  });
});

describe('eligibility', () => {
  const embedded = (over: Record<string, unknown> = {}) => ({ source: 'embedded_signup', ownerAccountId: 'owner1', allowedAdminIds: [], enabled: true, onboardingStatus: 'connected', ...over });
  const inventory = (over: Record<string, unknown> = {}) => ({ source: 'inventory', allowedAdminIds: ['admin1'], ...over });

  test('a connected number: its owner\'s events (Admin or Super Admin) and allowed Admins - nobody else', () => {
    assert.equal(ownerMayUseSender(embedded(), { kind: 'admin', adminId: 'owner1' }), true);
    assert.equal(ownerMayUseSender(embedded(), { kind: 'superadmin', adminId: 'owner1' }), true, 'a Super Admin\'s own number for their own events');
    assert.equal(ownerMayUseSender(embedded(), { kind: 'admin', adminId: 'other' }), false);
    assert.equal(ownerMayUseSender(embedded(), { kind: 'superadmin', adminId: 'other' }), false, 'another Super Admin\'s events cannot borrow it');
    assert.equal(ownerMayUseSender(embedded({ allowedAdminIds: ['other'] }), { kind: 'admin', adminId: 'other' }), true);
    assert.equal(ownerMayUseSender(embedded({ allowedAdminIds: ['other'] }), { kind: 'superadmin', adminId: 'other' }), false);
    assert.equal(ownerMayUseSender(embedded(), { kind: 'unverified', reason: 'x' }), false);
  });

  test('an inventory sender keeps decision A exactly: allowed Admins only, never a Super Admin\'s event', () => {
    assert.equal(ownerMayUseSender(inventory(), { kind: 'admin', adminId: 'admin1' }), true);
    assert.equal(ownerMayUseSender(inventory(), { kind: 'admin', adminId: 'admin2' }), false);
    assert.equal(ownerMayUseSender(inventory(), { kind: 'superadmin', adminId: 'admin1' }), false);
    assert.match(ownerRefusal(inventory(), { kind: 'superadmin', adminId: 's' }), /owned by a Super Admin/);
    assert.match(ownerRefusal(embedded(), { kind: 'admin', adminId: 'x' }), /belongs to another account/);
  });

  test('what stops a connected number is named: status, missing credential, not enabled', () => {
    assert.deepEqual(embeddedSenderProblems(embedded(), true), []);
    assert.match(embeddedSenderProblems(embedded({ onboardingStatus: 'pending_registration' }), true)[0], /registration/);
    assert.match(embeddedSenderProblems(embedded({ onboardingStatus: 'disconnected' }), false)[0], /disconnected/);
    assert.equal(embeddedSenderProblems(embedded({ onboardingStatus: 'disconnected' }), false).some((p) => /authorization/.test(p)), false, 'a disconnected number is not also told its token is missing');
    assert.match(embeddedSenderProblems(embedded(), false)[0], /authorization is missing/);
    assert.match(embeddedSenderProblems(embedded({ enabled: false }), true)[0], /not enabled/);
    assert.match(embeddedSenderProblems(embedded({ onboardingStatus: 'action_required', nextActionMessage: 'Fix the display name' }), true)[0], /display name/);
  });
});

describe('Meta adapter', () => {
  const config = { appId: '111', appSecret: 'APP-SECRET-SENTINEL', apiVersion: 'v22.0' };
  const failing = (status: number, error: any): MetaHttp => ({
    get: async () => { const e: any = new Error('x'); e.response = { status, data: { error } }; throw e; },
    post: async () => { const e: any = new Error('x'); e.response = { status, data: { error } }; throw e; },
  });

  test('the code exchange uses the documented endpoint and parameters, and needs a real token back', async () => {
    const seen: any[] = [];
    const api = createMetaOnboardingApi(config, {
      get: async (url, options) => { seen.push({ url, options }); return { data: { access_token: 'EAAB-business-token-long-enough' } }; },
      post: async () => ({ data: {} }),
    });
    assert.equal(await api.exchangeCodeForToken('the-code'), 'EAAB-business-token-long-enough');
    assert.equal(seen[0].url, 'https://graph.facebook.com/v22.0/oauth/access_token');
    assert.deepEqual(seen[0].options.params, { client_id: '111', client_secret: 'APP-SECRET-SENTINEL', code: 'the-code' });
    const empty = createMetaOnboardingApi(config, { get: async () => ({ data: {} }), post: async () => ({ data: {} }) });
    await assert.rejects(empty.exchangeCodeForToken('x'), (e: any) => e instanceof MetaOnboardingError && e.kind === 'MALFORMED');
  });

  test('errors are classified, and Meta\'s text is scrubbed of the secret, the code and the PIN', async () => {
    const leaky = { code: 100, message: 'bad APP-SECRET-SENTINEL with the-code and 654321', error_data: { details: 'APP-SECRET-SENTINEL' } };
    await assert.rejects(createMetaOnboardingApi(config, failing(400, leaky)).exchangeCodeForToken('the-code'), (e: any) => {
      assert.equal(e.kind, 'REJECTED');
      assert.equal(JSON.stringify([e.message, e.meta]).includes('APP-SECRET-SENTINEL'), false);
      assert.equal(JSON.stringify([e.message, e.meta]).includes('the-code'), false);
      return true;
    });
    await assert.rejects(createMetaOnboardingApi(config, failing(400, leaky)).registerPhoneNumber('tok-long-enough-xx', '123456', '654321'), (e: any) => JSON.stringify([e.message, e.meta]).includes('654321') === false);
    await assert.rejects(createMetaOnboardingApi(config, failing(401, { code: 190, message: 'expired' })).getPhoneNumber('t', '123456'), (e: any) => e.kind === 'AUTHENTICATION');
    await assert.rejects(createMetaOnboardingApi(config, failing(400, { code: 80008, message: 'limit' })).getPhoneNumber('t', '123456'), (e: any) => e.kind === 'RATE_LIMITED');
    await assert.rejects(createMetaOnboardingApi(config, failing(503, { code: 2, message: 'down' })).getPhoneNumber('t', '123456'), (e: any) => e.kind === 'UNAVAILABLE');
    const noAnswer: MetaHttp = { get: async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); }, post: async () => ({ data: {} }) };
    await assert.rejects(createMetaOnboardingApi(config, noAnswer).getPhoneNumber('t', '123456'), (e: any) => e.kind === 'UNAVAILABLE');
  });

  test('registration sends exactly the documented body; a number node for a different id is refused', async () => {
    const posts: any[] = [];
    const api = createMetaOnboardingApi(config, {
      get: async () => ({ data: { id: '999999', status: 'CONNECTED' } }),
      post: async (url, body) => { posts.push({ url, body }); return { data: { success: true } }; },
    });
    await api.registerPhoneNumber('token-long-enough-xx', '123456', '654321');
    assert.deepEqual(posts[0], { url: 'https://graph.facebook.com/v22.0/123456/register', body: { messaging_product: 'whatsapp', pin: '654321' } });
    await assert.rejects(api.getPhoneNumber('t', '123456'), (e: any) => e.kind === 'MALFORMED');
  });
});
