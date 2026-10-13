import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * /api/whatsapp/templates over real HTTP, against the REAL compiled backend
 * (backend/dist) on a throwaway database.
 *
 * Meta is mocked at the adapter boundary: the axios instance the compiled
 * adapter calls is replaced with a fake that answers like Meta and records
 * every call, so no request can leave this process. The token is fake.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_templateroutes_${Date.now()}`;
const FAKE_TOKEN = 'EAAG-FAKE-SENTINEL-TOKEN-never-real-7f3a9c';
const WABA = '102290129340398';
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = FAKE_TOKEN;
process.env.WHATSAPP_WABA_ID = WABA;
process.env.WHATSAPP_PHONE_ID = '1407379562449786';
process.env.WHATSAPP_API_VERSION = 'v22.0';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { WhatsAppTemplate } = require('../backend/dist/models/WhatsAppTemplate');

// ── Meta, faked at the adapter boundary ──────────────────────────────────────
const distAxios = createRequire(require.resolve('../backend/dist/services/metaTemplateApi'))('axios');
const realHttp = { post: distAxios.post, get: distAxios.get, request: distAxios.request };
const meta = {
  calls: [] as { method: string; url: string; body?: any }[],
  post: (_body: any): any => ({ data: { id: '594425479261596', status: 'PENDING', category: 'MARKETING' } }),
  get: (_params: any): any => ({ data: { data: [] } }),
  /** GET /{template-id}: the status lookup. */
  byId: (_id: string): any => ({ data: {} }),
};
distAxios.post = async (url: string, body: any) => {
  meta.calls.push({ method: 'post', url, body });
  return meta.post(body);
};
distAxios.get = async (url: string, options: any) => {
  meta.calls.push({ method: 'get', url, body: options?.params });
  return url.endsWith('/message_templates') ? meta.get(options?.params) : meta.byId(url.split('/').pop()!);
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

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

let nameSeq = 0;
const draft = (overrides: Record<string, any> = {}) => ({
  displayName: 'Wedding invitation',
  name: `route_invite_${++nameSeq}`,
  language: 'en',
  category: 'MARKETING',
  body: 'Dear {{1}}, you are invited to the wedding of Pranjali & Ankit.',
  variables: [{ position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' }],
  ...overrides,
});

const T = '/api/whatsapp/templates';

before(async () => {
  await mongoose.connect(TEST_DB);
  await WhatsAppTemplate.init();
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-routes@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.granted = await Admin.create({ name: 'Granted', email: 'granted-routes@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.grantedB = await Admin.create({ name: 'Granted B', email: 'grantedb-routes@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.plain = await Admin.create({ name: 'Plain', email: 'plain-routes@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.user = await User.create({ name: 'User', email: 'user-routes@example.com', passwordHash: 'x', status: 'Active', adminId: fx.granted._id });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.g = tokenFor(fx.granted, 'Admin');
  fx.gB = tokenFor(fx.grantedB, 'Admin');
  fx.p = tokenFor(fx.plain, 'Admin');
  fx.u = tokenFor(fx.user, 'User');
  fx.event = await Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName: 'Wedding', eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', adminId: fx.granted._id, createdBy: fx.granted._id,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', whatsappRoutes);
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

beforeEach(async () => {
  await WhatsAppTemplate.deleteMany({});
  meta.calls.length = 0;
  meta.post = () => ({ data: { id: '594425479261596', status: 'PENDING', category: 'MARKETING' } });
  meta.get = () => ({ data: { data: [] } });
  meta.byId = () => ({ data: {} });
});

/** Submits as the page does: review the payload first, then confirm its hash. */
const submit = async (id: string, token: string) => {
  const review = await call('GET', `${T}/${id}/payload`, token);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  return call('POST', `${T}/${id}/submit`, token, { confirmPayloadHash: review.body.payloadHash });
};

const create = async (token: string, body = draft()) => {
  const res = await call('POST', T, token, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.template;
};

describe('every template route is protected', () => {
  test('a User and an Admin without the grant get 403 everywhere; nobody signed in gets 401', async () => {
    const t = await create(fx.g);
    const routes: [string, string, any?][] = [
      ['GET', T], ['POST', T, draft()], ['GET', `${T}/${t.id}`], ['PATCH', `${T}/${t.id}`, { displayName: 'x' }],
      ['GET', `${T}/meta`], ['GET', `${T}/${t.id}/payload`],
      ['DELETE', `${T}/${t.id}`], ['POST', `${T}/${t.id}/submit`], ['POST', `${T}/${t.id}/reconcile`], ['POST', `${T}/${t.id}/refresh`],
    ];
    for (const [method, path, body] of routes) {
      for (const [who, token] of [['User', fx.u], ['Admin without grant', fx.p]]) {
        const res = await call(method, path, token, body);
        assert.equal(res.status, 403, `${who}: ${method} ${path}`);
        assert.deepEqual(res.body?.error?.code, 'ACCESS_DENIED', `${who}: ${method} ${path}`);
      }
      assert.equal((await call(method, path, null, body)).status, 401, `anonymous: ${method} ${path}`);
    }
    assert.equal(meta.calls.length, 0, 'Meta is never reached by a refused request');
    assert.equal((await WhatsAppTemplate.findById(t.id).lean()).localState, 'Draft');
  });

  test("an Admin cannot reach another Admin's template; shared ones are read-only", async () => {
    const ofB = await create(fx.gB);
    const shared = await create(fx.super);
    assert.equal((await call('GET', `${T}/${ofB.id}`, fx.g)).status, 404);
    assert.equal((await call('PATCH', `${T}/${ofB.id}`, fx.g, { displayName: 'mine' })).status, 404);
    assert.equal((await call('GET', `${T}/${shared.id}`, fx.g)).status, 200);
    assert.equal((await call('PATCH', `${T}/${shared.id}`, fx.g, { displayName: 'mine' })).status, 403);
    assert.equal((await call('POST', `${T}/${shared.id}/submit`, fx.g)).status, 403);
  });

  test('the existing WhatsApp routes are untouched by the new ones', async () => {
    // Reaches the event-template preview handler (its own validation), not a 404.
    const res = await call('GET', '/api/whatsapp/event-template-preview', fx.g);
    assert.equal(res.status, 400);
    assert.equal(res.body?.error?.code, 'VALIDATION_ERROR');
  });
});

describe('creating and editing', () => {
  test('server-controlled fields can never be set from a request', async () => {
    const forged = draft({
      localState: 'Approved', metaStatus: 'APPROVED', metaTemplateId: '1', wabaId: '999', ownerAdminId: String(fx.grantedB._id),
      history: [{ at: new Date(), type: 'forged' }], submission: { attempts: 9 }, version: 7, createdBy: String(fx.grantedB._id),
    });
    const t = await create(fx.g, forged);
    const stored: any = await WhatsAppTemplate.findById(t.id).lean();
    assert.equal(stored.localState, 'Draft');
    assert.equal(stored.metaStatus, null);
    assert.equal(stored.metaTemplateId, null);
    assert.equal(stored.wabaId, WABA);
    assert.equal(String(stored.ownerAdminId), String(fx.granted._id));
    assert.equal(String(stored.createdBy), String(fx.granted._id));
    assert.equal(stored.version, 1);
    assert.equal(stored.submission.attempts, 0);
    assert.deepEqual(stored.history.map((h: any) => h.type), ['created']);

    const patched = await call('PATCH', `${T}/${t.id}`, fx.g, { localState: 'Approved', metaStatus: 'APPROVED', ownerAdminId: String(fx.grantedB._id), displayName: 'Renamed' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.template.localState, 'Draft');
    assert.equal(patched.body.template.metaStatus, null);
    assert.equal(patched.body.template.ownerAdminId, String(fx.granted._id));
    assert.equal(patched.body.template.displayName, 'Renamed');
  });

  test('validation errors come back per field; a non-object body is refused', async () => {
    const bad = await call('POST', T, fx.g, draft({ name: 'Bad Name', headerText: 'Hi {{1}}', body: 'Dear {{2}}' }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.success, false);
    const fields = bad.body.error.errors.map((e: any) => e.field);
    for (const f of ['name', 'headerText', 'body']) assert.ok(fields.includes(f), f);
    assert.equal((await call('POST', T, fx.g, ['not', 'an', 'object'])).status, 400);
  });

  test('category changes cannot be requested', async () => {
    const res = await call('POST', T, fx.super, draft({ allowCategoryChange: true }));
    assert.equal(res.status, 400);
    assert.ok(res.body.error.errors.some((e: any) => e.field === 'allowCategoryChange'));
  });

  test('a list is paginated and filtered; Admins never see the account id', async () => {
    await create(fx.g, draft({ displayName: 'Haldi reminder', category: 'UTILITY', eventId: String(fx.event._id) }));
    await create(fx.g);
    await create(fx.gB);
    const res = await call('GET', `${T}?limit=1&page=1`, fx.g);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pagination, { total: 2, page: 1, limit: 1, totalPages: 2 });
    assert.equal(res.raw.includes(WABA), false);
    const filtered = await call('GET', `${T}?category=utility&eventId=${fx.event._id}`, fx.g);
    assert.deepEqual(filtered.body.data.map((t: any) => t.displayName), ['Haldi reminder']);
    assert.equal((await call('GET', T, fx.super)).body.data[0].wabaId, WABA);
  });

  test('a never-submitted draft can be deleted; a submitted one cannot', async () => {
    const t = await create(fx.g);
    assert.equal((await call('DELETE', `${T}/${t.id}`, fx.g)).status, 204);
    assert.equal((await call('GET', `${T}/${t.id}`, fx.g)).status, 404);

    const s = await create(fx.g);
    await submit(s.id, fx.g);
    const refused = await call('DELETE', `${T}/${s.id}`, fx.g);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'TEMPLATE_LOCKED');
    assert.equal(meta.calls.filter((c) => c.method !== 'post').length, 0, 'no delete request to Meta');
  });
});

describe('submission and reconciliation (Meta mocked)', () => {
  test('submit: the WABA receives it with category changes off; the result is Pending, not approved', async () => {
    const t = await create(fx.g);
    const res = await submit(t.id, fx.g);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'submitted');
    assert.equal(res.body.template.localState, 'Pending');
    assert.equal(meta.calls.length, 1);
    assert.equal(meta.calls[0].url, `https://graph.facebook.com/v22.0/${WABA}/message_templates`);
    assert.equal(meta.calls[0].body.allow_category_change, false);
    assert.equal(res.raw.includes(FAKE_TOKEN), false);

    const again = await submit(t.id, fx.g);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_SUBMITTED');
    assert.equal(meta.calls.length, 1);
  });

  test("Meta's rejection is a recorded outcome (200), and its reason is shown", async () => {
    meta.post = () => { throw { response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter', error_data: { details: 'Template name already exists' } } } } }; };
    const t = await create(fx.g);
    const res = await submit(t.id, fx.g);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'rejected');
    assert.equal(res.body.template.localState, 'SubmissionFailed');
    assert.match(res.body.template.rejectionReason, /already exists/);
  });

  test('reconcile: only for an uncertain or failed submission', async () => {
    const t = await create(fx.g);
    await submit(t.id, fx.g);
    const res = await call('POST', `${T}/${t.id}/reconcile`, fx.g);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NOTHING_TO_RECONCILE');

    meta.post = () => { throw { code: 'ECONNABORTED' }; };
    meta.get = () => { throw { code: 'ETIMEDOUT' }; };
    const u = await create(fx.g);
    const uncertain = await submit(u.id, fx.g);
    assert.equal(uncertain.body.outcome, 'uncertain');
    meta.get = () => ({ data: { data: [{ id: '4242', name: u.name, language: 'en', status: 'APPROVED', category: 'MARKETING' }] } });
    const settled = await call('POST', `${T}/${u.id}/reconcile`, fx.g);
    assert.equal(settled.status, 200);
    assert.equal(settled.body.template.localState, 'Approved', "approved because Meta said so");
  });
});

