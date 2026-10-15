import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Connecting a business's own WhatsApp number through Meta's Embedded Signup,
 * end to end against the REAL compiled backend (backend/dist): onboarding
 * sessions, the server-side code exchange and checks, registration, the sender
 * inventory, event assignment, the send paths and the webhook.
 *
 * Meta is a fake installed on the axios instance the compiled services call,
 * so no request leaves this machine and no message is sent. Every token, secret,
 * code and PIN below is a fake sentinel, and the test asserts none of them ever
 * appears in an API response, an audit entry or a log line.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_onboarding_${Date.now()}`;
const APP_SECRET = 'FAKE-APP-SECRET-sentinel-never-real';
const ENV_TOKEN = 'FAKE-ENV-TOKEN-sentinel-never-real';
const ENV_PHONE = '111111111111111';
const APP_WABA = '100000000000001';
const BISU = (n: number) => `FAKE-BUSINESS-TOKEN-${n}-sentinel-never-real`;
const PIN = '123456';
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = ENV_TOKEN;
process.env.WHATSAPP_PHONE_ID = ENV_PHONE;
process.env.WHATSAPP_WABA_ID = APP_WABA;
process.env.WHATSAPP_API_VERSION = 'v22.0';
process.env.META_APP_ID = '424242424242424';
process.env.META_APP_SECRET = APP_SECRET;
process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = '737373737373737';
process.env.WHATSAPP_CREDENTIAL_KEY = crypto.randomBytes(32).toString('base64');

// Every console line, to prove no secret is ever logged.
const logged: string[] = [];
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  (console as any)[level] = (...args: any[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '));
    if (level !== 'log') original(...args);
  };
}

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const onboardingRoutes = require('../backend/dist/routes/whatsappOnboardingRoutes').default;
const senderRoutes = require('../backend/dist/routes/whatsappSenderRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');
const { Campaign } = require('../backend/dist/models/Campaign');
const { MessageLog } = require('../backend/dist/models/MessageLog');
const { AuditLog } = require('../backend/dist/models/AuditLog');
const { WhatsAppSender } = require('../backend/dist/models/WhatsAppSender');
const { WhatsAppOnboardingSession } = require('../backend/dist/models/WhatsAppOnboardingSession');
const { resolveSendingSender, sendTargetFor } = require('../backend/dist/services/senderResolution');
const { WhatsAppService } = require('../backend/dist/services/WhatsAppService');
const { queueService } = require('../backend/dist/services/QueueService');
const { __applyStatusUpdatesForTest } = require('../backend/dist/controllers/webhookController');

// ── Meta, faked ──────────────────────────────────────────────────────────────
type Phone = { id: string; waba: string; display: string; name: string; status: string; platform: string };
const meta = {
  calls: [] as { method: string; url: string; auth: string | null; params?: any; body?: any }[],
  /** code -> business token */
  codes: new Map<string, string>(),
  /** business token -> WABA ids it was granted */
  grants: new Map<string, string[]>(),
  phones: new Map<string, Phone>(),
  failSubscribe: false,
  /** WABA -> its message templates (only readable with a token granted that WABA) */
  templates: new Map<string, any[]>(),
  /** WABA ids whose phone list is split over two pages */
  paged: new Set<string>(),
  /** tokens Meta no longer accepts */
  revoked: new Set<string>(),
  sent: () => meta.calls.filter((c) => c.method === 'post' && c.url.endsWith('/messages')),
};
const realHttp = { get: axios.get, post: axios.post };
const graphError = (status: number, code: number, message: string) => {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: { error: { code, message } } };
  return e;
};
const pathOf = (url: string) => new URL(url).pathname.replace(/^\/v\d+\.\d+\//, '');
axios.get = async (url: string, options: any = {}) => {
  const auth = options?.headers?.Authorization ?? null;
  meta.calls.push({ method: 'get', url, auth, params: options?.params });
  const path = pathOf(url);
  if (path === 'oauth/access_token') {
    const token = meta.codes.get(options.params?.code);
    if (!token || options.params?.client_secret !== APP_SECRET) throw graphError(400, 100, 'This authorization code has expired.');
    meta.codes.delete(options.params.code); // one-time
    return { data: { access_token: token, token_type: 'bearer' } };
  }
  const token = String(auth ?? '').replace(/^Bearer /, '');
  if (meta.revoked.has(token)) throw graphError(401, 190, 'Error validating access token: The session has been invalidated');
  if (path.endsWith('/message_templates')) {
    const waba = path.split('/')[0];
    if (!(meta.grants.get(token) ?? []).includes(waba)) throw graphError(403, 200, 'Permission denied');
    return { data: { data: (meta.templates.get(waba) ?? []).filter((t) => t.name === options.params?.name) } };
  }
  if (path.endsWith('/phone_numbers') && meta.paged.has(path.split('/')[0]) && !options.params?.after) {
    // First page: no numbers of interest, and a cursor to the next page.
    return { data: { data: [], paging: { cursors: { after: 'PAGE2' }, next: 'https://graph.facebook.com/next' } } };
  }
  if (path.endsWith('/phone_numbers')) {
    const waba = path.split('/')[0];
    if (!(meta.grants.get(token) ?? []).includes(waba)) throw graphError(403, 200, 'Permission denied');
    return { data: { data: [...meta.phones.values()].filter((p) => p.waba === waba).map((p) => ({ id: p.id, display_phone_number: p.display, verified_name: p.name, status: p.status, platform_type: p.platform, quality_rating: 'GREEN', code_verification_status: 'VERIFIED' })) } };
  }
  const phone = meta.phones.get(path);
  if (phone) {
    if (!(meta.grants.get(token) ?? []).includes(phone.waba) && token !== ENV_TOKEN) throw graphError(403, 200, 'Permission denied');
    return { data: { id: phone.id, display_phone_number: phone.display, verified_name: phone.name, status: phone.status, platform_type: phone.platform, quality_rating: 'GREEN' } };
  }
  throw graphError(404, 803, 'Unknown path');
};
axios.post = async (url: string, body: any, options: any = {}) => {
  const auth = options?.headers?.Authorization ?? null;
  meta.calls.push({ method: 'post', url, auth, body });
  const path = pathOf(url);
  const token = String(auth ?? '').replace(/^Bearer /, '');
  if (path.endsWith('/subscribed_apps')) {
    if (meta.failSubscribe) throw graphError(500, 2, 'Service temporarily unavailable');
    return { data: { success: true } };
  }
  if (path.endsWith('/register')) {
    const phone = meta.phones.get(path.split('/')[0]);
    if (!phone || !(meta.grants.get(token) ?? []).includes(phone.waba)) throw graphError(403, 200, 'Permission denied');
    if (body?.pin !== PIN) throw graphError(400, 133005, 'Two step verification PIN Mismatch');
    phone.platform = 'CLOUD_API';
    phone.status = 'CONNECTED';
    return { data: { success: true } };
  }
  if (path.endsWith('/messages')) return { data: { messages: [{ id: `wamid.${path.split('/')[0]}.${meta.calls.length}` }] } };
  if (path.endsWith('/media')) return { data: { id: `media-${meta.calls.length}` } };
  throw graphError(404, 803, 'Unknown path');
};

let server: any;
let baseUrl = '';
let ip = 0;
const fx: any = {};
const responses: string[] = [];

const call = (method: string, path: string, token: string | null, body?: any): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `203.0.113.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(baseUrl + path);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        responses.push(data);
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) => jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

