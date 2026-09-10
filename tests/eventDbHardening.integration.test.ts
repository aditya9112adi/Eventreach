import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Event DB hardening — end-to-end against the REAL compiled backend
 * (routes + controllers + Mongoose models from backend/dist) on a throwaway
 * local database. Run `npm run build` in backend/ first, with a mongod on
 * 127.0.0.1:27017.
 *
 * Covers the checklist in the request: Event ID auto-generation, uniqueness,
 * persistence, immutability, and that MongoDB/Mongoose reject invalid data even
 * when the UI is bypassed and the API is called directly.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_evt_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.FRONTEND_URL = 'http://localhost:5173';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.RESEND_API_KEY;

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const { Event } = require('../backend/dist/models/Event');
const { Counter } = require('../backend/dist/models/Counter');
const { Admin } = require('../backend/dist/models/Admin');

const GOOD_PASSWORD = 'TestPass123';

let server: any;
let baseUrl = '';
let ipCounter = 0;

const call = (
  method: string,
  path: string,
  opts: { body?: any; token?: string } = {}
): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const headers: Record<string, string> = {
      'CF-Connecting-IP': `203.0.113.${(ipCounter++ % 250) + 1}`,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const jwt = require('jsonwebtoken');
let adminToken = '';

const futureDate = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
};

const validEvent = (over: Record<string, any> = {}) => ({
  organizerName: 'Asha Menon',
  organizerMobile: '9112472833',
  eventName: 'Wedding',
  eventType: 'Wedding',
  eventDate: futureDate(),
  eventTime: '12:42',
  eventVenue: 'Grand Hall',
  eventDescription: 'A lovely event',
  ...over,
});

before(async () => {
  await mongoose.connect(TEST_DB);

  const admin = await Admin.create({
    name: 'Admin', email: 'admin@example.com',
    passwordHash: await bcrypt.hash(GOOD_PASSWORD, 10),
    role: 'Admin', status: 'Active', accessGrantedOn: new Date(),
  });
  adminToken = jwt.sign({ id: admin._id, email: admin.email, role: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/events', eventRoutes);
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
  await Event.deleteMany({});
  await Counter.deleteMany({});
});

describe('Event ID generation', () => {
  test('a new event automatically receives an EVT-NNNNNN id', async () => {
    const res = await call('POST', '/api/events', { token: adminToken, body: validEvent() });
    assert.equal(res.status, 201);
    assert.match(res.body.eventId, /^EVT-\d{6,}$/);

    const stored = await Event.findById(res.body._id).lean();
    assert.equal(stored.eventId, res.body.eventId, 'eventId is persisted in MongoDB');
  });

  test('50 simultaneous creates all get a unique, well-formed, gapless id', async () => {
    const N = 50;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        call('POST', '/api/events', { token: adminToken, body: validEvent({ eventName: `Event ${i}` }) })
      )
    );

    assert.ok(created.every((r) => r.status === 201), 'every create succeeded');
    const ids = created.map((r) => r.body.eventId);
    assert.ok(ids.every((id) => /^EVT-\d{6,}$/.test(id)), 'all well-formed');
    assert.equal(new Set(ids).size, N, 'no duplicates under concurrency');

    // Every document actually persisted its own id — nothing was overwritten.
    const stored = await Event.find({}).select('eventId').lean();
    assert.equal(new Set(stored.map((e: any) => e.eventId)).size, stored.length, 'stored ids unique');

    // The counter handed out one unbroken run of sequence numbers.
    const seqs = ids.map((id: string) => parseInt(id.slice(4), 10)).sort((a, b) => a - b);
    assert.equal(seqs[seqs.length - 1] - seqs[0], N - 1, 'sequence is contiguous — none skipped or reused');

    const counter = await Counter.findById('events').lean();
    assert.equal((counter as any).seq, seqs[seqs.length - 1], 'counter matches the highest id issued');
  });

  test('the client cannot choose or overwrite the eventId', async () => {
    const create = await call('POST', '/api/events', {
      token: adminToken,
      body: validEvent({ eventId: 'EVT-999999' }),
    });
    assert.equal(create.status, 201);
    assert.notEqual(create.body.eventId, 'EVT-999999', 'supplied eventId is ignored');

    const forgedUpdate = await call('PUT', `/api/events/${create.body._id}`, {
      token: adminToken,
      body: validEvent({ eventId: 'EVT-000042', eventName: 'Renamed' }),
    });
    assert.equal(forgedUpdate.status, 200);
    assert.equal(forgedUpdate.body.eventId, create.body.eventId, 'eventId is immutable on update');
  });

  test('a direct duplicate eventId insert is rejected by the unique index', async () => {
    await Event.init(); // ensure indexes are built
    const first = await call('POST', '/api/events', { token: adminToken, body: validEvent() });
    const dupId = first.body.eventId;

    await assert.rejects(
      Event.collection.insertOne({
        eventId: dupId,
        organizerName: 'X', organizerMobile: '9000000000',
        eventName: 'Dup', eventType: 'Dup',
        eventDate: new Date(), eventTime: 600, eventVenue: 'V',
        eventStatus: 'Upcoming', createdAt: new Date(), updatedAt: new Date(),
      }),
      /duplicate key/i
    );
  });
});

