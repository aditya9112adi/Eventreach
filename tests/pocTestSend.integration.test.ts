import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * /api/whatsapp/poc-test over real HTTP, against the REAL compiled backend
 * (backend/dist) on a throwaway database.
 *
 * Meta is faked at the axios instance the compiled services call, so no
 * request can leave this process; every call is recorded. The token, phone
 * numbers and ids are fake.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_poctest_${Date.now()}`;
const FAKE_TOKEN = 'EAAG-FAKE-SENTINEL-TOKEN-never-real-7f3a9c';
const WABA = '102290129340398';
const OTHER_WABA = '999000111222333';
const ENV_PHONE_ID = '1407379562449786';
const POC_PHONE_ID = '555000111222333444';
const OTHER_PHONE_ID = '777000111222333444';
const RECIPIENT = '+919876543210';
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = FAKE_TOKEN;
process.env.WHATSAPP_WABA_ID = WABA;
process.env.WHATSAPP_PHONE_ID = ENV_PHONE_ID;
process.env.WHATSAPP_API_VERSION = 'v22.0';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const whatsappSenderRoutes = require('../backend/dist/routes/whatsappSenderRoutes').default;
const { __applyStatusUpdatesForTest } = require('../backend/dist/controllers/webhookController');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { WhatsAppTemplate } = require('../backend/dist/models/WhatsAppTemplate');
const { WhatsAppSender } = require('../backend/dist/models/WhatsAppSender');
const { PocTestRecipient } = require('../backend/dist/models/PocTestRecipient');
const { TemplateTestSend } = require('../backend/dist/models/TemplateTestSend');
const { AuditLog } = require('../backend/dist/models/AuditLog');
const { AuditService } = require('../backend/dist/services/AuditService');
const poc = require('../backend/dist/services/pocTestSendService');

// ── Meta, faked ──────────────────────────────────────────────────────────────
const distAxios = createRequire(require.resolve('../backend/dist/services/whatsappTemplateService'))('axios');
const realHttp = { post: distAxios.post, get: distAxios.get, request: distAxios.request };
const meta = {
  calls: [] as { method: string; url: string; body?: any; headers?: any }[],
  post: (_body: any): any => ({ data: { messages: [{ id: 'wamid.TESTONE' }], contacts: [{ wa_id: '919876543210' }] } }),
  status: 'CONNECTED' as string | null,
  get sends() { return this.calls.filter((c) => c.method === 'post'); },
};
distAxios.post = async (url: string, body: any, options: any) => {
  meta.calls.push({ method: 'post', url, body, headers: options?.headers });
  return meta.post(body);
};
distAxios.get = async (url: string) => {
  meta.calls.push({ method: 'get', url });
  return { data: { status: meta.status } };
};
distAxios.request = async () => { throw new Error('unexpected axios.request'); };

let server: any;
let baseUrl = '';
let ip = 0;
const fx: any = {};

const call = (method: string, path: string, token: string | null, body?: any): Promise<{ status: number; body: any; raw: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `203.0.113.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(baseUrl + path);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) => jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const P = '/api/whatsapp/poc-test';
let nameSeq = 0;