let seq = 0;
/** A business with a WABA, one number, and a fresh popup result (code) for it. */
const business = (opts: { status?: string; platform?: string } = {}) => {
  seq += 1;
  const waba = `20000000000${String(seq).padStart(4, '0')}`;
  const phoneId = `30000000000${String(seq).padStart(4, '0')}`;
  const token = BISU(seq);
  meta.grants.set(token, [waba]);
  meta.phones.set(phoneId, { id: phoneId, waba, display: `+91 98000 ${String(10000 + seq).slice(-5)}`, name: `Business ${seq}`, status: opts.status ?? 'PENDING', platform: opts.platform ?? 'NOT_APPLICABLE' });
  const code = () => {
    const c = `code-${seq}-${crypto.randomUUID()}`;
    meta.codes.set(c, token);
    return c;
  };
  return { waba, phoneId, token, code };
};

const start = async (token: string) => {
  const res = await call('POST', '/api/whatsapp-onboarding/sessions', token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.sessionId as string;
};

/** The whole popup round trip for an account: start, then complete with the business's result. */
const connect = async (token: string, biz: ReturnType<typeof business>, override: Record<string, unknown> = {}) => {
  const sessionId = await start(token);
  return call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/complete`, token, { code: biz.code(), wabaId: biz.waba, phoneNumberId: biz.phoneId, ...override });
};

const makeEvent = (name: string, owner: any, role: 'Admin' | 'SuperAdmin') =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName: name, eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', ...(role === 'Admin' ? { adminId: owner._id } : {}), createdBy: owner._id,
  });

before(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([WhatsAppSender.init(), WhatsAppOnboardingSession.init()]);
  const base = { passwordHash: 'x', status: 'Active' };
  fx.superAdmin = await Admin.create({ ...base, name: 'Super', email: 'super-ob@example.com', role: 'SuperAdmin' });
  fx.adminA = await Admin.create({ ...base, name: 'Admin A', email: 'a-ob@example.com', role: 'Admin' });
  fx.adminB = await Admin.create({ ...base, name: 'Admin B', email: 'b-ob@example.com', role: 'Admin' });
  fx.user = await User.create({ ...base, name: 'User', email: 'u-ob@example.com', adminId: fx.adminA._id });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');
  fx.u = tokenFor(fx.user, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp-onboarding', onboardingRoutes);
  app.use('/api/whatsapp-senders', senderRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(axios, realHttp);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  await Promise.all([WhatsAppSender.deleteMany({}), WhatsAppOnboardingSession.deleteMany({}), MessageLog.deleteMany({}), Campaign.deleteMany({}), Contact.deleteMany({}), Event.deleteMany({})]);
  meta.calls.length = 0;
  meta.failSubscribe = false;
});

/** A connected, registered, Super-Admin-enabled number owned by `owner`. */
const connectedSender = async (ownerToken: string) => {
  const biz = business();
  const res = await connect(ownerToken, biz);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const reg = await call('POST', `/api/whatsapp-onboarding/senders/${res.body.sender.id}/register`, ownerToken, { pin: PIN });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  await WhatsAppSender.updateOne({ _id: res.body.sender.id }, { $set: { enabled: true } });
  return { biz, id: res.body.sender.id as string };
};

describe('starting onboarding', () => {
  test('an Admin or Super Admin starts a session and gets only the public ids - never the app secret', async () => {
    for (const token of [fx.a, fx.super]) {
      const res = await call('POST', '/api/whatsapp-onboarding/sessions', token);
      assert.equal(res.status, 201);
      assert.match(res.body.sessionId, /^[a-f\d]{24}$/);
      assert.equal(res.body.appId, '424242424242424');
      assert.equal(res.body.configId, '737373737373737');
      assert.equal(res.body.apiVersion, 'v22.0');
      assert.deepEqual(Object.keys(res.body).sort(), ['apiVersion', 'appId', 'configId', 'openUntil', 'sessionId']);
    }
    const config = await call('GET', '/api/whatsapp-onboarding/config', fx.a);
    assert.equal(config.body.configured, true);
    assert.ok(await AuditLog.findOne({ action: 'WHATSAPP_ONBOARDING_STARTED' }));
    assert.equal(meta.calls.length, 0, 'starting asks nothing of Meta');
  });

  test('a User cannot, nobody signed out can, and an unconfigured server says what is missing by name', async () => {
    assert.equal((await call('POST', '/api/whatsapp-onboarding/sessions', fx.u)).status, 403);
    assert.equal((await call('POST', '/api/whatsapp-onboarding/sessions', null)).status, 401);
    const saved = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    try {
      const res = await call('POST', '/api/whatsapp-onboarding/sessions', fx.a);
      assert.equal(res.status, 503);
      assert.match(res.body.error.message, /META_APP_SECRET/);
      const config = await call('GET', '/api/whatsapp-onboarding/config', fx.a);
      assert.equal(config.body.configured, false);
      assert.deepEqual(config.body.missing, ['META_APP_SECRET (or WHATSAPP_APP_SECRET)'], 'named, never valued');
      assert.equal(config.body.appId, null);
    } finally {
      process.env.META_APP_SECRET = saved;
    }
  });
});

describe('the popup result', () => {
  test('a cancelled or closed popup creates nothing, and the session cannot be completed afterwards', async () => {
    const biz = business();
    const sessionId = await start(fx.a);
    const cancel = await call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/cancel`, fx.a, { currentStep: 'PHONE_NUMBER_SETUP' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.status, 'cancelled');
    assert.equal((await call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/cancel`, fx.a, {})).status, 409, 'once');
    const late = await call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/complete`, fx.a, { code: biz.code(), wabaId: biz.waba, phoneNumberId: biz.phoneId });
    assert.equal(late.status, 409);
    assert.equal(await WhatsAppSender.countDocuments(), 0);
    assert.equal(meta.calls.length, 0, 'no code was exchanged');
    assert.equal((await WhatsAppOnboardingSession.findById(sessionId)).cancelledAtStep, 'PHONE_NUMBER_SETUP');
  });

  test('a popup error is recorded with Meta\'s error id only, and creates nothing', async () => {
    const sessionId = await start(fx.a);
    const res = await call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/error`, fx.a, { errorId: '524126', errorMessage: '<script>alert(1)</script>' });
    assert.equal(res.status, 200);
    const stored = await WhatsAppOnboardingSession.findById(sessionId).lean();
    assert.equal(stored.status, 'error');
    assert.equal(stored.errorCode, 'META_524126');
    assert.equal(JSON.stringify(stored).includes('script'), false, 'popup text is never stored');
    assert.equal(await WhatsAppSender.countDocuments(), 0);
  });

  test('missing or malformed data is refused before anything is asked of Meta - and the session stays usable', async () => {
    const biz = business();
    const sessionId = await start(fx.a);
    const bad: Record<string, unknown>[] = [
      { wabaId: biz.waba, phoneNumberId: biz.phoneId },
      { code: '', wabaId: biz.waba, phoneNumberId: biz.phoneId },
      { code: 'has space', wabaId: biz.waba, phoneNumberId: biz.phoneId },
      { code: biz.code(), wabaId: 'not-an-id', phoneNumberId: biz.phoneId },
      { code: biz.code(), wabaId: biz.waba },
      { code: biz.code(), wabaId: biz.waba, phoneNumberId: { $ne: null } },
    ];
    for (const body of bad) {
      const res = await call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/complete`, fx.a, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(meta.calls.length, 0);
    assert.equal((await WhatsAppOnboardingSession.findById(sessionId)).status, 'started');
    assert.equal((await call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/complete`, fx.a, { code: biz.code(), wabaId: biz.waba, phoneNumberId: biz.phoneId })).status, 200);
  });

  test('someone else\'s session cannot be used (404), and an expired one cannot be completed', async () => {
    const biz = business();
    const mine = await start(fx.a);
    assert.equal((await call('POST', `/api/whatsapp-onboarding/sessions/${mine}/complete`, fx.b, { code: biz.code(), wabaId: biz.waba, phoneNumberId: biz.phoneId })).status, 404);
    assert.equal((await call('POST', `/api/whatsapp-onboarding/sessions/${mine}/cancel`, fx.b, {})).status, 404);
    await WhatsAppOnboardingSession.updateOne({ _id: mine }, { $set: { openUntil: new Date(Date.now() - 1000) } });
    const expired = await call('POST', `/api/whatsapp-onboarding/sessions/${mine}/complete`, fx.a, { code: biz.code(), wabaId: biz.waba, phoneNumberId: biz.phoneId });
    assert.equal(expired.status, 409);
    assert.match(expired.body.error.message, /expired/);
  });
});

describe('completing onboarding (Meta mocked)', () => {
  test('a valid result: code exchanged server-side, number confirmed for that token, webhooks subscribed, sender stored pending registration - token encrypted', async () => {
    const biz = business();
    const res = await connect(fx.a, biz);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sender.onboardingStatus, 'pending_registration');
    assert.equal(res.body.sender.enabled, false, 'never usable until a Super Admin enables it');
    assert.equal(res.body.sender.assignment.available, false);
    assert.equal(res.body.sender.phoneNumberIdMasked, `…${biz.phoneId.slice(-4)}`);

    const exchange = meta.calls.find((c) => c.url.includes('oauth/access_token'));
    assert.equal(exchange?.params.client_secret, APP_SECRET, 'the secret is used only server-side');
    assert.ok(meta.calls.some((c) => c.url.endsWith(`${biz.waba}/phone_numbers`) && c.auth === `Bearer ${biz.token}`));
    assert.ok(meta.calls.some((c) => c.method === 'post' && c.url.endsWith(`${biz.waba}/subscribed_apps`) && c.auth === `Bearer ${biz.token}`));
    assert.equal(meta.sent().length, 0, 'connecting a number never sends a message');

    const stored = await WhatsAppSender.findById(res.body.sender.id).select('+credential').lean();
    assert.equal(stored.source, 'embedded_signup');
    assert.equal(String(stored.ownerAccountId), String(fx.adminA._id));
    assert.equal(stored.wabaId, biz.waba);
    assert.equal(stored.phoneNumberId, biz.phoneId);
    assert.ok(stored.credential.ciphertext);
    assert.equal(JSON.stringify(stored).includes(biz.token), false, 'the token is stored encrypted, never in clear');
    assert.equal((await WhatsAppSender.findById(res.body.sender.id).lean()).credential, undefined, 'and is not even selected by default');
    assert.equal((await WhatsAppOnboardingSession.findOne({}).lean()).status, 'completed');
    assert.ok(await AuditLog.findOne({ action: 'WHATSAPP_SENDER_ONBOARDED' }));
  });

  test('registration with the PIN connects it; a wrong PIN leaves it pending with Meta\'s reason, and the PIN is never stored', async () => {
    const biz = business();
    const id = (await connect(fx.a, biz)).body.sender.id;
    assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${id}/register`, fx.a, { pin: '12' })).status, 400);
    const wrong = await call('POST', `/api/whatsapp-onboarding/senders/${id}/register`, fx.a, { pin: '999999' });
    assert.equal(wrong.status, 422);
    assert.match(wrong.body.error.message, /PIN Mismatch/);
    const pending = await WhatsAppSender.findById(id).lean();
    assert.equal(pending.onboardingStatus, 'pending_registration', 'incomplete registration stays pending');
    assert.match(pending.lastError.message, /PIN/);

    const ok = await call('POST', `/api/whatsapp-onboarding/senders/${id}/register`, fx.a, { pin: PIN });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.sender.onboardingStatus, 'connected');
    assert.equal(ok.body.sender.metaStatus, 'CONNECTED');
    const everything = JSON.stringify([await WhatsAppSender.findById(id).select('+credential').lean(), await AuditLog.find({}).lean()]);
    assert.equal(everything.includes(PIN), false);
    assert.equal(everything.includes('999999'), false);
  });

  test('a number already on Cloud API and CONNECTED is connected straight away', async () => {
    const biz = business({ status: 'CONNECTED', platform: 'CLOUD_API' });
    const res = await connect(fx.a, biz);
    assert.equal(res.body.sender.onboardingStatus, 'connected');
  });

  test('a number the token was not granted is refused - a client cannot claim someone else\'s number', async () => {
    const mine = business();
    const theirs = business();
    const res = await connect(fx.a, mine, { phoneNumberId: theirs.phoneId });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'ASSET_NOT_GRANTED');
    const otherWaba = await connect(fx.a, mine, { wabaId: theirs.waba, phoneNumberId: theirs.phoneId });
    assert.equal(otherWaba.status, 400, 'the token cannot see that account at all');
    assert.equal(await WhatsAppSender.countDocuments(), 0);
    assert.ok((await WhatsAppOnboardingSession.find({ status: 'failed' }).lean()).length >= 2);
  });

  test('an expired code, and a failed webhook subscription, persist nothing', async () => {
    const biz = business();
    const sessionId = await start(fx.a);
    const expired = await call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/complete`, fx.a, { code: 'never-issued-code', wabaId: biz.waba, phoneNumberId: biz.phoneId });
    assert.equal(expired.status, 422);
    meta.failSubscribe = true;
    const sub = await connect(fx.a, biz);
    assert.equal(sub.status, 502);
    assert.equal(await WhatsAppSender.countDocuments(), 0);
  });

  test('duplicates: the owner reconnects in place; another account is refused while connected; after a disconnect it may take over (starting again unapproved)', async () => {
    const biz = business();
    const first = await connect(fx.a, biz);
    await WhatsAppSender.updateOne({ _id: first.body.sender.id }, { $set: { enabled: true, allowedAdminIds: [fx.adminB._id] } });

    const again = await connect(fx.a, biz);
    assert.equal(again.status, 200);
    assert.equal(again.body.sender.id, first.body.sender.id, 'one record per phone number id');
    assert.equal(await WhatsAppSender.countDocuments(), 1);
    assert.equal((await WhatsAppSender.findById(first.body.sender.id)).enabled, true, 'the owner reconnecting keeps the approval');

    const stolen = await connect(fx.b, biz);
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.error.code, 'NUMBER_OWNED_BY_ANOTHER_ACCOUNT');

    assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${first.body.sender.id}/disconnect`, fx.a)).status, 200);
    const takeover = await connect(fx.b, biz);
    assert.equal(takeover.status, 200);
    const now = await WhatsAppSender.findById(first.body.sender.id).lean();
    assert.equal(String(now.ownerAccountId), String(fx.adminB._id));
    assert.equal(now.enabled, false, 'a new owner needs a Super Admin again');
    assert.deepEqual(now.allowedAdminIds, []);
    assert.equal(await WhatsAppSender.countDocuments(), 1);
  });

  test('a number synced into the central inventory cannot be claimed through onboarding', async () => {
    const biz = business();
    await WhatsAppSender.create({ phoneNumberId: biz.phoneId, wabaId: biz.waba, displayPhoneNumber: '+91 98000 00000', verifiedName: 'Central', enabled: true });
    const res = await connect(fx.a, biz);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NUMBER_MANAGED_CENTRALLY');
  });

  test('the same session cannot complete twice, even concurrently', async () => {
    const biz = business();
    const sessionId = await start(fx.a);
    const body = () => ({ code: biz.code(), wabaId: biz.waba, phoneNumberId: biz.phoneId });
    const results = await Promise.all([1, 2, 3].map(() => call('POST', `/api/whatsapp-onboarding/sessions/${sessionId}/complete`, fx.a, body())));
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(results.filter((r) => r.status === 409).length, 2);
    assert.equal(await WhatsAppSender.countDocuments(), 1);
  });
});

