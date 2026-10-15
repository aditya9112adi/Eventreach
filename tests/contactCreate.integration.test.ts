import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Adding and editing a guest over real HTTP, against the REAL compiled backend
 * (backend/dist) on a throwaway database: what each refusal says, that a
 * duplicate is never reported as anything else (or the reverse), and that two
 * requests for the same new number leave exactly one guest.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_contactcreate_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const contactRoutes = require('../backend/dist/routes/contactRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');

const DUPLICATE = "This contact already exists in this event's guest list.";
const INVALID = 'Please enter a valid WhatsApp number.';
const ADD_FAILED = 'Unable to add contact right now. Please try again.';
const UPDATE_FAILED = 'Unable to update contact right now. Please try again.';

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
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
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

const makeEvent = (name: string, adminId: any) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName: name, eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', adminId, createdBy: adminId,
  });

const guest = (over: Record<string, unknown> = {}) => ({
  fullName: 'Aditya Shankar Kshirsagar', phoneNumber: '9112472833', countryCode: 'IN', email: 'guest@gmail.com', eventId: String(fx.eventA._id), ...over,
});
const add = (body: Record<string, unknown> = {}, token = fx.a) => call('POST', '/api/contacts', token, guest(body));

before(async () => {
  await mongoose.connect(TEST_DB);
  await Contact.init(); // the unique index must exist: it is what the concurrency test relies on
  const base = { passwordHash: 'x', status: 'Active', role: 'Admin' };
  fx.adminA = await Admin.create({ ...base, name: 'A', email: 'a-cc@example.com' });
  fx.adminB = await Admin.create({ ...base, name: 'B', email: 'b-cc@example.com' });
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');
  fx.eventA = await makeEvent('Wedding A', fx.adminA._id);
  fx.eventA2 = await makeEvent('Wedding A2', fx.adminA._id);
  fx.eventB = await makeEvent('Wedding B', fx.adminB._id);

  const app = express();
  app.use(express.json());
  app.use('/api/contacts', contactRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  await Contact.deleteMany({});
});

describe('adding a guest', () => {
  test('a new guest is created: 201, stored as the normalised number, status Valid', async () => {
    const res = await add();
    assert.equal(res.status, 201);
    assert.equal(res.body.phoneNumber, '+919112472833');
    assert.equal(res.body.status, 'Valid');
    assert.equal(res.body.source, 'Manual');
    assert.equal(await Contact.countDocuments(), 1);
  });

  test('the same number again: 409 CONTACT_DUPLICATE with the duplicate message - and nothing is added', async () => {
    assert.equal((await add()).status, 201);
    const again = await add({ fullName: 'Someone Else', email: 'other@gmail.com' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'CONTACT_DUPLICATE');
    assert.equal(again.body.error, DUPLICATE);
    assert.equal(again.body.field, 'phoneNumber');
    assert.equal(await Contact.countDocuments(), 1);
    assert.equal((await Contact.findOne({})).fullName, 'Aditya Shankar Kshirsagar', 'the existing guest is untouched');
  });

  test('every way of writing the same number is the same guest', async () => {
    assert.equal((await add({ phoneNumber: '9112472833' })).status, 201);
    for (const variant of ['+91 91124 72833', '919112472833', '+919112472833', '09112472833', '91124 72833']) {
      const res = await add({ phoneNumber: variant });
      assert.equal(res.status, 409, variant);
      assert.equal(res.body.code, 'CONTACT_DUPLICATE', variant);
    }
    assert.equal(await Contact.countDocuments(), 1);
  });

  test('a duplicate is per event: the same number in another event is a different guest', async () => {
    assert.equal((await add()).status, 201);
    assert.equal((await add({ eventId: String(fx.eventA2._id) })).status, 201);
    assert.equal(await Contact.countDocuments(), 2);
  });

  test('email is not unique: two guests may share an address, and no email-duplicate error exists', async () => {
    assert.equal((await add({ phoneNumber: '9112472833', email: 'shared@gmail.com' })).status, 201);
    const second = await add({ phoneNumber: '9876543210', email: 'shared@gmail.com' });
    assert.equal(second.status, 201);
    assert.equal(await Contact.countDocuments(), 2);
  });

  test('there is no limit on how many guests an event can hold', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await add({ phoneNumber: `98765${String(10000 + i)}`, fullName: `Guest ${i}` });
      assert.equal(res.status, 201, `guest ${i}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(await Contact.countDocuments(), 25);
  });

  test('an unusable number: 400 INVALID_PHONE with its message, and nothing is added', async () => {
    for (const phoneNumber of ['12345', '0000000000', 'abcdefghij', '+91+919112472833', '5112472833']) {
      const res = await add({ phoneNumber });
      assert.equal(res.status, 400, phoneNumber);
      assert.equal(res.body.code, 'INVALID_PHONE', phoneNumber);
      assert.equal(res.body.error, INVALID, phoneNumber);
      assert.equal(res.body.field, 'phoneNumber');
      assert.equal(typeof res.body.detail, 'string', 'the specific reason travels separately');
    }
    assert.equal(await Contact.countDocuments(), 0);
  });

  test('other validation errors keep their own message, and are not reported as a duplicate or a phone problem', async () => {
    const noName = await add({ fullName: '' });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.error, 'Full name is required');
    assert.notEqual(noName.body.code, 'CONTACT_DUPLICATE');
    const badEmail = await add({ email: 'not-an-email' });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.error, 'Invalid email address');
    const noEvent = await call('POST', '/api/contacts', fx.a, { ...guest(), eventId: undefined });
    assert.equal(noEvent.status, 400);
  });

  test('authorization is unchanged: no token 401, someone else\'s event 403 - even for a number that would be a duplicate', async () => {
    assert.equal((await add({}, null as any)).status, 401);
    assert.equal((await add({ eventId: String(fx.eventB._id) }, fx.a)).status, 403);
    await Contact.create({ fullName: 'Existing', phoneNumber: '+919112472833', countryCode: 'IN', eventId: fx.eventB._id, status: 'Valid', source: 'Manual' });
    const probe = await add({ eventId: String(fx.eventB._id) }, fx.a);
    assert.equal(probe.status, 403, 'a stranger learns nothing about another event\'s guests');
    assert.equal(probe.body.code, undefined);
  });
});

describe('unexpected failures', () => {
  test('a database failure is a fixed "try again" message - no exception text, no internals - and nothing is added', async () => {
    const original = Contact.create;
    Contact.create = () => { throw new Error('SECRET internal detail: mongodb://user:pw@host/db'); };
    try {
      const res = await add();
      assert.equal(res.status, 500);
      assert.equal(res.body.code, 'CONTACT_SAVE_FAILED');
      assert.equal(res.body.error, ADD_FAILED);
      assert.equal(res.raw.includes('SECRET'), false);
      assert.equal(res.raw.includes('mongodb'), false);
    } finally {
      Contact.create = original;
    }
    assert.equal(await Contact.countDocuments(), 0);
  });

  test('a failing duplicate check is also just "try again", never "duplicate"', async () => {
    const original = Contact.exists;
    Contact.exists = () => { throw new Error('boom'); };
    try {
      const res = await add();
      assert.equal(res.status, 500);
      assert.equal(res.body.error, ADD_FAILED);
      assert.notEqual(res.body.code, 'CONTACT_DUPLICATE');
    } finally {
      Contact.exists = original;
    }
  });
});

describe('concurrent submissions', () => {
  test('twelve simultaneous requests for the same new number leave exactly one guest: one 201, eleven 409, no 500', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => add()));
    const by = (status: number) => results.filter((r) => r.status === status).length;
    assert.equal(by(201), 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(by(409), 11);
    assert.equal(by(500), 0, 'a lost race is a duplicate, not a server error');
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.code === 'CONTACT_DUPLICATE' && r.body.error === DUPLICATE));
    assert.equal(await Contact.countDocuments(), 1);
  });

  test('the unique index alone is enough: when the early check misses (the race), the database refusal is still a clean 409', async () => {
    await Contact.create({ fullName: 'First', phoneNumber: '+919112472833', countryCode: 'IN', eventId: fx.eventA._id, status: 'Valid', source: 'Manual' });
    const original = Contact.exists;
    Contact.exists = async () => null; // both requests "saw" no existing guest
    try {
      const res = await add();
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'CONTACT_DUPLICATE');
      assert.equal(res.body.error, DUPLICATE);
    } finally {
      Contact.exists = original;
    }
    assert.equal(await Contact.countDocuments(), 1);
  });
});

describe('editing a guest (same defect, same fix)', () => {
  test('changing to another guest\'s number is a 409 duplicate; keeping your own number, or a new one, works', async () => {
    const one = (await add({ phoneNumber: '9112472833' })).body;
    const two = (await add({ phoneNumber: '9876543210', fullName: 'Second Guest' })).body;

    const clash = await call('PUT', `/api/contacts/${two._id}`, fx.a, { fullName: 'Second Guest', phoneNumber: '9112472833', countryCode: 'IN' });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.code, 'CONTACT_DUPLICATE');
    assert.equal(clash.body.error, DUPLICATE);
    assert.equal((await Contact.findById(two._id)).phoneNumber, '+919876543210', 'unchanged');

    const rename = await call('PUT', `/api/contacts/${one._id}`, fx.a, { fullName: 'Renamed', phoneNumber: '+91 91124 72833', countryCode: 'IN' });
    assert.equal(rename.status, 200, 'saving a guest with their own number is not a duplicate');
    const moved = await call('PUT', `/api/contacts/${two._id}`, fx.a, { fullName: 'Second Guest', phoneNumber: '9123456780', countryCode: 'IN' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.phoneNumber, '+919123456780');
  });

  test('an invalid number and a failure keep their own messages', async () => {
    const one = (await add()).body;
    const invalid = await call('PUT', `/api/contacts/${one._id}`, fx.a, { fullName: 'X', phoneNumber: '123', countryCode: 'IN' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_PHONE');
    assert.equal(invalid.body.error, INVALID);

    const original = Contact.findByIdAndUpdate;
    Contact.findByIdAndUpdate = () => { throw new Error('SECRET'); };
    try {
      const failed = await call('PUT', `/api/contacts/${one._id}`, fx.a, { fullName: 'X', phoneNumber: '9123456780', countryCode: 'IN' });
      assert.equal(failed.status, 500);
      assert.equal(failed.body.error, UPDATE_FAILED);
      assert.equal(failed.raw.includes('SECRET'), false);
    } finally {
      Contact.findByIdAndUpdate = original;
    }
  });

  test('another Admin cannot edit it (403)', async () => {
    const one = (await add()).body;
    assert.equal((await call('PUT', `/api/contacts/${one._id}`, fx.b, { fullName: 'X', phoneNumber: '9123456780', countryCode: 'IN' })).status, 403);
  });
});