describe('status refresh (Meta mocked)', () => {
  test('a Pending template is refreshed from Meta: approved only because Meta says so', async () => {
    const t = await create(fx.g);
    const submitted = await submit(t.id, fx.g);
    const metaId = submitted.body.template.metaTemplateId;
    meta.byId = (id: string) => ({ data: { id, name: t.name, language: 'en', status: 'APPROVED', category: 'MARKETING' } });
    const res = await call('POST', `${T}/${t.id}/refresh`, fx.g);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'approved');
    assert.equal(res.body.template.localState, 'Approved');
    assert.ok(res.body.template.lastSyncedAt);
    assert.ok(meta.calls.some((c) => c.method === 'get' && c.url.endsWith(`/${metaId}`)));
    assert.equal(meta.calls.filter((c) => c.method === 'post').length, 1, 'only the original submission ever POSTed');
    assert.equal(res.raw.includes(FAKE_TOKEN), false);
  });

  test('a Draft cannot be refreshed; errors use the shared error format', async () => {
    const t = await create(fx.g);
    const res = await call('POST', `${T}/${t.id}/refresh`, fx.g);
    assert.equal(res.status, 409);
    assert.deepEqual(Object.keys(res.body), ['success', 'error']);
    assert.equal(res.body.error.code, 'NOT_REFRESHABLE');
  });

  test('a Meta outage is a 502 the page can show, never a 401 that would sign the user out', async () => {
    const t = await create(fx.g);
    await submit(t.id, fx.g);
    meta.byId = () => { throw { response: { status: 401, data: { error: { code: 190, message: 'Invalid OAuth access token' } } } }; };
    const res = await call('POST', `${T}/${t.id}/refresh`, fx.g);
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'META_AUTH_ERROR');
    assert.equal((await WhatsAppTemplate.findById(t.id).lean()).localState, 'Pending');
  });
});