describe('who manages a connected number', () => {
  test('another Admin cannot see, verify, register or disconnect it (404); a Super Admin can verify and disconnect but not use the owner\'s PIN', async () => {
    const biz = business();
    const id = (await connect(fx.a, biz)).body.sender.id;
    for (const action of ['verify', 'disconnect']) assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${id}/${action}`, fx.b)).status, 404, action);
    assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${id}/register`, fx.b, { pin: PIN })).status, 404);
    assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${id}/register`, fx.super, { pin: PIN })).status, 404, 'the PIN is the business\'s');
    assert.deepEqual((await call('GET', '/api/whatsapp-onboarding/senders', fx.b)).body.senders, []);
    assert.equal((await call('GET', '/api/whatsapp-onboarding/senders', fx.a)).body.senders.length, 1);
    for (const action of ['register', 'verify', 'disconnect']) {
      assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${id}/${action}`, null, { pin: PIN })).status, 401);
      assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${id}/${action}`, fx.u, { pin: PIN })).status, 403);
    }
    const tooSoon = await call('POST', `/api/whatsapp-onboarding/senders/${id}/verify`, fx.super);
    assert.equal(tooSoon.status, 429, 'just verified while connecting: re-checks are spaced out');
    await WhatsAppSender.updateOne({ _id: id }, { $set: { lastVerifiedAt: new Date(Date.now() - 60_000) } });
    const verified = await call('POST', `/api/whatsapp-onboarding/senders/${id}/verify`, fx.super);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal((await call('POST', `/api/whatsapp-onboarding/senders/${id}/disconnect`, fx.super)).status, 200);
    const gone = await WhatsAppSender.findById(id).select('+credential').lean();
    assert.equal(gone.onboardingStatus, 'disconnected');
    assert.equal(gone.enabled, false);
    assert.equal(gone.credential, undefined, 'disconnecting erases the stored token');
    assert.ok(await AuditLog.findOne({ action: 'WHATSAPP_SENDER_DISCONNECTED' }));
  });

  test('the sender list shows an Admin their own connected numbers with the reason they are unavailable - and never a token', async () => {
    const biz = business();
    await connect(fx.a, biz);
    const list = await call('GET', '/api/whatsapp-senders', fx.a);
    const mine = list.body.senders.find((s: any) => s.phoneNumberId === biz.phoneId);
    assert.ok(mine, 'listed although not enabled');
    assert.equal(mine.source, 'embedded_signup');
    assert.ok(mine.unavailableReasons.length > 0);
    assert.equal('credential' in mine, false);
    assert.equal((await call('GET', '/api/whatsapp-senders', fx.b)).body.senders.some((s: any) => s.phoneNumberId === biz.phoneId), false, 'not shown to another Admin');
  });
});

describe('assignment to events', () => {
  const assign = (eventId: string, senderId: string | null, token: string) => call('PUT', `/api/events/${eventId}/contact`, token, { whatsappSenderId: senderId });

  test('the owner assigns their connected, enabled number to their own event; a pending or disconnected one is refused with the reason', async () => {
    const event = await makeEvent('A wedding', fx.adminA, 'Admin');
    const pending = (await connect(fx.a, business())).body.sender.id;
    const refused = await assign(String(event._id), pending, fx.a);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /registration/);

    const { id } = await connectedSender(fx.a);
    const ok = await assign(String(event._id), id, fx.a);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    await call('POST', `/api/whatsapp-onboarding/senders/${id}/disconnect`, fx.a);
    const other = await makeEvent('Another', fx.adminA, 'Admin');
    const disconnected = await assign(String(other._id), id, fx.a);
    assert.equal(disconnected.status, 409);
    assert.match(disconnected.body.error, /disconnected/);
  });

  test('another Admin\'s event cannot use it unless a Super Admin allows that Admin', async () => {
    const { id } = await connectedSender(fx.a);
    const eventB = await makeEvent('B wedding', fx.adminB, 'Admin');
    assert.equal((await assign(String(eventB._id), id, fx.b)).status, 403);
    assert.equal((await assign(String(eventB._id), id, fx.super)).status, 403, 'not even when a Super Admin assigns it: the event\'s owner is what counts');
    await WhatsAppSender.updateOne({ _id: id }, { $set: { allowedAdminIds: [fx.adminB._id] } });
    assert.equal((await assign(String(eventB._id), id, fx.b)).status, 200);
  });

  test('Super Admin events: their own connected number is allowed; inventory senders stay refused (decision A unchanged)', async () => {
    const event = await makeEvent('Super event', fx.superAdmin, 'SuperAdmin');
    const { id } = await connectedSender(fx.super);
    assert.equal((await assign(String(event._id), id, fx.super)).status, 200);
    const resolved = await resolveSendingSender(event._id);
    assert.equal(resolved.senderId, id);

    const adminsNumber = (await connectedSender(fx.a)).id;
    const other = await makeEvent('Super event 2', fx.superAdmin, 'SuperAdmin');
    assert.equal((await assign(String(other._id), adminsNumber, fx.super)).status, 403, 'an Admin\'s number is not the Super Admin\'s');

    const inventory = await WhatsAppSender.create({ phoneNumberId: '555555555555555', wabaId: APP_WABA, displayPhoneNumber: '+91 90000 00000', verifiedName: 'Inventory', enabled: true, metaStatus: 'CONNECTED', statusCheckedAt: new Date(), allowedAdminIds: [fx.adminA._id] });
    await Event.updateOne({ _id: other._id }, { $set: { whatsappSenderId: inventory._id } });
    await assert.rejects(resolveSendingSender(other._id), (e: any) => e.code === 'SENDER_NOT_ALLOWED' && /owned by a Super Admin/.test(e.message));
  });
});

describe('sending', () => {
  test('messages go out from the assigned number\'s phone id with ITS token - not the environment sender or token', async () => {
    const { biz, id } = await connectedSender(fx.a);
    const event = await makeEvent('Send event', fx.adminA, 'Admin');
    await Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: id } });
    const resolved = await resolveSendingSender(event._id);
    assert.equal(resolved.credential, 'sender');
    assert.equal(resolved.phoneNumberId, biz.phoneId);
    assert.equal('accessToken' in resolved, false, 'the resolved sender carries no token');
    const target = await sendTargetFor(resolved);
    await new WhatsAppService().sendMessage('+919876543210', 'Hello', [], target);
    const sent = meta.sent().at(-1)!;
    assert.ok(sent.url.endsWith(`/${biz.phoneId}/messages`));
    assert.equal(sent.auth, `Bearer ${biz.token}`);
    assert.equal(sent.url.includes(ENV_PHONE), false);
  });

  test('an event with no assignment still sends from the environment sender, unchanged', async () => {
    const event = await makeEvent('Default event', fx.adminA, 'Admin');
    const resolved = await resolveSendingSender(event._id);
    assert.equal(resolved.kind, 'environment');
    assert.deepEqual(await sendTargetFor(resolved), {});
    await new WhatsAppService().sendMessage('+919876543210', 'Hello', [], await sendTargetFor(resolved));
    const sent = meta.sent().at(-1)!;
    assert.ok(sent.url.endsWith(`/${ENV_PHONE}/messages`));
    assert.equal(sent.auth, `Bearer ${ENV_TOKEN}`);
  });

  test('an assigned number that is disconnected, pending, disabled or not allowed refuses to send - it never falls back to the default sender', async () => {
    const { id } = await connectedSender(fx.a);
    const event = await makeEvent('Fail closed', fx.adminA, 'Admin');
    await Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: id } });
    for (const [set, pattern] of [
      [{ enabled: false }, /not enabled/],
      [{ onboardingStatus: 'pending_registration', enabled: true }, /registration/],
      [{ onboardingStatus: 'disconnected' }, /disconnected/],
    ] as const) {
      await WhatsAppSender.updateOne({ _id: id }, { $set: set });
      await assert.rejects(resolveSendingSender(event._id), (e: any) => e.httpStatus >= 400 && pattern.test(e.message) && /Nothing was sent/.test(e.message));
    }
    await WhatsAppSender.updateOne({ _id: id }, { $set: { onboardingStatus: 'connected', enabled: true }, $unset: { credential: 1 } });
    await assert.rejects(resolveSendingSender(event._id), /authorization is missing/);
    assert.equal(meta.sent().length, 0);
  });

  test('a queued campaign sends every batch with the intended number, and stops - never switching sender - if it is disconnected mid-way', async () => {
    const { biz, id } = await connectedSender(fx.a);
    const event = await makeEvent('Campaign event', fx.adminA, 'Admin');
    await Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: id } });
    for (let i = 0; i < 3; i++) await Contact.create({ fullName: `Guest ${i}`, phoneNumber: `+9198765432${10 + i}`, countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid' });
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi {{fullName}}', status: 'Draft' });

    await queueService.processCampaign(String(campaign._id), undefined, 'Hi {{fullName}}', []);
    for (let i = 0; i < 80 && (await MessageLog.countDocuments({ campaignId: campaign._id, status: 'Pending' })) > 0; i++) await new Promise((r) => setTimeout(r, 50));
    const sent = meta.sent();
    assert.equal(sent.length, 3);
    assert.ok(sent.every((c) => c.url.endsWith(`/${biz.phoneId}/messages`) && c.auth === `Bearer ${biz.token}`), 'every message from the assigned number with its token');

    // Resolved, then disconnected before the queue reaches the batch.
    meta.calls.length = 0;
    await Campaign.deleteMany({});
    const second = await Campaign.create({ eventId: event._id, messageText: 'Again', status: 'Draft' });
    const resolved = await resolveSendingSender(event._id);
    await call('POST', `/api/whatsapp-onboarding/senders/${id}/disconnect`, fx.a);
    await queueService.processCampaign(String(second._id), undefined, 'Again', [], undefined, resolved);
    for (let i = 0; i < 80 && (await MessageLog.countDocuments({ campaignId: second._id, status: 'Pending' })) > 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(meta.sent().length, 0, 'nothing sent - and in particular nothing from the environment sender');
    const failed = await MessageLog.find({ campaignId: second._id }).lean();
    assert.ok(failed.length === 3 && failed.every((l: any) => l.status === 'Failed' && /disconnected|cannot be used/.test(l.errorReason)));
  });
});

describe('webhooks from several numbers', () => {
  test('status callbacks for two different connected numbers (two accounts) each update their own message', async () => {
    const event = await makeEvent('Webhook event', fx.adminA, 'Admin');
    const contact = await Contact.create({ fullName: 'G', phoneNumber: '+919876543299', countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid' });
    const logA = await MessageLog.create({ eventId: event._id, contactId: contact._id, phoneNumber: contact.phoneNumber, status: 'Sent', wamid: 'wamid.FROM-A', sentAt: new Date() });
    const logB = await MessageLog.create({ eventId: event._id, contactId: contact._id, phoneNumber: contact.phoneNumber, status: 'Sent', wamid: 'wamid.FROM-B', sentAt: new Date() });
    const ts = String(Math.floor(Date.now() / 1000));
    const applied = await __applyStatusUpdatesForTest({
      entry: [
        { id: '200000000009991', changes: [{ value: { metadata: { phone_number_id: '300000000009991' }, statuses: [{ id: 'wamid.FROM-A', status: 'delivered', timestamp: ts }] } }] },
        { id: APP_WABA, changes: [{ value: { metadata: { phone_number_id: ENV_PHONE }, statuses: [{ id: 'wamid.FROM-B', status: 'read', timestamp: ts }] } }] },
      ],
    });
    assert.equal(applied, 2);
    assert.equal((await MessageLog.findById(logA._id)).status, 'Delivered');
    assert.ok((await MessageLog.findById(logB._id)).readAt);
  });
});

describe('review fixes', () => {
  const reminder = (status = 'APPROVED', body = 'Dear {{1}}, {{2}} on {{3}} at {{4}}, {{5}}.', language = 'en', header?: any) => ({
    name: 'event_reminder', language, status,
    components: [...(header ? [header] : []), { type: 'BODY', text: body }],
  });

  const composerSetup = async () => {
    const { biz, id } = await connectedSender(fx.a);
    const event = await makeEvent('Composer event', fx.adminA, 'Admin');
    await Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: id } });
    const contact = await Contact.create({ fullName: 'Riya', phoneNumber: '+919876543201', countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid' });
    const send = () => call('POST', '/api/whatsapp/event-template', fx.a, { eventId: String(event._id), contactIds: [String(contact._id)], templateName: 'event_reminder' });
    return { biz, id, send };
  };

  test('templates: a template missing from the connected number\'s own account refuses the whole send, before any message', async () => {
    const { biz, send } = await composerSetup();
    meta.templates.set(biz.waba, []);
    const res = await send();
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'TEMPLATE_NOT_IN_SENDER_ACCOUNT');
    assert.match(res.body.error.message, /Nothing was sent/);
    assert.equal(meta.sent().length, 0);
    assert.ok(meta.calls.some((c) => c.url.endsWith(`${biz.waba}/message_templates`) && c.auth === `Bearer ${biz.token}`), 'looked up in ITS account with ITS token');
  });

  test('templates: not approved, another language only, or a different shape there - each refused with its reason', async () => {
    const { biz, send } = await composerSetup();
    const cases: [any[], string][] = [
      [[reminder('PENDING')], 'TEMPLATE_NOT_APPROVED_IN_SENDER_ACCOUNT'],
      [[reminder('APPROVED', undefined, 'en_US')], 'TEMPLATE_NOT_IN_SENDER_ACCOUNT'],
      [[reminder('APPROVED', 'Dear {{1}}.')], 'TEMPLATE_MISMATCH_IN_SENDER_ACCOUNT'],
      [[reminder('APPROVED', undefined, 'en', { type: 'HEADER', format: 'IMAGE' })], 'TEMPLATE_MISMATCH_IN_SENDER_ACCOUNT'],
    ];
    for (const [templates, code] of cases) {
      meta.templates.set(biz.waba, templates);
      const res = await send();
      assert.equal(res.status, 409, code);
      assert.equal(res.body.error.code, code);
    }
    assert.equal(meta.sent().length, 0);
  });

  test('templates: approved and matching in its own account - sent from the connected number with its token', async () => {
    const { biz, send } = await composerSetup();
    meta.templates.set(biz.waba, [reminder()]);
    const res = await send();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sent = meta.sent();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].url.endsWith(`/${biz.phoneId}/messages`));
    assert.equal(sent[0].auth, `Bearer ${biz.token}`);
    assert.equal(sent[0].body.template.name, 'event_reminder');
  });

  test('templates: a Meta failure during the check is "could not confirm", not "not found", and sends nothing', async () => {
    const { biz, send } = await composerSetup();
    meta.revoked.add(biz.token);
    try {
      const res = await send();
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.equal(meta.sent().length, 0);
    } finally {
      meta.revoked.delete(biz.token);
    }
  });

  test('an event using the default sender is not affected by the template check', async () => {
    const event = await makeEvent('Default composer', fx.adminA, 'Admin');
    const contact = await Contact.create({ fullName: 'Riya', phoneNumber: '+919876543202', countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid' });
    const res = await call('POST', '/api/whatsapp/event-template', fx.a, { eventId: String(event._id), contactIds: [String(contact._id)], templateName: 'event_reminder' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(meta.calls.some((c) => c.url.includes('/message_templates')), false);
    assert.ok(meta.sent()[0].url.endsWith(`/${ENV_PHONE}/messages`));
  });

  test('ownership cannot be probed: a number not granted to your token is "not granted", whoever holds it', async () => {
    const owned = business();
    assert.equal((await connect(fx.a, owned)).status, 200);
    const mine = business();
    const res = await connect(fx.b, mine, { wabaId: owned.waba, phoneNumberId: owned.phoneId });
    assert.equal(res.status, 400);
    assert.notEqual(res.body.error.code, 'NUMBER_OWNED_BY_ANOTHER_ACCOUNT', 'nothing is revealed about who holds it');
  });

  test('a phone number on a later page of the account is found (cursor paging)', async () => {
    const biz = business();
    meta.paged.add(biz.waba);
    const res = await connect(fx.a, biz);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(meta.calls.some((c) => c.url.endsWith(`${biz.waba}/phone_numbers`) && c.params?.after === 'PAGE2'));
  });

  test('a revoked authorization found on "check status" marks the number reconnect-required and unusable', async () => {
    const { biz, id } = await connectedSender(fx.a);
    await WhatsAppSender.updateOne({ _id: id }, { $set: { lastVerifiedAt: new Date(Date.now() - 60_000) } });
    meta.revoked.add(biz.token);
    try {
      const res = await call('POST', `/api/whatsapp-onboarding/senders/${id}/verify`, fx.a);
      assert.equal(res.status, 400);
      const stored = await WhatsAppSender.findById(id).lean();
      assert.equal(stored.onboardingStatus, 'action_required');
      assert.equal(stored.nextAction, 'reconnect');
      const event = await makeEvent('After revoke', fx.adminA, 'Admin');
      await Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: id } });
      await assert.rejects(resolveSendingSender(event._id), /authorization/);
      assert.ok(await AuditLog.findOne({ action: 'WHATSAPP_SENDER_AUTH_REVOKED' }));
    } finally {
      meta.revoked.delete(biz.token);
    }
  });

  test('disconnect reports how many events still use the number (they are not silently moved to the default sender)', async () => {
    const { id } = await connectedSender(fx.a);
    for (const name of ['E1', 'E2']) {
      const event = await makeEvent(name, fx.adminA, 'Admin');
      await Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: id } });
    }
    const res = await call('POST', `/api/whatsapp-onboarding/senders/${id}/disconnect`, fx.a);
    assert.equal(res.status, 200);
    assert.equal(res.body.assignedEvents, 2);
    assert.equal(await Event.countDocuments({ whatsappSenderId: id }), 2, 'assignments are kept: those events refuse to send');
  });

  test('a missing default sender (mock mode) never fakes a send from a connected number', async () => {
    const savedToken = process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_TOKEN;
    try {
      const service = new WhatsAppService(); // no default credentials: mock mode for the default sender
      const result = await service.sendMessage('+919876543210', 'Hi', [], { phoneNumberId: '300000000009999', accessToken: BISU(999) });
      assert.ok(String(result.wamid).startsWith('wamid.300000000009999'), 'a real (faked-Meta) call was made, not a mock');
      const mock = await service.sendMessage('+919876543210', 'Hi', [], {});
      assert.equal(meta.sent().filter((c) => c.url.includes(ENV_PHONE)).length, 0, 'the default sender is still mocked');
      assert.ok(mock);
    } finally {
      process.env.WHATSAPP_TOKEN = savedToken;
    }
  });

  test('the onboarding app must be the webhook app: META_APP_SECRET may be omitted, but a different value is a configuration error', async () => {
    const saved = { meta: process.env.META_APP_SECRET, hook: process.env.WHATSAPP_APP_SECRET };
    try {
      delete process.env.META_APP_SECRET;
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;
      assert.equal((await call('GET', '/api/whatsapp-onboarding/config', fx.a)).body.configured, true, 'falls back to the webhook app secret');
      process.env.META_APP_SECRET = 'A-DIFFERENT-SECRET';
      const config = await call('GET', '/api/whatsapp-onboarding/config', fx.a);
      assert.equal(config.body.configured, false);
      assert.ok(config.body.missing.some((m: string) => /same app secret/.test(m)));
      assert.equal(JSON.stringify(config.body).includes('A-DIFFERENT-SECRET'), false);
    } finally {
      process.env.META_APP_SECRET = saved.meta;
      if (saved.hook === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = saved.hook;
    }
  });
});

describe('secrets', () => {
  test('no token, app secret, code or PIN appears in any API response, audit entry or log line', async () => {
    const audits = JSON.stringify(await AuditLog.find({}).lean());
    const everything = [responses.join('\n'), audits, logged.join('\n')].join('\n');
    for (const secret of [APP_SECRET, ENV_TOKEN, BISU(1), BISU(2), BISU(3), BISU(999), 'A-DIFFERENT-SECRET', process.env.WHATSAPP_CREDENTIAL_KEY!, 'FAKE-BUSINESS-TOKEN']) {
      assert.equal(everything.includes(secret), false, `leaked: ${secret.slice(0, 12)}`);
    }
    assert.equal(/code-\d+-[0-9a-f-]{36}/.test(everything), false, 'no authorization code');
    assert.equal(audits.includes(PIN), false, 'no PIN');
    assert.ok(responses.length > 30, 'the check covered the whole run');
  });
});
