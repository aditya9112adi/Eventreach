import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * What a WhatsApp sender response shows to whom, over real HTTP against the
 * REAL compiled backend (backend/dist) on a throwaway local MongoDB database.
 *
 * A Super Admin sees a sender's Business Account id and its allowlist of
 * Admins. Any other caller - an allowlisted Admin included - gets the sender
 * without either, on every response that returns sender data: the list, the
 * update, and the event contact panel. Nothing here reaches Meta; a tripwire
 * on the shared HTTP client fails the suite if anything tries.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_senderprivacy_${Date.now()}`;
const WABA = '900000000000321';
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_WABA_ID = WABA;
delete process.env.WHATSAPP_TOKEN;

const axios = createRequire(require.resolve('../backend/dist/services/whatsappSenderSyncService'))('axios');
const real = { get: axios.get, post: axios.post, request: axios.request };
const wire: string[] = [];
for (const method of ['get', 'post', 'request'] as const) {
  axios[method] = (url: any) => { wire.push(`${method} ${typeof url === 'string' ? url : 'request'}`); return Promise.reject(new Error('tripwire: no outbound call is expected')); };
}

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const senderRoutes = require('../backend/dist/routes/whatsappSenderRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { WhatsAppSender } = require('../backend/dist/models/WhatsAppSender');

/** Everything an Admin needs from a sender, and nothing more. */
const ADMIN_FIELDS = ['_id', 'isEnvironmentSender', 'displayPhoneNumber', 'label', 'lastSyncedAt', 'listedInMeta', 'enabled', 'metaStatus', 'phoneNumberId', 'qualityRating', 'statusCheckedAt', 'verifiedName'].sort();
const SUPER_ONLY = ['allowedAdminIds', 'pocTestEnabled', 'wabaId'];

let server: any;
let baseUrl = '';
let ip = 0;
const fx: any = {};

const call = (method: string, p: string, token: string | null, body?: any): Promise<{ status: number; body: any; raw: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(payload)); }
    const url = new URL(baseUrl + p);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let parsed: any = null; try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; } resolve({ status: res.statusCode || 0, body: parsed, raw: data }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) => jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

before(async () => {
  await mongoose.connect(TEST_DB);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-sp@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminA = await Admin.create({ name: 'Admin A', email: 'a-sp@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.adminB = await Admin.create({ name: 'Admin B', email: 'b-sp@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.otherAllowed = await Admin.create({ name: 'Admin C', email: 'c-sp@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.sender = await WhatsAppSender.create({
    phoneNumberId: '300000000000999', wabaId: WABA, displayPhoneNumber: '+91 90000 00999', verifiedName: 'Wedding Team', label: 'Weddings',
    qualityRating: 'GREEN', metaStatus: 'CONNECTED', statusCheckedAt: new Date(), lastSyncedAt: new Date(), listedInMeta: true, enabled: true,
    allowedAdminIds: [fx.adminA._id, fx.otherAllowed._id],
  });
  fx.event = await Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName: 'A Wedding', eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'), eventVenue: 'Pune', eventStatus: 'Upcoming',
    adminId: fx.adminA._id, createdBy: fx.adminA._id, whatsappSenderId: fx.sender._id, poc: { name: 'Asha', mobile: '+919811111111' },
  });
  fx.user = await User.create({ name: 'User A', email: 'ua-sp@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminA._id, assignedEventId: fx.event._id });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');
  fx.u = tokenFor(fx.user, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp-senders', senderRoutes);
  app.use('/api/events', eventRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(axios, real);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(wire, [], 'no outbound call was attempted');
});

describe('the sender list', () => {
  test('a Super Admin sees the Business Account id and the allowlist', async () => {
    const res = await call('GET', '/api/whatsapp-senders', fx.super);
    assert.equal(res.status, 200, res.raw);
    const [sender] = res.body.senders;
    assert.equal(sender.wabaId, WABA);
    assert.deepEqual([...sender.allowedAdminIds].sort(), [String(fx.adminA._id), String(fx.otherAllowed._id)].sort());
    assert.deepEqual(Object.keys(sender).sort(), [...ADMIN_FIELDS, ...SUPER_ONLY].sort(), 'the Super Admin view is the full one');
  });

  test('an allowlisted Admin gets everything they need, but neither the account id nor the allowlist', async () => {
    const res = await call('GET', '/api/whatsapp-senders', fx.a);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.senders.length, 1);
    const [sender] = res.body.senders;
    assert.deepEqual(Object.keys(sender).sort(), ADMIN_FIELDS);
    for (const field of SUPER_ONLY) assert.equal(field in sender, false, `${field} is not shown to an Admin`);
    assert.equal(sender.displayPhoneNumber, '+91 90000 00999');
    assert.equal(sender.verifiedName, 'Wedding Team');
    assert.equal(sender.metaStatus, 'CONNECTED');
    assert.equal(sender.enabled, true);
    assert.equal(sender.listedInMeta, true);
    assert.equal(sender.label, 'Weddings');
    // Nowhere in the body: not the account id, and not any Admin's id (their own included).
    for (const secret of [WABA, String(fx.adminA._id), String(fx.otherAllowed._id), String(fx.adminB._id)]) assert.equal(res.raw.includes(secret), false, `${secret} must not appear`);
  });

  test('an Admin who is not allowlisted, and a User, see no senders at all', async () => {
    for (const token of [fx.b, fx.u]) {
      const res = await call('GET', '/api/whatsapp-senders', token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.senders, []);
    }
  });
});

describe('the sender update', () => {
  test('a Super Admin gets the full view back', async () => {
    const res = await call('PATCH', `/api/whatsapp-senders/${fx.sender._id}`, fx.super, { label: 'Weddings' });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.sender.wabaId, WABA);
    assert.equal(res.body.sender.allowedAdminIds.length, 2);
  });

  test('an Admin cannot update a sender, and the refusal carries no sender data', async () => {
    const res = await call('PATCH', `/api/whatsapp-senders/${fx.sender._id}`, fx.a, { label: 'Mine' });
    assert.equal(res.status, 403);
    assert.equal(res.body.sender, undefined);
    assert.equal(res.raw.includes(WABA), false);
    assert.equal(((await WhatsAppSender.findById(fx.sender._id).lean()) as any).label, 'Weddings');
  });

  test('the Super Admin-only actions stay Super Admin-only', async () => {
    for (const [method, path] of [['POST', '/api/whatsapp-senders/sync'], ['POST', `/api/whatsapp-senders/${fx.sender._id}/refresh-status`]] as const) {
      const res = await call(method, path, fx.a);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.raw.includes(WABA), false);
    }
  });
});

describe('the sender shown on an event', () => {
  test('the event contact panel never carries the account id or the allowlist, for any role', async () => {
    for (const token of [fx.a, fx.super]) {
      const res = await call('GET', `/api/events/${fx.event._id}/contact`, token);
      assert.equal(res.status, 200, res.raw);
      const sender = res.body.effectiveSender;
      assert.equal(sender.displayPhoneNumber, '+91 90000 00999');
      for (const field of SUPER_ONLY) assert.equal(field in sender, false, `${field} is not in the contact panel`);
      assert.equal(res.raw.includes(WABA), false);
    }
  });

  test('saving the contact settings returns the same private summary', async () => {
    const res = await call('PUT', `/api/events/${fx.event._id}/contact`, fx.a, { poc: { name: 'Asha', mobile: '+919811111111', responsibility: 'Venue' } });
    assert.equal(res.status, 200, res.raw);
    for (const field of SUPER_ONLY) assert.equal(field in res.body.effectiveSender, false);
    assert.equal(res.raw.includes(WABA), false);
    assert.equal(res.raw.includes(String(fx.otherAllowed._id)), false);
  });

  test("another Admin cannot read this event's contact panel at all", async () => {
    const res = await call('GET', `/api/events/${fx.event._id}/contact`, fx.b);
    assert.equal(res.status, 403);
    assert.equal(res.body.effectiveSender, undefined);
  });
});