describe('payload review and confirmed submission (Meta mocked)', () => {
  test('the review shows the exact payload, builds it on the server and sends nothing', async () => {
    const t = await create(fx.g, draft({ footer: 'EventReach', buttons: [{ type: 'URL', text: 'RSVP', url: 'https://example.com/rsvp' }, { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+919876543210' }] }));
    const res = await call('GET', `${T}/${t.id}/payload`, fx.g);
    assert.equal(res.status, 200);
    assert.equal(res.body.canSubmit, true);
    assert.deepEqual(res.body.blockers, []);
    assert.deepEqual(res.body.payload.components.map((c: any) => c.type), ['BODY', 'FOOTER', 'BUTTONS']);
    assert.equal(res.body.payload.name, t.name);
    assert.match(res.body.payloadHash, /^[0-9a-f]{64}$/);
    assert.equal(meta.calls.length, 0, 'reviewing never reaches Meta');
    assert.equal(res.raw.includes(FAKE_TOKEN), false);
    assert.equal(JSON.stringify(res.body.payload).includes('Authorization'), false);
  });

  test('submitting without the reviewed hash is refused, and nothing is claimed or sent', async () => {
    const t = await create(fx.g);
    for (const body of [undefined, {}, { confirmPayloadHash: '' }, { confirmPayloadHash: 5 }]) {
      const res = await call('POST', `${T}/${t.id}/submit`, fx.g, body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'CONFIRMATION_REQUIRED');
    }
    assert.equal(meta.calls.length, 0);
    assert.equal((await WhatsAppTemplate.findById(t.id).lean()).localState, 'Draft');
  });

  test('a template edited after the review cannot be sent on the old confirmation', async () => {
    const t = await create(fx.g);
    const review = await call('GET', `${T}/${t.id}/payload`, fx.g);
    await call('PATCH', `${T}/${t.id}`, fx.g, { body: 'Dear {{1}}, the venue has changed.' });
    const res = await call('POST', `${T}/${t.id}/submit`, fx.g, { confirmPayloadHash: review.body.payloadHash });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PAYLOAD_CHANGED');
    assert.equal(meta.calls.length, 0);
    const again = await submit(t.id, fx.g);
    assert.equal(again.status, 200);
    assert.equal(meta.calls.length, 1);
    assert.match(meta.calls[0].body.components[0].text, /venue has changed/);
  });

  test('a template that cannot be submitted explains why, and an invalid one returns its field errors', async () => {
    const sent = await create(fx.g);
    await submit(sent.id, fx.g);
    const review = await call('GET', `${T}/${sent.id}/payload`, fx.g);
    assert.equal(review.status, 200);
    assert.equal(review.body.canSubmit, false);
    assert.match(review.body.blockers[0], /already been submitted/);

    const broken = await create(fx.g);
    await WhatsAppTemplate.updateOne({ _id: broken.id }, { $set: { body: '' } });
    const invalid = await call('GET', `${T}/${broken.id}/payload`, fx.g);
    assert.equal(invalid.body.canSubmit, false);
    assert.equal(invalid.body.payload, null);
    assert.ok(invalid.body.errors.length > 0);
  });

  test("another Admin's template cannot be reviewed (404), and a shared one is read-only (403)", async () => {
    const mine = await create(fx.g);
    assert.equal((await call('GET', `${T}/${mine.id}/payload`, fx.gB)).status, 404);
    const shared = await create(fx.super);
    assert.equal((await call('GET', `${T}/${shared.id}/payload`, fx.g)).status, 403);
  });

  test('buttons survive a save and come back as stored; an insecure link is refused with its field', async () => {
    const buttons = [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'No' }];
    const t = await create(fx.g, draft({ buttons }));
    assert.deepEqual(t.buttons, buttons);
    const bad = await call('POST', T, fx.g, draft({ buttons: [{ type: 'URL', text: 'Go', url: 'http://insecure.example.com' }] }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.errors[0].field, 'buttons[0].url');
  });
});

describe('the account template list (Meta mocked)', () => {
  const metaTemplate = (id: string, name: string, status = 'APPROVED', extra: any = {}) => ({
    id, name, language: 'en', status, category: 'MARKETING',
    components: [{ type: 'BODY', text: `Body of ${name}` }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'RSVP', url: 'https://example.com/private-link' }] }],
    ...extra,
  });

  test('lists a page from Meta on request, with the documented fields, and follows the cursor', async () => {
    const pages: any[] = [];
    meta.get = (params: any) => {
      pages.push(params);
      return params.after
        ? { data: { data: [metaTemplate('2002', 'second')], paging: { cursors: { before: 'B', after: 'END' } } } }
        : { data: { data: [metaTemplate('2001', 'first')], paging: { cursors: { before: 'B', after: 'CURSOR1' }, next: 'https://graph.example/next' } } };
    };
    const first = await call('GET', `${T}/meta?limit=1`, fx.super);
    assert.equal(first.status, 200);
    assert.equal(first.body.templates.length, 1);
    assert.equal(first.body.nextCursor, 'CURSOR1');
    assert.equal(pages[0].fields, 'id,name,language,status,category,rejected_reason,components');
    assert.equal(pages[0].limit, '1');
    assert.equal(first.body.templates[0].bodyText, 'Body of first');
    assert.deepEqual(first.body.templates[0].buttons, [{ type: 'URL', text: 'RSVP' }], 'type and label only');
    assert.equal(first.raw.includes('private-link'), false);
    assert.equal(first.raw.includes(FAKE_TOKEN), false);

    const second = await call('GET', `${T}/meta?limit=1&after=CURSOR1`, fx.super);
    assert.equal(second.body.templates[0].id, '2002');
    assert.equal(second.body.nextCursor, null, 'no next page: no cursor');
    assert.equal(pages[1].after, 'CURSOR1');
    assert.equal(meta.calls.every((c) => c.method === 'get'), true, 'listing only ever reads');
  });

  test('a listed template is sendable from here only when EventReach holds it Approved and Meta lists it APPROVED', async () => {
    const t = await create(fx.g);
    await submit(t.id, fx.g);
    await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: 'Approved', metaStatus: 'APPROVED', metaTemplateId: '3001' } });
    meta.get = () => ({ data: { data: [metaTemplate('3001', t.name), metaTemplate('3002', 'only_at_meta'), metaTemplate('3003', 'x', 'PENDING')] } });
    const res = await call('GET', `${T}/meta`, fx.super);
    const by = Object.fromEntries(res.body.templates.map((x: any) => [x.id, x]));
    assert.equal(by['3001'].sendableFromHere, true);
    assert.equal(by['3001'].localTemplateId, t.id);
    assert.equal(by['3002'].sendableFromHere, false, 'known only to Meta');
    assert.equal(by['3002'].localTemplateId, null);

    // Meta now says it is paused: the stored Approved state alone is not enough.
    meta.get = () => ({ data: { data: [metaTemplate('3001', t.name, 'PAUSED')] } });
    assert.equal((await call('GET', `${T}/meta`, fx.super)).body.templates[0].sendableFromHere, false);
    assert.equal((await WhatsAppTemplate.findById(t.id).lean()).localState, 'Approved', 'listing never rewrites a stored template');
  });

  test('malformed entries are skipped and counted; a malformed answer is an error, not an empty list', async () => {
    meta.get = () => ({ data: { data: [metaTemplate('1', 'ok'), { name: 'no_id', language: 'en' }, null, 'junk'] } });
    const res = await call('GET', `${T}/meta`, fx.super);
    assert.equal(res.body.templates.length, 1);
    assert.equal(res.body.skipped, 3);

    meta.get = () => ({ data: { message: 'surprise' } });
    const bad = await call('GET', `${T}/meta`, fx.super);
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error.code, 'META_UNAVAILABLE');
  });

  test('a cursor of another shape is refused before anything is asked of Meta', async () => {
    for (const after of ['a%20b', encodeURIComponent('x&fields=all'), 'x'.repeat(600)]) {
      const res = await call('GET', `${T}/meta?after=${after}`, fx.super);
      assert.equal(res.status, 400, after);
    }
    assert.equal((await call('GET', `${T}/meta?limit=0`, fx.super)).status, 400);
    assert.equal(meta.calls.length, 0);
  });

  test('Meta errors keep their meaning: permission 502, rate limit 429, timeout 502, no credentials leaked', async () => {
    const cases: [any, number, string][] = [
      [{ response: { status: 403, data: { error: { code: 200, message: `denied ${FAKE_TOKEN}` } } } }, 502, 'META_AUTH_ERROR'],
      [{ response: { status: 400, data: { error: { code: 80008, message: 'Too many calls' } } } }, 429, 'RATE_LIMITED'],
      [{ code: 'ECONNABORTED' }, 502, 'META_UNAVAILABLE'],
      [{ response: { status: 400, data: { error: { code: 100, message: 'Unsupported get request' } } } }, 502, 'META_ERROR'],
    ];
    for (const [thrown, status, code] of cases) {
      meta.get = () => { throw thrown; };
      const res = await call('GET', `${T}/meta`, fx.super);
      assert.equal(res.status, status, code);
      assert.equal(res.body.error.code, code);
      assert.equal(res.raw.includes(FAKE_TOKEN), false);
    }
  });

  test('only a Super Admin may browse the whole account; a granted Admin gets 403 and Meta is not asked', async () => {
    const res = await call('GET', `${T}/meta`, fx.g);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ACCESS_DENIED');
    assert.equal(meta.calls.length, 0);
    assert.equal((await call('GET', `${T}/meta`, null)).status, 401);
  });

  test('opening the list or the review is a read: no template is created, claimed or changed', async () => {
    const t = await create(fx.g);
    const stored = JSON.stringify(await WhatsAppTemplate.findById(t.id).lean());
    meta.get = () => ({ data: { data: [metaTemplate('9', 'x')] } });
    await call('GET', `${T}/meta`, fx.super);
    await call('GET', `${T}/${t.id}/payload`, fx.g);
    assert.equal(JSON.stringify(await WhatsAppTemplate.findById(t.id).lean()), stored);
    assert.equal(meta.calls.filter((c) => c.method === 'post').length, 0);
  });
});