const makeTemplate = async (overrides: Record<string, any> = {}) => {
  const created = await call('POST', '/api/whatsapp/templates', fx.g, {
    eventId: fx.event.eventId,
    displayName: 'Invitation',
    name: `poc_invite_${++nameSeq}`,
    language: 'en',
    category: 'MARKETING',
    body: 'Dear {{1}}, you are invited to the wedding.',
    variables: [{ position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' }],
    buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.template.id;
  await WhatsAppTemplate.updateOne({ _id: id }, { $set: { localState: 'Approved', metaStatus: 'APPROVED', metaTemplateId: String(1000 + nameSeq), ...overrides } }, { overwriteImmutable: true });
  return { id, name: created.body.template.name };
};

const makeRecipient = async (token = fx.g, phone = RECIPIENT, extra: Record<string, any> = {}) => {
  const res = await call('POST', `${P}/recipients`, token, { phone, label: 'Test person', consentConfirmed: true, consentNote: 'Agreed by message on 12 Oct', ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.recipient;
};

const previewOf = async (token: string, body: any) => {
  const res = await call('POST', `${P}/preview`, token, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

const sendOf = (token: string, body: any, preview: any, extra: Record<string, any> = {}) =>
  call('POST', `${P}/send`, token, { ...body, confirmed: true, previewHash: preview.confirmation.previewHash, idempotencyKey: preview.confirmation.idempotencyKey, ...extra });

before(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([WhatsAppTemplate.init(), WhatsAppSender.init(), PocTestRecipient.init(), TemplateTestSend.init()]);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-poc@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.granted = await Admin.create({ name: 'Granted', email: 'granted-poc@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.grantedB = await Admin.create({ name: 'Granted B', email: 'grantedb-poc@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.plain = await Admin.create({ name: 'Plain', email: 'plain-poc@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.user = await User.create({ name: 'User', email: 'user-poc@example.com', passwordHash: 'x', status: 'Active', adminId: fx.granted._id });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.g = tokenFor(fx.granted, 'Admin');
  fx.event = await Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName: 'POC Wedding', eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', adminId: fx.granted._id, createdBy: fx.granted._id,
  });
  fx.gB = tokenFor(fx.grantedB, 'Admin');
  fx.p = tokenFor(fx.plain, 'Admin');
  fx.u = tokenFor(fx.user, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/whatsapp-senders', whatsappSenderRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(distAxios, realHttp);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

const resetSenders = async () => {
  await WhatsAppSender.deleteMany({});
  fx.poc = await WhatsAppSender.create({
    phoneNumberId: POC_PHONE_ID, wabaId: WABA, displayPhoneNumber: '+91 98765 11111', verifiedName: 'EventReach POC', label: 'POC sender',
    metaStatus: 'CONNECTED', listedInMeta: true, enabled: true, pocTestEnabled: true, allowedAdminIds: [fx.granted._id], statusCheckedAt: new Date(),
  });
  fx.regular = await WhatsAppSender.create({
    phoneNumberId: OTHER_PHONE_ID, wabaId: WABA, displayPhoneNumber: '+91 98765 22222', verifiedName: 'Regular', label: 'Regular sender',
    metaStatus: 'CONNECTED', listedInMeta: true, enabled: true, pocTestEnabled: false, allowedAdminIds: [fx.granted._id], statusCheckedAt: new Date(),
  });
};

beforeEach(async () => {
  await Promise.all([WhatsAppTemplate.deleteMany({}), PocTestRecipient.deleteMany({}), TemplateTestSend.deleteMany({}), AuditLog.deleteMany({})]);
  await resetSenders();
  meta.calls.length = 0;
  meta.post = () => ({ data: { messages: [{ id: 'wamid.TESTONE' }], contacts: [{ wa_id: '919876543210' }] } });
  meta.status = 'CONNECTED';
  process.env.WHATSAPP_TOKEN = FAKE_TOKEN;
  process.env.WHATSAPP_WABA_ID = WABA;
});

const basics = async () => {
  const template = await makeTemplate();
  const recipient = await makeRecipient();
  const body = { senderId: String(fx.poc._id), templateId: template.id, recipientId: recipient.id, variables: ['Riya'] };
  return { template, recipient, body };
};

describe('every POC test route is protected', () => {
  test('a User and an Admin without the grant get 403; nobody signed in gets 401; a granted Admin gets in', async () => {
    const routes: [string, string, any?][] = [
      ['GET', `${P}/senders`], ['GET', `${P}/senders/${fx.poc._id}/templates`], ['GET', `${P}/recipients`],
      ['POST', `${P}/recipients`, {}], ['DELETE', `${P}/recipients/${fx.poc._id}`], ['POST', `${P}/preview`, {}], ['POST', `${P}/send`, {}],
      ['GET', `${P}/sends`], ['GET', `${P}/sends/${fx.poc._id}`], ['POST', `${P}/sends/${fx.poc._id}/reconcile`, {}],
    ];
    for (const [method, path, body] of routes) {
      for (const [who, token] of [['User', fx.u], ['Admin without grant', fx.p]]) {
        const res = await call(method, path, token, body);
        assert.equal(res.status, 403, `${who}: ${method} ${path}`);
        assert.equal(res.body?.error?.code, 'ACCESS_DENIED', `${who}: ${method} ${path}`);
      }
      assert.equal((await call(method, path, null, body)).status, 401, `anonymous: ${method} ${path}`);
    }
    assert.equal(meta.calls.length, 0, 'a refused request never reaches Meta');
    assert.equal((await call('GET', `${P}/senders`, fx.g)).status, 200);
  });

  test('a granted Admin who is not on the sender\'s allowed list cannot see or use it', async () => {
    const { body, template } = await basics();
    const list = await call('GET', `${P}/senders`, fx.gB);
    assert.deepEqual(list.body.senders, []);
    assert.equal((await call('GET', `${P}/senders/${fx.poc._id}/templates`, fx.gB)).status, 404);
    for (const token of [fx.g, fx.super]) {
      assert.equal((await call('GET', `${P}/senders/${fx.regular._id}/templates`, token)).status, 404, 'a sender that is not a POC sender is not part of this feature');
    }
    const res = await call('POST', `${P}/preview`, fx.gB, { ...body, templateId: template.id });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SENDER_NOT_FOUND');
    assert.equal(meta.sends.length, 0);
  });
});

describe('the POC sender section', () => {
  test('shows only designated senders, with the number masked, status and capabilities', async () => {
    const res = await call('GET', `${P}/senders`, fx.g);
    assert.equal(res.status, 200);
    assert.equal(res.body.senders.length, 1, 'the regular sender is not a POC sender');
    const s = res.body.senders[0];
    assert.equal(s.label, 'POC sender');
    assert.match(s.displayPhoneNumberMasked, /^\+91\*+1111$/);
    assert.equal(s.metaStatus, 'CONNECTED');
    assert.deepEqual(s.capabilities, { pocTestEnabled: true, enabled: true, listedInMeta: true, inConfiguredAccount: true, allowedForYou: true, connected: true });
    assert.equal(s.eligible, true);
    assert.equal(res.body.config.tokenConfigured, true);
    for (const secret of [FAKE_TOKEN, '98765 11111', '9876511111', POC_PHONE_ID, WABA]) assert.equal(res.raw.includes(secret), false, `leaks ${secret.slice(0, 6)}`);
    assert.equal(meta.calls.length, 0, 'listing never reaches Meta');
  });

  test('a sender that cannot be used says why, from stored data', async () => {
    await WhatsAppSender.updateOne({ _id: fx.poc._id }, { $set: { metaStatus: 'FLAGGED', enabled: false } });
    const s = (await call('GET', `${P}/senders`, fx.super)).body.senders[0];
    assert.equal(s.eligible, false);
    assert.ok(s.reasons.some((r: string) => /disabled/.test(r)));
    assert.ok(s.reasons.some((r: string) => /FLAGGED/.test(r)));
  });

  test('missing credentials are reported by name, never by value, and block preview and send', async () => {
    delete process.env.WHATSAPP_TOKEN;
    const { body } = await basics();
    const list = await call('GET', `${P}/senders`, fx.g);
    assert.deepEqual(list.body.config.missing, ['WHATSAPP_TOKEN']);
    const res = await call('POST', `${P}/preview`, fx.g, body);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'CONFIGURATION_ERROR');
    assert.match(res.body.error.message, /WHATSAPP_TOKEN/);
    assert.equal(meta.sends.length, 0);
    assert.equal(await TemplateTestSend.countDocuments(), 0, 'nothing claimed');
  });
});

describe('templates available to a sender', () => {
  test('only approved templates in the sender\'s account are sendable; the rest show why', async () => {
    const ok = await makeTemplate();
    const pending = await makeTemplate({ localState: 'Pending', metaStatus: 'PENDING' });
    const paused = await makeTemplate({ metaStatus: 'PAUSED' });
    const elsewhere = await makeTemplate({ wabaId: OTHER_WABA });
    const res = await call('GET', `${P}/senders/${fx.poc._id}/templates`, fx.g);
    assert.equal(res.status, 200);
    const by = Object.fromEntries(res.body.templates.map((t: any) => [t.id, t]));
    assert.equal(by[ok.id].sendable, true);
    assert.deepEqual(by[ok.id].variables, [{ position: 1, label: 'Guest name', sample: 'Riya' }]);
    assert.equal(by[pending.id].sendable, false);
    assert.match(by[pending.id].reasons[0], /not approved/);
    assert.equal(by[paused.id].sendable, false, 'Approved here but Meta says PAUSED');
    assert.match(by[paused.id].reasons[0], /PAUSED/);
    assert.equal(by[elsewhere.id], undefined, 'a template of another account is not in this sender\'s list at all');
    assert.equal(meta.calls.length, 0);
  });
});

describe('recipients and consent', () => {
  test('consent must be confirmed and described; the number is validated; the API returns it masked', async () => {
    const noConsent = await call('POST', `${P}/recipients`, fx.g, { phone: RECIPIENT, label: 'A', consentNote: 'Agreed by message' });
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.body.error.code, 'CONSENT_REQUIRED');
    assert.equal((await call('POST', `${P}/recipients`, fx.g, { phone: RECIPIENT, label: 'A', consentConfirmed: true, consentNote: 'x' })).body.error.field, 'consentNote');
    assert.equal((await call('POST', `${P}/recipients`, fx.g, { phone: '12345', label: 'A', consentConfirmed: true, consentNote: 'Agreed by message' })).body.error.field, 'phone');

    const ok = await call('POST', `${P}/recipients`, fx.g, { phone: '9876543210', label: 'Riya', consentConfirmed: true, consentNote: 'Agreed by message on 12 Oct' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.recipient.phoneMasked, '+91******3210');
    assert.equal(ok.raw.includes('9876543210'), false, 'the full number is never returned');
    assert.equal((await call('POST', `${P}/recipients`, fx.g, { phone: RECIPIENT, label: 'Again', consentConfirmed: true, consentNote: 'Agreed by message' })).body.error.code, 'ALREADY_REGISTERED');
    const list = await call('GET', `${P}/recipients`, fx.g);
    assert.equal(list.raw.includes('9876543210'), false);
    assert.equal(meta.calls.length, 0, 'registering sends nothing');
  });

  test('a removed recipient cannot be sent to, and someone else\'s cannot be used', async () => {
    const { body } = await basics();
    const mine = body.recipientId;
    assert.equal((await call('DELETE', `${P}/recipients/${mine}`, fx.gB)).status, 404, 'not another Admin\'s to remove');
    const other = await makeRecipient(fx.gB, '+919812345678');
    await WhatsAppSender.updateOne({ _id: fx.poc._id }, { $addToSet: { allowedAdminIds: fx.grantedB._id } });
    const used = await call('POST', `${P}/preview`, fx.g, { ...body, recipientId: other.id });
    assert.equal(used.status, 404);
    assert.equal(used.body.error.code, 'RECIPIENT_NOT_FOUND');

    assert.equal((await call('DELETE', `${P}/recipients/${mine}`, fx.g)).status, 200);
    const gone = await call('POST', `${P}/preview`, fx.g, body);
    assert.equal(gone.status, 409);
    assert.equal(gone.body.error.code, 'RECIPIENT_NOT_ALLOWED');
    assert.equal(meta.sends.length, 0);
  });
});

describe('preview: everything is checked, nothing is sent', () => {
  test('shows the rendered message, the masked sender and recipient, and the confirmation the send needs', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    assert.equal(preview.preview.renderedBody, 'Dear Riya, you are invited to the wedding.');
    assert.equal(preview.preview.sender.label, 'POC sender');
    assert.match(preview.preview.sender.numberMasked, /^\+91\*+1111$/);
    assert.equal(preview.preview.recipient.numberMasked, '+91******3210');
    assert.deepEqual(preview.preview.buttons, [{ type: 'QUICK_REPLY', text: 'Yes' }]);
    assert.match(preview.confirmation.previewHash, /^[0-9a-f]{64}$/);
    assert.ok(preview.confirmation.idempotencyKey);
    assert.equal(preview.duplicateRisk, null);
    assert.equal(meta.sends.length, 0);
    assert.equal(await TemplateTestSend.countDocuments(), 0, 'a preview records nothing');
    assert.equal(await AuditLog.countDocuments({ action: /POC_TEST_SEND/ }), 0);
  });

  test('a stale sender status is re-checked with Meta (a read); a number that is not connected blocks the preview', async () => {
    const { body } = await basics();
    await WhatsAppSender.updateOne({ _id: fx.poc._id }, { $set: { statusCheckedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    meta.status = 'BANNED';
    const res = await call('POST', `${P}/preview`, fx.g, body);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SENDER_UNAVAILABLE');
    assert.match(res.body.error.message, /BANNED/);
    assert.equal(meta.calls.some((c) => c.method === 'get'), true);
    assert.equal(meta.sends.length, 0);
  });

  test('sender and template must be compatible: the sender must be a POC sender in the configured account; the template in the same account', async () => {
    const { body, template } = await basics();
    const notPoc = await call('POST', `${P}/preview`, fx.g, { ...body, senderId: String(fx.regular._id) });
    assert.equal(notPoc.status, 409);
    assert.match(notPoc.body.error.message, /not designated/);

    await WhatsAppSender.updateOne({ _id: fx.poc._id }, { $set: { wabaId: OTHER_WABA } }, { overwriteImmutable: true });
    const wrongAccount = await call('POST', `${P}/preview`, fx.g, body);
    assert.equal(wrongAccount.status, 409);
    assert.match(wrongAccount.body.error.message, /different WhatsApp Business Account/);
    await WhatsAppSender.updateOne({ _id: fx.poc._id }, { $set: { wabaId: WABA } }, { overwriteImmutable: true });

    await WhatsAppTemplate.updateOne({ _id: template.id }, { $set: { wabaId: OTHER_WABA } }, { overwriteImmutable: true });
    const wrongTemplate = await call('POST', `${P}/preview`, fx.g, body);
    assert.equal(wrongTemplate.status, 409);
    assert.equal(wrongTemplate.body.error.code, 'TEMPLATE_NOT_SENDABLE');
    assert.match(wrongTemplate.body.error.message, /different WhatsApp Business Account than the sender/);
    assert.equal(meta.sends.length, 0);
  });

  test('a template that is not approved - here or at Meta - is refused', async () => {
    const { body } = await basics();
    for (const set of [{ localState: 'Pending', metaStatus: 'PENDING' }, { localState: 'Draft', metaStatus: null }, { localState: 'Approved', metaStatus: 'REJECTED' }, { localState: 'Approved', metaStatus: 'PAUSED' }, { localState: 'Disabled', metaStatus: 'DISABLED' }]) {
      await WhatsAppTemplate.updateOne({ _id: body.templateId }, { $set: set });
      const res = await call('POST', `${P}/preview`, fx.g, body);
      assert.equal(res.status, 409, JSON.stringify(set));
      assert.equal(res.body.error.code, 'TEMPLATE_NOT_SENDABLE', JSON.stringify(set));
    }
    assert.equal(meta.sends.length, 0);
  });

  test('variables: the right number, text, not empty, no line breaks; ids must be valid', async () => {
    const { body } = await basics();
    const bad: [any, string][] = [
      [[], 'variables'], [['A', 'B'], 'variables'], [[''], 'variables[0]'], [[5], 'variables[0]'], [['line\nbreak'], 'variables[0]'], ['Riya', 'variables'], [['x'.repeat(1025)], 'variables[0]'],
    ];
    for (const [variables, field] of bad) {
      const res = await call('POST', `${P}/preview`, fx.g, { ...body, variables });
      assert.equal(res.status, 400, JSON.stringify(variables));
      assert.equal(res.body.error.field, field, JSON.stringify(variables));
    }
    for (const field of ['senderId', 'templateId', 'recipientId']) {
      const res = await call('POST', `${P}/preview`, fx.g, { ...body, [field]: 'not-an-id' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.field, field);
    }
    assert.equal((await call('POST', `${P}/preview`, fx.g, [1, 2])).status, 400);
    assert.equal(meta.sends.length, 0);
  });
});

describe('sending: confirmation, outcome and the number used', () => {
  test('sends only with confirmation, the reviewed hash and the preview\'s key', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    const refusals: [any, string, string][] = [
      [{ ...body }, 'CONFIRMATION_REQUIRED', 'confirmed'],
      [{ ...body, confirmed: 'yes', previewHash: preview.confirmation.previewHash, idempotencyKey: preview.confirmation.idempotencyKey }, 'CONFIRMATION_REQUIRED', 'confirmed'],
      [{ ...body, confirmed: true, idempotencyKey: preview.confirmation.idempotencyKey }, 'CONFIRMATION_REQUIRED', 'previewHash'],
      [{ ...body, confirmed: true, previewHash: preview.confirmation.previewHash }, 'CONFIRMATION_REQUIRED', 'idempotencyKey'],
      [{ ...body, confirmed: true, previewHash: preview.confirmation.previewHash, idempotencyKey: 'short' }, 'CONFIRMATION_REQUIRED', 'idempotencyKey'],
    ];
    for (const [payload, code, field] of refusals) {
      const res = await call('POST', `${P}/send`, fx.g, payload);
      assert.equal(res.status, 400, field);
      assert.equal(res.body.error.code, code);
      assert.equal(res.body.error.field, field);
    }
    assert.equal(meta.sends.length, 0);
    assert.equal(await TemplateTestSend.countDocuments(), 0);
  });

  test('a change after the preview invalidates it', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    const res = await sendOf(fx.g, { ...body, variables: ['Someone else'] }, preview);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PREVIEW_CHANGED');
    assert.equal(meta.sends.length, 0);
  });

  test('accepted: sent from the POC sender\'s own phone number id, with the message id; accepted is not delivered', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    const res = await sendOf(fx.g, body, preview);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'accepted');
    assert.equal(res.body.replayed, false);
    assert.equal(res.body.send.messageId, 'wamid.TESTONE');
    assert.equal(res.body.send.delivery, null, 'no delivery is claimed before Meta reports it');
    assert.match(res.body.message, /not proof/);
    assert.equal(res.body.audit.completed, true);

    assert.equal(meta.sends.length, 1);
    assert.equal(meta.sends[0].url, `https://graph.facebook.com/v22.0/${POC_PHONE_ID}/messages`, 'the POC sender\'s id, never the environment sender\'s');
    assert.equal(meta.sends[0].url.includes(ENV_PHONE_ID), false);
    assert.equal(meta.sends[0].body.to, RECIPIENT);
    assert.equal(meta.sends[0].body.template.name, (await WhatsAppTemplate.findById(body.templateId)).name);
    assert.deepEqual(meta.sends[0].body.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Riya' }] }]);
    assert.equal(meta.sends[0].headers.Authorization, `Bearer ${FAKE_TOKEN}`, 'the token is used server-side');
    assert.equal(res.raw.includes(FAKE_TOKEN), false);
    assert.equal(res.raw.includes('9876543210'), false);
  });

  test('failed: Meta\'s refusal is a clear, final outcome and a retry is offered as safe', async () => {
    meta.post = () => { throw { response: { status: 400, data: { error: { code: 132001, message: 'Template does not exist' } } } }; };
    const { body } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'failed');
    assert.equal(res.body.send.errorCategory, 'TEMPLATE_NOT_AVAILABLE');
    assert.equal(res.body.send.metaErrorCode, 132001);
    assert.equal(res.body.send.messageId, null);
    assert.equal(res.body.send.retry.safe, true);
    // And a retry really can send, with a fresh preview.
    meta.post = () => ({ data: { messages: [{ id: 'wamid.RETRY' }] } });
    const again = await sendOf(fx.g, body, await previewOf(fx.g, body));
    assert.equal(again.body.outcome, 'accepted');
    assert.equal(meta.sends.length, 2);
  });

  test('unknown: a timeout, a 2xx with no message id, and Meta\'s "unexpected error" all stay unknown, never success or failure', async () => {
    const cases: [string, () => any][] = [
      ['timeout', () => { throw { code: 'ECONNABORTED' }; }],
      ['no message id', () => ({ data: { messages: [] } })],
      ['unexpected error', () => { throw { response: { status: 500, data: { error: { code: 131000, message: 'Something went wrong' } } } }; }],
      ['server error without a body', () => { throw { response: { status: 502, data: 'Bad Gateway' } }; }],
    ];
    for (const [label, post] of cases) {
      await Promise.all([TemplateTestSend.deleteMany({}), PocTestRecipient.deleteMany({})]);
      meta.post = post;
      const { body } = await basics();
      const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
      assert.equal(res.status, 200, label);
      assert.equal(res.body.outcome, 'unknown', label);
      assert.equal(res.body.send.state, 'Unknown', label);
      assert.equal(res.body.send.retry.safe, false, label);
      assert.match(res.body.message, /may or may not/, label);
    }
  });

  test('a credentials failure is a failure, not an unknown, and never leaks the token', async () => {
    meta.post = () => { throw { response: { status: 401, data: { error: { code: 190, message: `Invalid token ${FAKE_TOKEN}` } } } }; };
    const { body } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    assert.equal(res.body.outcome, 'failed');
    assert.equal(res.body.send.errorCategory, 'AUTHENTICATION_ERROR');
    assert.equal(res.raw.includes(FAKE_TOKEN), false);
    assert.equal(JSON.stringify(await AuditLog.find({}).lean()).includes(FAKE_TOKEN), false);
  });

  test('no silent fallback: an unusable POC sender sends nothing - from no number at all', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    await WhatsAppSender.updateOne({ _id: fx.poc._id }, { $set: { enabled: false } });
    const res = await sendOf(fx.g, body, preview);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SENDER_UNAVAILABLE');
    assert.equal(meta.sends.length, 0, 'not from the regular sender, not from the environment sender');
    assert.equal(await TemplateTestSend.countDocuments(), 0);
  });
});

describe('no duplicate sends', () => {
  test('the same key twice is one send: the second reports what happened', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    const first = await sendOf(fx.g, body, preview);
    const second = await sendOf(fx.g, body, preview);
    assert.equal(first.body.outcome, 'accepted');
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.send.id, first.body.send.id);
    assert.equal(meta.sends.length, 1);
  });

  test('concurrent requests with one key claim once and send once', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    const results = await Promise.all(Array.from({ length: 6 }, () => sendOf(fx.g, body, preview)));
    assert.equal(results.every((r) => r.status === 200), true, JSON.stringify(results.map((r) => r.status)));
    assert.equal(meta.sends.length, 1, 'exactly one request reached Meta');
    assert.equal(await TemplateTestSend.countDocuments(), 1);
    assert.equal(new Set(results.map((r) => r.body.send.id)).size, 1);
  });

  test('an interrupted send (the process died after the claim) becomes unknown and blocks a silent repeat', async () => {
    const { body, template, recipient } = await basics();
    const preview = await previewOf(fx.g, body);
    // The record a crashed process would leave: claimed, never answered, past its lease.
    await TemplateTestSend.create({
      actorId: String(fx.granted._id), idempotencyKey: 'crashed-send-key-0001', senderId: String(fx.poc._id), phoneNumberId: POC_PHONE_ID, wabaId: WABA,
      templateId: template.id, templateName: template.name, templateLanguage: 'en', recipientId: recipient.id, recipientMasked: '+91******3210', variableCount: 1,
      contentHash: preview.confirmation.previewHash, state: 'Claimed', claimedAt: new Date(Date.now() - 10 * 60 * 1000), expiresAt: new Date(Date.now() + 86400000),
    });
    const listed = await call('GET', `${P}/sends`, fx.g);
    assert.equal(listed.body.sends[0].outcome, 'unknown', 'a stale claim is shown as unknown, not as sent or failed');
    assert.equal(listed.body.sends[0].outcomeCode, 'STALE_CLAIM');

    const risky = await call('POST', `${P}/preview`, fx.g, body);
    assert.equal(risky.body.duplicateRisk.state, 'Unknown');
    const refused = await sendOf(fx.g, body, risky.body);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'DUPLICATE_RISK');
    assert.equal(meta.sends.length, 0, 'recovery never silently re-sends');

    const acknowledged = await sendOf(fx.g, body, await previewOf(fx.g, body), { acknowledgeDuplicateRisk: true });
    assert.equal(acknowledged.body.outcome, 'accepted');
    assert.equal(meta.sends.length, 1, 'only with explicit acknowledgement');
  });

  test('a message accepted minutes ago is not repeated without acknowledgement', async () => {
    const { body } = await basics();
    await sendOf(fx.g, body, await previewOf(fx.g, body));
    const again = await sendOf(fx.g, body, await previewOf(fx.g, body));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'DUPLICATE_RISK');
    assert.equal(meta.sends.length, 1);
  });

  test('an unknown send is reconciled by a person, once; reconciling never sends', async () => {
    meta.post = () => { throw { code: 'ECONNABORTED' }; };
    const { body } = await basics();
    const sent = await sendOf(fx.g, body, await previewOf(fx.g, body));
    assert.equal(sent.body.outcome, 'unknown');
    const id = sent.body.send.id;

    assert.equal((await call('POST', `${P}/sends/${id}/reconcile`, fx.g, { resolution: 'maybe' })).status, 400);
    assert.equal((await call('POST', `${P}/sends/${id}/reconcile`, fx.gB, { resolution: 'received' })).status, 404, 'not another Admin\'s');
    const done = await call('POST', `${P}/sends/${id}/reconcile`, fx.g, { resolution: 'not_received' });
    assert.equal(done.status, 200);
    assert.equal(done.body.send.outcome, 'confirmed_not_received');
    assert.equal(done.body.send.retry.safe, true);
    const twice = await call('POST', `${P}/sends/${id}/reconcile`, fx.g, { resolution: 'received' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'NOT_RECONCILABLE');
    assert.equal(meta.sends.length, 1, 'reconciling sent nothing');
  });

  test('an hourly limit applies across requests and instances (it is counted in the database)', async () => {
    const { body, template, recipient } = await basics();
    const docs = Array.from({ length: poc.TEST_SENDS_PER_HOUR }, (_, i) => ({
      actorId: String(fx.granted._id), idempotencyKey: `limit-key-${String(i).padStart(4, '0')}-xxxxxxx`, senderId: String(fx.poc._id), phoneNumberId: POC_PHONE_ID, wabaId: WABA,
      templateId: template.id, templateName: template.name, templateLanguage: 'en', recipientId: recipient.id, recipientMasked: '+91******3210', variableCount: 1,
      contentHash: `${i}`.padStart(64, 'a'), state: 'Failed', claimedAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
    }));
    await TemplateTestSend.insertMany(docs);
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'RATE_LIMITED');
    assert.equal(meta.sends.length, 0);
  });
});

describe('audit trail and privacy', () => {
  test('a claim is audited before the send and the outcome after, with nothing sensitive in either', async () => {
    const { body, template } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    const entries = await AuditLog.find({ action: /^POC_TEST_SEND/ }).sort({ timestamp: 1 }).lean();
    assert.deepEqual(entries.map((e: any) => e.action), ['POC_TEST_SEND_CLAIMED', 'POC_TEST_SEND_OUTCOME']);
    assert.equal(entries[0].metadata.templateName, template.name);
    assert.equal(entries[0].metadata.recipientMasked, '+91******3210');
    assert.equal(entries[0].metadata.variableCount, 1);
    assert.equal(entries[1].metadata.messageId, 'wamid.TESTONE');
    const everything = JSON.stringify([entries, await TemplateTestSend.find({}).lean()]);
    for (const secret of [FAKE_TOKEN, '9876543210', 'Riya', 'Dear', 'invited to the wedding']) {
      assert.equal(everything.includes(secret), false, `stored: ${secret}`);
    }

    const detail = await call('GET', `${P}/sends/${res.body.send.id}`, fx.g);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.audit.map((a: any) => a.action), ['POC_TEST_SEND_CLAIMED', 'POC_TEST_SEND_OUTCOME']);
    assert.equal(detail.raw.includes('@example.com'), false, 'the trail names the actor, never their email');
    assert.equal(detail.raw.includes('9876543210'), false);
  });

  test('if the claim cannot be audited, nothing is sent', async () => {
    const { body } = await basics();
    const preview = await previewOf(fx.g, body);
    const original = AuditService.log;
    AuditService.log = async (params: any) => (params.action === 'POC_TEST_SEND_CLAIMED' ? false : original.call(AuditService, params));
    try {
      const res = await sendOf(fx.g, body, preview);
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'AUDIT_UNAVAILABLE');
    } finally {
      AuditService.log = original;
    }
    assert.equal(meta.sends.length, 0);
    assert.equal((await TemplateTestSend.findOne({}).lean()).state, 'Failed');
  });

  test('another account\'s test sends are invisible (404); a Super Admin sees all', async () => {
    const { body } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    const id = res.body.send.id;
    assert.equal((await call('GET', `${P}/sends/${id}`, fx.gB)).status, 404);
    assert.deepEqual((await call('GET', `${P}/sends`, fx.gB)).body.sends, []);
    assert.equal((await call('GET', `${P}/sends/${id}`, fx.super)).status, 200);
    assert.equal((await call('GET', `${P}/sends`, fx.super)).body.sends.length, 1);
  });
});

describe('delivery status from the webhook', () => {
  test('statuses move forward only, attach to the message id, and a failure after delivery is ignored', async () => {
    const { body } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    const at = new Date();
    assert.equal(await poc.applyPocDeliveryStatus('wamid.UNKNOWN', 'delivered', at), false, 'not ours');
    assert.equal(await poc.applyPocDeliveryStatus('wamid.TESTONE', 'sent', at), true);
    assert.equal(await poc.applyPocDeliveryStatus('wamid.TESTONE', 'delivered', at), true);
    assert.equal(await poc.applyPocDeliveryStatus('wamid.TESTONE', 'sent', at), false, 'never backwards');
    assert.equal(await poc.applyPocDeliveryStatus('wamid.TESTONE', 'failed', at, [{ code: 131026 }]), false, 'a failure after delivery is ignored');
    assert.equal(await poc.applyPocDeliveryStatus('wamid.TESTONE', 'read', at), true);
    assert.equal(await poc.applyPocDeliveryStatus('wamid.TESTONE', 'bogus', at), false);
    const detail = await call('GET', `${P}/sends/${res.body.send.id}`, fx.g);
    assert.equal(detail.body.send.delivery, 'read');
    assert.equal(detail.body.send.outcome, 'accepted');
  });

  test('a failed delivery records its code, and is shown as a delivery failure of an accepted message', async () => {
    const { body } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    assert.equal(await poc.applyPocDeliveryStatus('wamid.TESTONE', 'failed', new Date(), [{ code: 131026 }]), true);
    const sent = await TemplateTestSend.findById(res.body.send.id).lean();
    assert.equal(sent.delivery, 'failed');
    assert.equal(sent.deliveryErrorCode, 131026);
  });
});

describe('nothing sends by itself', () => {
  test('reading every page - lists, templates, history, detail - never reaches the send endpoint', async () => {
    const { body } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    const sendsBefore = meta.sends.length;
    for (let i = 0; i < 3; i++) {
      for (const path of [`${P}/senders`, `${P}/senders/${fx.poc._id}/templates`, `${P}/recipients`, `${P}/sends`, `${P}/sends/${res.body.send.id}`]) {
        assert.equal((await call('GET', path, fx.g)).status, 200, path);
      }
    }
    assert.equal(meta.sends.length, sendsBefore);
    assert.equal(await TemplateTestSend.countDocuments(), 1);
  });

  test('creating or submitting a template never sends a message', async () => {
    const created = await call('POST', '/api/whatsapp/templates', fx.g, { eventId: fx.event.eventId, displayName: 'x', name: 'poc_nosend', language: 'en',category: 'UTILITY', body: 'Hello there.', variables: [] });
    assert.equal(created.status, 201);
    const review = await call('GET', `/api/whatsapp/templates/${created.body.template.id}/payload`, fx.g);
    await call('POST', `/api/whatsapp/templates/${created.body.template.id}/submit`, fx.g, { confirmPayloadHash: review.body.payloadHash });
    assert.equal(meta.sends.every((c) => c.url.endsWith('/message_templates')), true, 'the only POST was the template submission');
    assert.equal(meta.sends.some((c) => c.url.endsWith('/messages')), false);
    assert.equal(await TemplateTestSend.countDocuments(), 0);
  });
});

describe('designating the POC sender, and the webhook', () => {
  test('only a Super Admin designates a POC sender; it is off for every other number; only a Super Admin sees the flag', async () => {
    const S = '/api/whatsapp-senders';
    assert.equal(fx.regular.pocTestEnabled, false, 'off by default');
    assert.equal((await call('PATCH', `${S}/${fx.regular._id}`, fx.g, { pocTestEnabled: true })).status, 403);
    assert.equal((await call('PATCH', `${S}/${fx.regular._id}`, fx.super, { pocTestEnabled: 'yes' })).status, 400);
    const done = await call('PATCH', `${S}/${fx.regular._id}`, fx.super, { pocTestEnabled: true });
    assert.equal(done.status, 200);
    assert.equal(done.body.sender.pocTestEnabled, true);
    assert.equal((await call('GET', `${P}/senders`, fx.g)).body.senders.length, 2, 'now designated, so it is listed');
    const forAdmin = await call('GET', S, fx.g);
    assert.equal(forAdmin.body.senders.some((s: any) => 'pocTestEnabled' in s), false, 'an Admin does not see the designation');
    const forSuper = await call('GET', S, fx.super);
    assert.equal(forSuper.body.senders.every((s: any) => typeof s.pocTestEnabled === 'boolean'), true);
    assert.ok(await AuditLog.findOne({ action: 'WHATSAPP_SENDER_UPDATED' }));
    assert.equal(meta.calls.length, 0);
  });

  test('a delivery callback for a POC test message updates its record; one for any other message is ignored', async () => {
    const { body } = await basics();
    const res = await sendOf(fx.g, body, await previewOf(fx.g, body));
    const payload = (id: string, status: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    assert.equal(await __applyStatusUpdatesForTest(payload('wamid.NOTOURS', 'delivered')), 0);
    assert.equal(await __applyStatusUpdatesForTest(payload('wamid.TESTONE', 'delivered')), 1);
    assert.equal(await __applyStatusUpdatesForTest(payload('wamid.TESTONE', 'delivered')), 0, 'a repeated callback changes nothing');
    const detail = await call('GET', `${P}/sends/${res.body.send.id}`, fx.g);
    assert.equal(detail.body.send.delivery, 'delivered');
    assert.equal(detail.body.send.outcome, 'accepted');
  });
});
