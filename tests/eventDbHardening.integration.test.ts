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
        eventDate: new Date(), eventTime: new Date(), eventVenue: 'V',
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
        eventDate: new Date(), eventTime: new Date(), eventVenue: 'Hall',
        eventStatus: 'Upcoming',
      }),
      /is longer than the maximum allowed length|maxlength/i
    );
  });
});

describe('Event Type: a listed option or a custom type, stored as given in eventType', () => {
  const create = (eventType: unknown) => call('POST', '/api/events', { token: adminToken, body: validEvent({ eventType }) });

  test('a listed option is stored as chosen', async () => {
    const res = await create('Corporate Event');
    assert.equal(res.status, 201);
    assert.equal(res.body.eventType, 'Corporate Event');
  });

  test('a custom type (chosen through "Other") is stored as typed, trimmed', async () => {
    const res = await create('  Product Launch  ');
    assert.equal(res.status, 201);
    assert.equal(res.body.eventType, 'Product Launch');
    const raw = await mongoose.connection.db.collection('events').findOne({ _id: new mongoose.Types.ObjectId(res.body._id) });
    assert.equal(raw.eventType, 'Product Launch', 'the same eventType field - nothing new is stored');
    assert.equal('customEventType' in raw, false);
  });

  test('an empty or whitespace-only type is a 400, never a 500', async () => {
    for (const blank of ['', '   ']) {
      const res = await create(blank);
      assert.equal(res.status, 400, JSON.stringify(blank));
      assert.match(res.body.error, /Event Type is required/);
    }
    assert.equal(await Event.countDocuments({}), 0, 'nothing was written');
  });

  test('the 20-character limit is unchanged', async () => {
    assert.equal((await create('x'.repeat(20))).status, 201);
    const over = await create('x'.repeat(21));
    assert.equal(over.status, 400);
    assert.match(over.body.error, /Event Type max 20 characters/);
  });

  test('existing free-text types keep working, and an edit can switch between option and custom', async () => {
    const legacy = await create('farewell');
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.eventType, 'farewell', 'not rewritten');
    const toCustom = await call('PUT', `/api/events/${legacy.body._id}`, { token: adminToken, body: validEvent({ eventType: 'Product Launch' }) });
    assert.equal(toCustom.status, 200);
    assert.equal(toCustom.body.eventType, 'Product Launch');
    const toOption = await call('PUT', `/api/events/${legacy.body._id}`, { token: adminToken, body: validEvent({ eventType: 'Seminar' }) });
    assert.equal(toOption.body.eventType, 'Seminar');
    const blank = await call('PUT', `/api/events/${legacy.body._id}`, { token: adminToken, body: validEvent({ eventType: '  ' }) });
    assert.equal(blank.status, 400);
    assert.equal((await Event.findById(legacy.body._id).lean()).eventType, 'Seminar', 'a refused edit changes nothing');
  });
});