describe('MongoDB is the second validation layer (UI bypassed, API called directly)', () => {
  const cases: Array<[string, Record<string, any>, RegExp]> = [
    ['organizer name over 50 chars', { organizerName: 'x'.repeat(51) }, /50 characters/i],
    ['mobile not 10 digits', { organizerMobile: '12345' }, /10 digits/i],
    ['mobile with country code', { organizerMobile: '+919112472833' }, /10 digits/i],
    ['mobile with letters', { organizerMobile: '91124728ab' }, /10 digits/i],
    ['event name over 20 chars', { eventName: 'x'.repeat(21) }, /20 characters/i],
    ['event type over 20 chars', { eventType: 'x'.repeat(21) }, /20 characters/i],
    ['venue over 50 chars', { eventVenue: 'x'.repeat(51) }, /50 characters/i],
    ['description over 256 chars', { eventDescription: 'x'.repeat(257) }, /256 characters/i],
    ['missing organizer name', { organizerName: '' }, /required/i],
    ['bad time format', { eventTime: '25:99' }, /HH:MM|time/i],
  ];

  for (const [label, override, expected] of cases) {
    test(`rejects: ${label}`, async () => {
      const res = await call('POST', '/api/events', { token: adminToken, body: validEvent(override) });
      assert.equal(res.status, 400, `${label} must be a 400`);
      assert.match(res.body.error, expected);
      assert.equal(await Event.countDocuments({}), 0, 'nothing was written');
    });
  }

  test('Mongoose rejects an over-limit organizer name even if the API layer is skipped', async () => {
    await assert.rejects(
      Event.create({
        organizerName: 'x'.repeat(51),
        organizerMobile: '9112472833',
        eventName: 'Wedding', eventType: 'Wedding',
        eventDate: new Date(), eventTime: 600, eventVenue: 'Hall',
        eventStatus: 'Upcoming',
      }),
      /is longer than the maximum allowed length|maxlength/i
    );
  });
});

describe('Correct BSON types on stored documents', () => {
  test('organizerMobile is a String and eventTime is an integer in the raw document', async () => {
    const res = await call('POST', '/api/events', {
      token: adminToken,
      body: validEvent({ organizerMobile: '9766813161', eventTime: '18:15' }),
    });
    const raw = await mongoose.connection.db.collection('events').findOne({ _id: new mongoose.Types.ObjectId(res.body._id) });
    assert.equal(typeof raw.organizerMobile, 'string');
    assert.equal(raw.organizerMobile, '9766813161');
    assert.equal(Number.isInteger(raw.eventTime), true);
    assert.equal(raw.eventTime, 18 * 60 + 15); // 1095, matches the screenshot value
    assert.ok(raw.eventDate instanceof Date);
  });

  test('the API still returns mobile and time as strings (unchanged contract)', async () => {
    const res = await call('POST', '/api/events', {
      token: adminToken,
      body: validEvent({ organizerMobile: '7939729889', eventTime: '19:10' }),
    });
    assert.equal(res.body.organizerMobile, '7939729889');
    assert.equal(res.body.eventTime, '19:10');

    const list = await call('GET', '/api/events', { token: adminToken });
    const mine = list.body.find((e: any) => e._id === res.body._id);
    assert.equal(mine.organizerMobile, '7939729889');
    assert.equal(mine.eventTime, '19:10');
    assert.match(mine.eventId, /^EVT-\d{6,}$/, 'eventId is included in the list response for search/display');
  });
});
