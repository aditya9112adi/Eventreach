import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Stage 6a over real HTTP, against the REAL compiled backend (backend/dist) on
 * a throwaway local MongoDB database:
 *  - the effective POC and sender of an event, including the environment
 *    sender (WHATSAPP_PHONE_ID) resolved from the synced inventory;
 *  - Main Event -> Sub-Event inheritance, and clearing local values;
 *  - who may view and edit contact settings, and which senders an Admin may
 *    assign;
 *  - sender inventory routes (SuperAdmin only), sync, and the audit trail.
 *
 * Meta is faked on the axios instance the sender service uses: no request can
 * leave this process, and any unexpected call fails the suite. The token is
 * fake. Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_eventcontact_${Date.now()}`;
const FAKE_TOKEN = 'EAAG-FAKE-STAGE6A-TOKEN-never-real-91c2';
const WABA = '900000000000001';
const ENV_PHONE_ID = '111000000000001';
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = FAKE_TOKEN;
process.env.WHATSAPP_WABA_ID = WABA;
process.env.WHATSAPP_PHONE_ID = ENV_PHONE_ID;
process.env.WHATSAPP_API_VERSION = 'v22.0';

// ── fake Meta on the sender service's axios ──────────────────────────────────
const senderAxios = createRequire(require.resolve('../backend/dist/services/whatsappSenderSyncService'))('axios');
const realGet = senderAxios.get;
const meta = {
  calls: [] as { url: string; authorization: string | undefined }[],
  unexpected: [] as string[],
  /** GET /{phone-number-id}?fields=status */
  status: new Map<string, string | Error>(),
  /** GET /{waba}/phone_numbers pages, by request URL. */
  pages: new Map<string, any>(),
};
senderAxios.get = async (url: string, options: any) => {
  meta.calls.push({ url, authorization: options?.headers?.Authorization });
  const u = new URL(url);
  if (u.hostname !== 'graph.facebook.com') {
    meta.unexpected.push(url);
    throw new Error('unexpected host');
  }
  if (meta.pages.has(url)) return { data: meta.pages.get(url) };
  const id = u.pathname.split('/').pop()!;
  if (u.searchParams.get('fields') === 'status' && meta.status.has(id)) {
    const answer = meta.status.get(id)!;
    if (answer instanceof Error) throw answer;
    return { data: { status: answer } };
  }
  meta.unexpected.push(url);
  throw new Error('unexpected Meta request');
};

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const senderRoutes = require('../backend/dist/routes/whatsappSenderRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { WhatsAppSender } = require('../backend/dist/models/WhatsAppSender');
const { AuditLog } = require('../backend/dist/models/AuditLog');
const { isMetaGraphUrl } = require('../backend/dist/services/whatsappSenderSyncService');

let server: any;
let baseUrl = '';
const fx: any = {};

const call = (method: string, path: string, token: string | null, body?: any): Promise<{ status: number; body: any; raw: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = {};
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

const mkEvent = (eventName: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Kavita Maheshwari', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', ...extra,
  });

const FRESH = () => new Date();
const STALE = () => new Date(Date.now() - 16 * 60 * 1000);
let phoneSeq = 200000000000000;
const mkSender = (overrides: Record<string, any> = {}) =>
  WhatsAppSender.create({
    phoneNumberId: String(++phoneSeq), wabaId: WABA, displayPhoneNumber: `+91 90000 ${String(phoneSeq).slice(-5)}`,
    verifiedName: `Sender ${phoneSeq}`, metaStatus: 'CONNECTED', statusCheckedAt: FRESH(), listedInMeta: true,
    enabled: true, allowedAdminIds: [fx.adminA._id], ...overrides,
  });

const contact = (eventId: any, token = fx.super) => call('GET', `/api/events/${eventId}/contact`, token);
const putContact = (eventId: any, body: any, token = fx.super) => call('PUT', `/api/events/${eventId}/contact`, token, body);
const POC = { name: 'Riya Sharma', mobile: '+91 98765 43210', email: 'riya@example.com', responsibility: 'Guest desk' };

before(async () => {
  await mongoose.connect(TEST_DB);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-contact@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminA = await Admin.create({ name: 'Admin A', email: 'a-contact@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.adminB = await Admin.create({ name: 'Admin B', email: 'b-contact@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });

  fx.mainA = await mkEvent('A Wedding', { adminId: fx.adminA._id, createdBy: fx.adminA._id });
  fx.subA = await mkEvent('A Haldi', { adminId: fx.adminA._id, createdBy: fx.adminA._id, parentEventId: fx.mainA._id });
  fx.mainB = await mkEvent('B Gala', { adminId: fx.adminB._id, createdBy: fx.adminB._id });

  fx.userIn = await User.create({ name: 'User In', email: 'in-contact@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminA._id, assignedEventId: fx.mainA._id });
  fx.userOut = await User.create({ name: 'User Out', email: 'out-contact@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminB._id, assignedEventId: fx.mainB._id });

  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');
  fx.uIn = tokenFor(fx.userIn, 'User');
  fx.uOut = tokenFor(fx.userOut, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/events', eventRoutes);
  app.use('/api/whatsapp-senders', senderRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  senderAxios.get = realGet;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(meta.unexpected, [], 'no unexpected request was made');
});

beforeEach(async () => {
  await Event.updateMany({}, { $unset: { poc: 1 }, $set: { whatsappSenderId: null } });
  await WhatsAppSender.deleteMany({});
  await AuditLog.deleteMany({});
  meta.calls.length = 0;
  meta.status.clear();
  meta.pages.clear();
  process.env.WHATSAPP_PHONE_ID = ENV_PHONE_ID;
});

describe('the environment sender is resolved from the synced inventory', () => {
  test('configured and synced: its real number and verified name are shown', async () => {
    await mkSender({ phoneNumberId: ENV_PHONE_ID, displayPhoneNumber: '+91 91124 72833', verifiedName: 'EventReach Official', enabled: false, allowedAdminIds: [] });
    const res = await contact(fx.mainA._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.assignmentSource, 'environment');
    assert.equal(res.body.whatsappSenderId, null, 'no assignment: unchanged contract');
    assert.equal(res.body.effectiveSender.displayPhoneNumber, '+91 91124 72833');
    assert.equal(res.body.effectiveSender.verifiedName, 'EventReach Official');
    assert.equal(res.body.effectiveSender.statusFresh, true);
    assert.equal(res.body.environmentSenderConfigured, true);
    for (const secret of [FAKE_TOKEN, ENV_PHONE_ID, WABA]) assert.equal(res.raw.includes(secret), false, 'no token or account ids in the response');
  });

  test('configured but not synced yet: no sender details, and the page still loads', async () => {
    const res = await contact(fx.mainA._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.effectiveSender, null);
    assert.equal(res.body.environmentSenderConfigured, true);
    assert.equal(res.body.assignmentSource, 'environment');
  });

  test('not configured at all', async () => {
    delete process.env.WHATSAPP_PHONE_ID;
    await mkSender({ phoneNumberId: ENV_PHONE_ID });
    const res = await contact(fx.mainA._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.effectiveSender, null);
    assert.equal(res.body.environmentSenderConfigured, false);
  });

  test('a stale environment status is reported as not fresh', async () => {
    await mkSender({ phoneNumberId: ENV_PHONE_ID, statusCheckedAt: STALE() });
    assert.equal((await contact(fx.mainA._id)).body.effectiveSender.statusFresh, false);
  });

  test('an explicit assignment wins over the environment sender', async () => {
    await mkSender({ phoneNumberId: ENV_PHONE_ID, verifiedName: 'Environment' });
    const s1 = await mkSender({ verifiedName: 'Wedding Team' });
    await Event.updateOne({ _id: fx.mainA._id }, { $set: { whatsappSenderId: s1._id } });
    const res = await contact(fx.mainA._id);
    assert.deepEqual([res.body.assignmentSource, res.body.whatsappSenderId, res.body.effectiveSender.verifiedName], ['event', String(s1._id), 'Wedding Team']);
  });

  test("a Sub-Event without its own sender inherits the Main Event's, not the environment sender", async () => {
    await mkSender({ phoneNumberId: ENV_PHONE_ID, verifiedName: 'Environment' });
    const s1 = await mkSender({ verifiedName: 'Wedding Team' });
    await Event.updateOne({ _id: fx.mainA._id }, { $set: { whatsappSenderId: s1._id } });
    const res = await contact(fx.subA._id);
    assert.deepEqual([res.body.assignmentSource, res.body.effectiveSender.verifiedName, res.body.localWhatsAppSenderId], ['main-event', 'Wedding Team', null]);
  });

  test('a Sub-Event with neither its own nor a Main Event sender uses the environment sender', async () => {
    await mkSender({ phoneNumberId: ENV_PHONE_ID, verifiedName: 'Environment' });
    const res = await contact(fx.subA._id);
    assert.deepEqual([res.body.assignmentSource, res.body.effectiveSender.verifiedName], ['environment', 'Environment']);
  });
});

describe('POC and sender inheritance through the contact endpoint', () => {
  test('a Main Event stores its own POC, normalized, separate from the organizer', async () => {
    const res = await putContact(fx.mainA._id, { poc: POC }, fx.a);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.poc, { name: 'Riya Sharma', mobile: '+919876543210', email: 'riya@example.com', responsibility: 'Guest desk' });
    assert.equal(res.body.pocSource, 'event');
    const stored: any = await Event.findById(fx.mainA._id).lean();
    assert.equal(stored.organizerName, 'Kavita Maheshwari', 'organizer untouched');
    assert.equal(String(stored.organizerMobile), '9112472833');
  });

  test('a Sub-Event inherits, overrides, and inherits again once its POC is cleared', async () => {
    await putContact(fx.mainA._id, { poc: POC }, fx.a);
    const inherited = await contact(fx.subA._id, fx.a);
    assert.deepEqual([inherited.body.pocSource, inherited.body.poc.name, inherited.body.localPoc], ['main-event', 'Riya Sharma', null]);

    const own = await putContact(fx.subA._id, { poc: { name: 'Arjun Mehta', mobile: '9123456780' } }, fx.a);
    assert.deepEqual([own.body.pocSource, own.body.poc.name, own.body.poc.mobile], ['event', 'Arjun Mehta', '+919123456780']);

    const cleared = await putContact(fx.subA._id, { poc: null }, fx.a);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.pocSource, 'main-event', 'the response itself shows the inherited POC again');
    assert.equal(cleared.body.poc.name, 'Riya Sharma');
    assert.equal(cleared.body.localPoc, null);
    assert.equal((await contact(fx.subA._id, fx.a)).body.pocSource, 'main-event');
  });

  test("a Sub-Event's own sender, then cleared back to the Main Event's, then to the environment sender", async () => {
    const envSender = await mkSender({ phoneNumberId: ENV_PHONE_ID, verifiedName: 'Environment', allowedAdminIds: [] });
    const s1 = await mkSender({ verifiedName: 'Wedding Team' });
    const s2 = await mkSender({ verifiedName: 'Haldi Team' });
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(s1._id) }, fx.a)).status, 200);

    const own = await putContact(fx.subA._id, { whatsappSenderId: String(s2._id) }, fx.a);
    assert.deepEqual([own.body.assignmentSource, own.body.effectiveSender.verifiedName], ['event', 'Haldi Team']);

    const backToMain = await putContact(fx.subA._id, { whatsappSenderId: null }, fx.a);
    assert.deepEqual([backToMain.body.assignmentSource, backToMain.body.effectiveSender.verifiedName], ['main-event', 'Wedding Team']);

    await putContact(fx.mainA._id, { whatsappSenderId: null }, fx.a);
    const toEnv = await contact(fx.subA._id, fx.a);
    assert.deepEqual([toEnv.body.assignmentSource, toEnv.body.effectiveSender.verifiedName], ['environment', 'Environment']);
    void envSender;
  });

  test("editing a Sub-Event never changes its Main Event", async () => {
    const s1 = await mkSender();
    const s2 = await mkSender();
    await putContact(fx.mainA._id, { poc: POC, whatsappSenderId: String(s1._id) }, fx.a);
    const mainBefore: any = await Event.findById(fx.mainA._id).lean();
    await putContact(fx.subA._id, { poc: { name: 'Arjun Mehta', mobile: '9123456780' }, whatsappSenderId: String(s2._id) }, fx.a);
    await putContact(fx.subA._id, { poc: null, whatsappSenderId: null }, fx.a);
    const mainAfter: any = await Event.findById(fx.mainA._id).lean();
    assert.deepEqual(mainAfter.poc, mainBefore.poc);
    assert.equal(String(mainAfter.whatsappSenderId), String(s1._id));
  });

  test('an omitted field is left as it is', async () => {
    const s1 = await mkSender();
    await putContact(fx.mainA._id, { poc: POC, whatsappSenderId: String(s1._id) }, fx.a);
    const res = await putContact(fx.mainA._id, { poc: { ...POC, name: 'Riya S.' } }, fx.a);
    assert.equal(res.body.localWhatsAppSenderId, String(s1._id));
  });

  test('POC validation: invalid mobile, missing name, unknown fields', async () => {
    assert.equal((await putContact(fx.mainA._id, { poc: { name: 'X', mobile: '12' } }, fx.a)).status, 400);
    assert.equal((await putContact(fx.mainA._id, { poc: { name: 'X', mobile: '+1 999' } }, fx.a)).status, 400);
    assert.equal((await putContact(fx.mainA._id, { poc: { name: '', mobile: '9876543210' } }, fx.a)).status, 400);
    assert.equal((await putContact(fx.mainA._id, { poc: { ...POC, email: 'not-an-email' } }, fx.a)).status, 400);
    assert.equal((await putContact(fx.mainA._id, { poc: POC, organizerName: 'Hijack' }, fx.a)).status, 400, 'organizer fields cannot be set here');
    const intl = await putContact(fx.mainA._id, { poc: { name: 'Sam', mobile: '+44 7911 123456' } }, fx.a);
    assert.equal(intl.body.poc.mobile, '+447911123456', 'international numbers are allowed for the POC');
  });
});

describe('who may view and edit contact settings', () => {
  test('a Super Admin can view any event; an Admin only their own events and Sub-Events', async () => {
    for (const id of [fx.mainA._id, fx.subA._id, fx.mainB._id]) assert.equal((await contact(id)).status, 200);
    assert.equal((await contact(fx.subA._id, fx.a)).status, 200, "Sub-Event access follows the Main Event's");
    assert.equal((await contact(fx.mainB._id, fx.a)).status, 403, 'changing the event id in the URL does not grant access');
    assert.equal((await contact(fx.subA._id, fx.b)).status, 403);
  });

  test('a User can view an assigned event but never edit it', async () => {
    assert.equal((await contact(fx.mainA._id, fx.uIn)).status, 200);
    assert.equal((await contact(fx.mainB._id, fx.uIn)).status, 403);
    const edit = await putContact(fx.mainA._id, { poc: POC }, fx.uIn);
    assert.equal(edit.status, 403);
    assert.equal((await Event.findById(fx.mainA._id).lean()).poc, undefined);
  });

  test("an Admin cannot edit another Admin's event, by id or through its Sub-Events", async () => {
    assert.equal((await putContact(fx.mainB._id, { poc: POC }, fx.a)).status, 403);
    assert.equal((await putContact(fx.subA._id, { poc: POC }, fx.b)).status, 403);
    assert.equal((await Event.findById(fx.mainB._id).lean()).poc, undefined);
  });

  test('nobody signed in, and malformed ids', async () => {
    assert.equal((await contact(fx.mainA._id, null)).status, 401);
    assert.equal((await putContact(fx.mainA._id, { poc: POC }, null)).status, 401);
    assert.equal((await contact('not-an-id')).status, 400);
    assert.equal((await contact(new mongoose.Types.ObjectId())).status, 404);
  });
});

describe('which senders an Admin may assign', () => {
  test('an enabled, listed, connected sender in this account that the Admin is allowed to use', async () => {
    const s = await mkSender();
    const res = await putContact(fx.mainA._id, { whatsappSenderId: String(s._id) }, fx.a);
    assert.equal(res.status, 200);
    assert.equal(meta.calls.length, 0, 'a fresh status needs no Meta call');
  });

  test('refused: not allowed for this Admin - before any call to Meta', async () => {
    const s = await mkSender({ allowedAdminIds: [fx.adminB._id], statusCheckedAt: STALE() });
    meta.status.set(s.phoneNumberId, 'CONNECTED');
    const res = await putContact(fx.mainA._id, { whatsappSenderId: String(s._id) }, fx.a);
    assert.equal(res.status, 403);
    assert.equal(meta.calls.length, 0, 'an Admin cannot make the server query a sender they may not use');
  });

  test('refused: disabled, unlisted, another WhatsApp Business Account, never synced', async () => {
    const disabled = await mkSender({ enabled: false });
    const unlisted = await mkSender({ listedInMeta: false });
    const otherWaba = await mkSender({ wabaId: '900000000000999' });
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(disabled._id) }, fx.a)).status, 409);
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(unlisted._id) }, fx.a)).status, 409);
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(otherWaba._id) }, fx.a)).status, 409);
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(new mongoose.Types.ObjectId()) }, fx.a)).status, 400);
    assert.equal(meta.calls.length, 0);
    assert.equal((await Event.findById(fx.mainA._id).lean()).whatsappSenderId, null);
  });

  test('a stale status is checked with Meta first: CONNECTED is accepted', async () => {
    const s = await mkSender({ statusCheckedAt: STALE() });
    meta.status.set(s.phoneNumberId, 'CONNECTED');
    const res = await putContact(fx.mainA._id, { whatsappSenderId: String(s._id) }, fx.a);
    assert.equal(res.status, 200);
    assert.equal(meta.calls.length, 1);
    assert.equal(meta.calls[0].authorization, `Bearer ${FAKE_TOKEN}`);
    assert.ok(new Date((await WhatsAppSender.findById(s._id).lean()).statusCheckedAt).getTime() > Date.now() - 60_000, 'the fresh status is stored');
  });

  test('a stale status that Meta now reports as not connected is refused', async () => {
    const s = await mkSender({ statusCheckedAt: STALE() });
    meta.status.set(s.phoneNumberId, 'DISCONNECTED');
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(s._id) }, fx.a)).status, 409);
    assert.equal((await Event.findById(fx.mainA._id).lean()).whatsappSenderId, null);
  });

  test('if the status cannot be verified, nothing is saved', async () => {
    const s = await mkSender({ statusCheckedAt: STALE() });
    meta.status.set(s.phoneNumberId, Object.assign(new Error('Request failed'), { response: { status: 500, data: { error: { message: 'internal' } } } }));
    const res = await putContact(fx.mainA._id, { poc: POC, whatsappSenderId: String(s._id) }, fx.a);
    assert.equal(res.status, 502);
    assert.equal(res.raw.includes('internal'), false, "Meta's response body is not passed on");
    const stored: any = await Event.findById(fx.mainA._id).lean();
    assert.deepEqual([stored.whatsappSenderId, stored.poc], [null, undefined], 'neither the sender nor the POC in the same request');
  });

  test('a never-checked status counts as stale', async () => {
    const s = await mkSender({ statusCheckedAt: null });
    meta.status.set(s.phoneNumberId, 'CONNECTED');
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(s._id) }, fx.a)).status, 200);
    assert.equal(meta.calls.length, 1);
  });

  test('a Super Admin may assign any eligible sender, without an allowlist entry', async () => {
    const s = await mkSender({ allowedAdminIds: [] });
    assert.equal((await putContact(fx.mainB._id, { whatsappSenderId: String(s._id) }, fx.super)).status, 200);
  });

  test('keeping a sender that has since become unavailable does not block a POC edit', async () => {
    const s = await mkSender();
    await putContact(fx.mainA._id, { whatsappSenderId: String(s._id) }, fx.a);
    await WhatsAppSender.updateOne({ _id: s._id }, { $set: { enabled: false } });
    const res = await putContact(fx.mainA._id, { poc: POC, whatsappSenderId: String(s._id) }, fx.a);
    assert.equal(res.status, 200);
    assert.equal(res.body.poc.name, 'Riya Sharma');
    assert.equal(res.body.effectiveSender.enabled, false, 'and the panel is told it is disabled');
    // A different unavailable sender is still refused.
    const other = await mkSender({ enabled: false });
    assert.equal((await putContact(fx.mainA._id, { whatsappSenderId: String(other._id) }, fx.a)).status, 409);
  });
});

describe('sender inventory: SuperAdmin only, synced from Meta, audited', () => {
  const firstPage = `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status&limit=100`;

  test('only a Super Admin can sync, change settings or refresh status', async () => {
    const s = await mkSender();
    for (const token of [fx.a, fx.uIn]) {
      assert.equal((await call('POST', '/api/whatsapp-senders/sync', token)).status, 403);
      assert.equal((await call('PATCH', `/api/whatsapp-senders/${s._id}`, token, { enabled: false })).status, 403);
      assert.equal((await call('POST', `/api/whatsapp-senders/${s._id}/refresh-status`, token)).status, 403);
    }
    assert.equal((await call('POST', '/api/whatsapp-senders/sync', null)).status, 401);
    assert.equal(meta.calls.length, 0);
    assert.equal((await WhatsAppSender.findById(s._id).lean()).enabled, true);
  });

  test('an Admin lists only senders allowed to them; a User sees none', async () => {
    await mkSender({ verifiedName: 'Mine' });
    await mkSender({ verifiedName: 'Theirs', allowedAdminIds: [fx.adminB._id] });
    await mkSender({ verifiedName: 'Disabled', enabled: false });
    const names = async (token: string) => (await call('GET', '/api/whatsapp-senders', token)).body.senders.map((s: any) => s.verifiedName).sort();
    assert.deepEqual(await names(fx.a), ['Mine']);
    assert.deepEqual(await names(fx.uIn), []);
    assert.equal((await names(fx.super)).length, 3);
  });

  test('sync: only numbers Meta returns, new ones disabled with no Admins, missing ones unlisted, audited', async () => {
    const gone = await mkSender({ verifiedName: 'Gone' });
    meta.pages.set(firstPage, { data: [
      { id: '300000000000001', display_phone_number: '+91 90000 00001', verified_name: 'New One', quality_rating: 'GREEN', status: 'CONNECTED' },
    ] });
    const res = await call('POST', '/api/whatsapp-senders/sync', fx.super);
    assert.equal(res.status, 200);
    const created: any = await WhatsAppSender.findOne({ phoneNumberId: '300000000000001' }).lean();
    assert.deepEqual([created.enabled, created.allowedAdminIds, created.listedInMeta], [false, [], true]);
    const missing: any = await WhatsAppSender.findById(gone._id).lean();
    assert.deepEqual([missing.listedInMeta, missing.enabled], [false, true], 'marked unlisted, never deleted');
    const entry: any = await AuditLog.findOne({ action: 'WHATSAPP_SENDERS_SYNCED' }).lean();
    assert.equal(entry.actor.role, 'SuperAdmin');
    assert.equal(entry.metadata.discovered, 1);
    assert.equal(res.raw.includes(FAKE_TOKEN), false);
  });

  test('sync refuses to follow a paging link to any host but Meta, so the token is never sent there', async () => {
    meta.pages.set(firstPage, { data: [], paging: { next: 'https://attacker.example/steal?after=1' } });
    const res = await call('POST', '/api/whatsapp-senders/sync', fx.super);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'Unable to sync senders from Meta.');
    assert.equal(meta.calls.every((c) => new URL(c.url).hostname === 'graph.facebook.com'), true);
    assert.equal(isMetaGraphUrl('https://graph.facebook.com/v22.0/x'), true);
    for (const bad of ['http://graph.facebook.com/x', 'https://graph.facebook.com.evil.example/x', 'https://evil.example/graph.facebook.com', 'not a url']) {
      assert.equal(isMetaGraphUrl(bad), false, bad);
    }
  });

  test('settings changes are validated and audited with before and after', async () => {
    const s = await mkSender({ enabled: false, allowedAdminIds: [] });
    const res = await call('PATCH', `/api/whatsapp-senders/${s._id}`, fx.super, { enabled: true, label: 'Wedding Team', allowedAdminIds: [String(fx.adminA._id)] });
    assert.equal(res.status, 200);
    const entry: any = await AuditLog.findOne({ action: 'WHATSAPP_SENDER_UPDATED' }).lean();
    assert.deepEqual([entry.changes.before.enabled, entry.changes.after.enabled], [false, true]);
    assert.equal(entry.documentId, String(s._id));
    assert.equal((await call('PATCH', `/api/whatsapp-senders/${s._id}`, fx.super, { allowedAdminIds: [String(fx.superAdmin._id)] })).status, 400, 'only Admin accounts');
    assert.equal((await call('PATCH', `/api/whatsapp-senders/${s._id}`, fx.super, { phoneNumberId: '1' })).status, 400, 'Meta identity cannot be edited');
  });

  test('contact changes are audited with a clean before and after, and no secrets', async () => {
    const s = await mkSender();
    await putContact(fx.subA._id, { poc: { name: 'Arjun Mehta', mobile: '9123456780' }, whatsappSenderId: String(s._id) }, fx.a);
    await putContact(fx.subA._id, { poc: null, whatsappSenderId: null }, fx.a);
    const entries: any[] = await AuditLog.find({ action: 'EVENT_CONTACT_SETTINGS_UPDATED' }).sort({ timestamp: 1 }).lean();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0].changes.before, { poc: null, whatsappSenderId: null }, 'no empty {} for a POC that was never set');
    assert.deepEqual(entries[0].changes.after, { poc: { name: 'Arjun Mehta', mobile: '+919123456780' }, whatsappSenderId: String(s._id) });
    assert.deepEqual(entries[1].changes.after, { poc: null, whatsappSenderId: null });
    assert.equal(entries[0].actor.role, 'Admin');
    assert.equal(entries[0].documentId, String(fx.subA._id));
    assert.equal(JSON.stringify(await AuditLog.find({}).lean()).includes(FAKE_TOKEN), false);
  });
});