describe('Events list order: newest-created first', () => {
  let tokenX = '';
  let tokenY = '';
  let adminX: any;
  let adminY: any;

  before(async () => {
    adminX = await Admin.create({ name: 'Order X', email: 'order-x@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', accessGrantedOn: new Date() });
    adminY = await Admin.create({ name: 'Order Y', email: 'order-y@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', accessGrantedOn: new Date() });
    tokenX = jwt.sign({ id: adminX._id, email: adminX.email, role: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });
    tokenY = jwt.sign({ id: adminY._id, email: adminY.email, role: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });
  });

  /** An event created at `createdAt` (undefined: stored without one), scheduled on `eventDate`. */
  const mk = async (eventName: string, createdAt: string | undefined, eventDate: string, owner: any, extra: Record<string, any> = {}) => {
    const doc = await Event.create({
      organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
      eventDate: new Date(`${eventDate}T00:00:00.000Z`), eventTime: new Date(`${eventDate}T06:00:00.000Z`),
      eventVenue: 'Hall', eventStatus: 'Upcoming', adminId: owner._id, ...extra,
    });
    await Event.collection.updateOne(
      { _id: doc._id },
      createdAt ? { $set: { createdAt: new Date(createdAt) } } : { $unset: { createdAt: 1 } }
    );
    return doc;
  };
  const names = (res: { body: any[] }) => res.body.map((e) => e.eventName);
  const list = (query = '', token = tokenX) => call('GET', `/api/events${query}`, { token });

  test('a more recently created event comes first, whatever its scheduled date', async () => {
    await mk('Created First', '2026-10-01T06:00:00Z', '2027-06-01', adminX);
    await mk('Created Third', '2026-10-05T06:00:00Z', '2027-01-01', adminX); // scheduled earliest
    await mk('Created Second', '2026-10-03T06:00:00Z', '2028-01-01', adminX); // scheduled latest
    const res = await list();
    assert.equal(res.status, 200);
    assert.deepEqual(names(res), ['Created Third', 'Created Second', 'Created First']);
  });

  test('equal creation times are ordered by _id, newest first, on every request', async () => {
    const same = '2026-10-07T06:00:00Z';
    const earlier = await mk('Tie Earlier Id', same, '2027-01-01', adminX);
    const later = await mk('Tie Later Id', same, '2027-01-01', adminX);
    assert.ok(String(later._id) > String(earlier._id));
    await mk('Older', '2026-10-01T06:00:00Z', '2027-01-01', adminX);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(names(await list()), ['Tie Later Id', 'Tie Earlier Id', 'Older']);
    }
  });

  test('an event stored without createdAt is listed, after every dated one', async () => {
    await mk('Legacy Undated', undefined, '2027-01-01', adminX);
    await mk('Dated', '2026-10-01T06:00:00Z', '2027-01-01', adminX);
    assert.deepEqual(names(await list()), ['Dated', 'Legacy Undated']);
  });

  test('the date-range filter keeps the creation order', async () => {
    await mk('In Range Old', '2026-10-01T06:00:00Z', '2027-03-20', adminX);
    await mk('Out Of Range New', '2026-10-09T06:00:00Z', '2027-08-01', adminX);
    await mk('In Range New', '2026-10-05T06:00:00Z', '2027-03-02', adminX);
    const res = await list('?startDate=2027-03-01&endDate=2027-03-31');
    assert.equal(res.status, 200);
    assert.deepEqual(names(res), ['In Range New', 'In Range Old']);
  });

  test('each organizer sees only their own events, in the same order', async () => {
    await mk('X Older', '2026-10-01T06:00:00Z', '2027-01-01', adminX);
    await mk('Y Newest', '2026-10-09T06:00:00Z', '2027-01-01', adminY);
    await mk('X Newer', '2026-10-05T06:00:00Z', '2027-01-01', adminX);
    assert.deepEqual(names(await list()), ['X Newer', 'X Older']);
    assert.deepEqual(names(await list('', tokenY)), ['Y Newest']);
  });

  test('sub-events keep their own listing rules', async () => {
    const wedding = await mk('Wedding Main', '2026-10-01T06:00:00Z', '2027-01-20', adminX);
    await mk('Reception', '2026-10-08T06:00:00Z', '2027-01-21', adminX, { parentEventId: wedding._id });
    await mk('Haldi', '2026-10-06T06:00:00Z', '2027-01-18', adminX, { parentEventId: wedding._id });
    await mk('Party Main', '2026-10-04T06:00:00Z', '2027-02-01', adminX);

    assert.deepEqual(names(await list()), ['Party Main', 'Wedding Main'], 'the Events tab: Main Events only, newest-created first');
    assert.deepEqual(names(await list('?includeSubEvents=true')), ['Reception', 'Haldi', 'Party Main', 'Wedding Main'], 'with sub-events: the same order');
    assert.deepEqual(names(await list(`?parentEventId=${wedding._id}`)), ['Haldi', 'Reception'], 'a Main Event\'s sub-events: its schedule, by date');
  });
});

describe('Correct BSON types on stored documents', () => {
  test('organizerMobile is BSON Int64 and eventTime is BSON Date in the raw document', async () => {
    const date = futureDate();
    const res = await call('POST', '/api/events', {
      token: adminToken,
      body: validEvent({ eventDate: date, organizerMobile: '9766813161', eventTime: '18:15' }),
    });
    const _id = new mongoose.Types.ObjectId(res.body._id);

    // $type reports the actual BSON type on the server, not the driver's
    // JS representation — this is what proves organizerMobile is a long
    // (not a double) and eventTime a date (not an Int32 minute count).
    const [{ mobileType, timeType }] = await mongoose.connection.db.collection('events')
      .aggregate([{ $match: { _id } }, { $project: {
        mobileType: { $type: '$organizerMobile' }, timeType: { $type: '$eventTime' },
      } }]).toArray();
    assert.equal(mobileType, 'long', 'organizerMobile must be BSON Int64');
    assert.equal(timeType, 'date', 'eventTime must be BSON Date');

    const raw = await mongoose.connection.db.collection('events').findOne({ _id });
    assert.equal(String(raw.organizerMobile), '9766813161');
    assert.ok(raw.eventTime instanceof Date);
    // eventTime is the complete event instant (IST, UTC+5:30) — 18:15 on the
    // submitted date, not just the 18:15 time-of-day in isolation.
    assert.equal(raw.eventTime.toISOString(), new Date(`${date}T18:15:00+05:30`).toISOString());
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
