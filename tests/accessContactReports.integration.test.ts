import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * The Access and Contact Reports scoped to one event, over real HTTP against
 * the REAL compiled backend (routes, middleware, controllers, models from
 * backend/dist) on a throwaway database.
 *
 *   GET /api/admin/users/access-records?eventId=&startDate=&endDate=
 *   GET /api/contacts?eventId=&startDate=&endDate=
 *
 * The event scope is applied by the server, after it has authorized the
 * caller for that event; these tests show the other events' records never
 * leave it, whoever asks and however the request is edited.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_accesscontact_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const contactRoutes = require('../backend/dist/routes/contactRoutes').default;
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');

let server: any;
let baseUrl = '';

const get = (path: string, token?: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const at = (iso: string) => new Date(`${iso}T06:00:00.000Z`);
const RANGE = 'startDate=2026-10-01&endDate=2026-10-31';

const fx: any = {};

const mkAdmin = (name: string, role: string, granted?: string) =>
  Admin.create({
    name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`, passwordHash: 'x',
    role, status: 'Active', ...(granted ? { accessGrantedOn: at(granted) } : {}),
  });

const mkUser = (name: string, extra: Record<string, any>) =>
  User.create({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`, passwordHash: 'x', status: 'Active', ...extra });

const mkEvent = (eventName: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Party',
    eventDate: at('2026-10-15'), eventTime: at('2026-10-15'), eventVenue: 'Hall', eventStatus: 'Upcoming', ...extra,
  });

let phoneSeq = 0;
const mkContact = async (event: any, fullName: string, created: string) => {
  const doc = await Contact.create({
    fullName, phoneNumber: `+9190000${String(100000 + phoneSeq++)}`, countryCode: 'IN',
    eventId: event._id, source: 'Manual', status: 'Valid',
  });
  await Contact.collection.updateOne({ _id: doc._id }, { $set: { createdAt: at(created) } });
  return doc;
};

before(async () => {
  await mongoose.connect(TEST_DB);

  fx.superAdmin = await mkAdmin('Super', 'SuperAdmin', '2026-09-01');
  fx.adminX = await mkAdmin('Admin X', 'Admin', '2026-10-02');
  fx.adminY = await mkAdmin('Admin Y', 'Admin', '2026-10-03');
  fx.adminZ = await mkAdmin('Admin Z', 'Admin', '2026-10-04');

  fx.A = await mkEvent('Annual Tech Fest', { adminId: fx.adminX._id, createdBy: fx.superAdmin._id });
  fx.B = await mkEvent('Beta Conference', { adminId: fx.adminY._id, createdBy: fx.superAdmin._id });
  fx.C = await mkEvent('Quiet Gathering', { createdBy: fx.superAdmin._id });

  // A: three Users assigned by assignedEventId, one through the event's own list.
  fx.uA1 = await mkUser('Rahul A1', { adminId: fx.adminX._id, assignedEventId: fx.A._id, accessGrantedOn: at('2026-10-01') });
  fx.uA2 = await mkUser('Priya A2', { adminId: fx.adminX._id, assignedEventId: fx.A._id, accessGrantedOn: at('2026-10-02') });
  fx.uA3 = await mkUser('Amit A3', { adminId: fx.adminX._id, assignedEventId: fx.A._id, accessGrantedOn: at('2026-10-10') });
  fx.uA4 = await mkUser('Listed A4', { adminId: fx.adminX._id, accessGrantedOn: at('2026-10-05') });
  await Event.updateOne({ _id: fx.A._id }, { $set: { assignedUserIds: [fx.uA4._id] } });
  // Pending: assigned to A but never granted access, so not an access record.
  await mkUser('Pending A5', { adminId: fx.adminX._id, assignedEventId: fx.A._id, status: 'Pending' });

  // B: two Users managed by Admin Y.
  fx.uB1 = await mkUser('Bina B1', { adminId: fx.adminY._id, assignedEventId: fx.B._id, accessGrantedOn: at('2026-10-02') });
  fx.uB2 = await mkUser('Bobby B2', { adminId: fx.adminY._id, assignedEventId: fx.B._id, accessGrantedOn: at('2026-10-03') });

  await mkContact(fx.A, 'Contact A1', '2026-10-01');
  await mkContact(fx.A, 'Contact A2', '2026-10-02');
  await mkContact(fx.A, 'Contact A3', '2026-10-10');
  await mkContact(fx.B, 'Contact B1', '2026-10-02');
  await mkContact(fx.B, 'Contact B2', '2026-10-03');

  fx.superToken = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.xToken = tokenFor(fx.adminX, 'Admin');
  fx.uA1Token = tokenFor(fx.uA1, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
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

const access = (query: string, token = fx.superToken) => get(`/api/admin/users/access-records?${query}`, token);
const contacts = (query: string, token = fx.superToken) => get(`/api/contacts?${query}`, token);
const names = (res: { body: any }) => res.body.map((r: any) => r.name ?? r.fullName).sort();

// ─────────────────────────────────────────────────────────────────────────────

describe('Access Report for one event', () => {
  test('Event A: only the Users and the Admin who can reach Event A', async () => {
    const res = await access(`${RANGE}&eventId=${fx.A._id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(names(res), ['Admin X', 'Amit A3', 'Listed A4', 'Priya A2', 'Rahul A1']);
  });

  test('every User row of Event A is assigned to Event A or listed on it', async () => {
    const res = await access(`${RANGE}&eventId=${fx.A._id}`);
    for (const row of res.body.filter((r: any) => r.type === 'User')) {
      assert.ok(row.assignedEventId === String(fx.A._id) || String(row._id) === String(fx.uA4._id), row.name);
    }
  });

  test('Event B: B\'s records, and none of A\'s', async () => {
    const res = await access(`${RANGE}&eventId=${fx.B._id}`);
    assert.deepEqual(names(res), ['Admin Y', 'Bina B1', 'Bobby B2']);
    assert.equal(JSON.stringify(res.body).includes('Rahul A1'), false);
  });

  test('an event nobody has access to: an empty report, not an error', async () => {
    const res = await access(`${RANGE}&eventId=${fx.C._id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('no event: every access record in the period, as before', async () => {
    const res = await access(RANGE);
    assert.deepEqual(names(res), [
      'Admin X', 'Admin Y', 'Admin Z', 'Amit A3', 'Bina B1', 'Bobby B2', 'Listed A4', 'Priya A2', 'Rahul A1',
    ]);
  });

  test('event and dates together: Event A granted 1-2 Oct', async () => {
    const res = await access(`startDate=2026-10-01&endDate=2026-10-02&eventId=${fx.A._id}`);
    assert.deepEqual(names(res), ['Admin X', 'Priya A2', 'Rahul A1']);
  });

  test('dates alone: everything granted 1-2 Oct, across events', async () => {
    const res = await access('startDate=2026-10-01&endDate=2026-10-02');
    assert.deepEqual(names(res), ['Admin X', 'Bina B1', 'Priya A2', 'Rahul A1']);
  });

  test('an Admin sees Event A\'s Users they manage, and no Admin rows', async () => {
    const res = await access(`${RANGE}&eventId=${fx.A._id}`, fx.xToken);
    assert.equal(res.status, 200);
    assert.deepEqual(names(res), ['Amit A3', 'Listed A4', 'Priya A2', 'Rahul A1']);
  });

  test('an Admin asking for another Admin\'s event is refused, with no records', async () => {
    const res = await access(`${RANGE}&eventId=${fx.B._id}`, fx.xToken);
    assert.equal(res.status, 403);
    assert.equal(JSON.stringify(res.body).includes('Bina'), false);
  });

  test('a User cannot read access records at all, event or not', async () => {
    assert.equal((await access(`${RANGE}&eventId=${fx.A._id}`, fx.uA1Token)).status, 403);
  });

  test('no token is refused', async () => {
    assert.equal((await get(`/api/admin/users/access-records?${RANGE}&eventId=${fx.A._id}`)).status, 401);
  });

  test('a malformed event id is a 400, an unknown one a 404', async () => {
    assert.equal((await access(`${RANGE}&eventId=not-an-id`)).status, 400);
    assert.equal((await access(`${RANGE}&eventId[$ne]=x`)).status, 400);
    assert.equal((await access(`${RANGE}&eventId=${new mongoose.Types.ObjectId()}`)).status, 404);
  });
});

describe('Contact Report for one event', () => {
  test('Event A: all of Event A\'s contacts, and only them', async () => {
    const res = await contacts(`${RANGE}&eventId=${fx.A._id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(names(res), ['Contact A1', 'Contact A2', 'Contact A3']);
    assert.ok(res.body.every((c: any) => String(c.eventId) === String(fx.A._id)));
  });

  test('Event B: B\'s contacts, and none of A\'s', async () => {
    const res = await contacts(`${RANGE}&eventId=${fx.B._id}`);
    assert.deepEqual(names(res), ['Contact B1', 'Contact B2']);
  });

  test('an event with no contacts: an empty report', async () => {
    const res = await contacts(`${RANGE}&eventId=${fx.C._id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('no event: every contact in the period, as before', async () => {
    const res = await contacts(RANGE);
    assert.equal(res.body.length, 5);
  });

  test('event and dates together: Event A contacts added 1-2 Oct', async () => {
    const res = await contacts(`startDate=2026-10-01&endDate=2026-10-02&eventId=${fx.A._id}`);
    assert.deepEqual(names(res), ['Contact A1', 'Contact A2']);
  });

  test('dates alone: contacts added 1-2 Oct, across events', async () => {
    const res = await contacts('startDate=2026-10-01&endDate=2026-10-02');
    assert.deepEqual(names(res), ['Contact A1', 'Contact A2', 'Contact B1']);
  });

  test('an Admin reads their own event\'s contacts, and is refused another\'s', async () => {
    assert.deepEqual(names(await contacts(`${RANGE}&eventId=${fx.A._id}`, fx.xToken)), ['Contact A1', 'Contact A2', 'Contact A3']);
    const refused = await contacts(`${RANGE}&eventId=${fx.B._id}`, fx.xToken);
    assert.equal(refused.status, 403);
    assert.equal(JSON.stringify(refused.body).includes('Contact B'), false);
  });

  test('a User reads their assigned event, and is refused any other', async () => {
    assert.deepEqual(names(await contacts(`${RANGE}&eventId=${fx.A._id}`, fx.uA1Token)), ['Contact A1', 'Contact A2', 'Contact A3']);
    assert.equal((await contacts(`${RANGE}&eventId=${fx.B._id}`, fx.uA1Token)).status, 403);
    // Without an event, a User still sees only their own event, as before.
    assert.deepEqual(names(await contacts(RANGE, fx.uA1Token)), ['Contact A1', 'Contact A2', 'Contact A3']);
  });

  test('no token is refused', async () => {
    assert.equal((await get(`/api/contacts?${RANGE}&eventId=${fx.A._id}`)).status, 401);
  });

  test('a malformed event id is a 400', async () => {
    assert.equal((await contacts(`${RANGE}&eventId=not-an-id`)).status, 400);
    assert.equal((await contacts(`${RANGE}&eventId[$ne]=x`)).status, 400);
  });

  test('the per-event contacts endpoint answers as it always did', async () => {
    const res = await get(`/api/contacts/event/${fx.A._id}`, fx.superToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3);
  });
});

describe('the cost of a scoped report', () => {
  const HOUSEKEEPING = new Set(['createIndex', 'createIndexes', 'ensureIndex', 'dropIndex', 'listIndexes', 'indexes']);
  const opsFor = async (path: string, token = fx.superToken) => {
    const ops: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => {
      if (!HOUSEKEEPING.has(method)) ops.push(`${collection}.${method}`);
    });
    try {
      const res = await get(path, token);
      assert.equal(res.status, 200);
      return { ops, rows: res.body.length };
    } finally {
      mongoose.set('debug', false);
    }
  };

  test('no N+1: an event with 30 more Users and contacts costs the same queries as before', async () => {
    const D = await mkEvent('Load Event', { adminId: fx.adminZ._id });
    // One User and one contact to start with, so both measurements include the
    // one batched populate of the Users' events (Mongoose skips it for none).
    await mkUser('Load User first', { adminId: fx.adminZ._id, assignedEventId: D._id, accessGrantedOn: at('2026-10-06') });
    await mkContact(D, 'Load Contact first', '2026-10-06');
    const small = { access: await opsFor(`/api/admin/users/access-records?${RANGE}&eventId=${D._id}`),
                    contacts: await opsFor(`/api/contacts?${RANGE}&eventId=${D._id}`) };
    for (let i = 0; i < 30; i++) {
      await mkUser(`Load User ${i}`, { adminId: fx.adminZ._id, assignedEventId: D._id, accessGrantedOn: at('2026-10-06') });
      await mkContact(D, `Load Contact ${i}`, '2026-10-06');
    }
    const large = { access: await opsFor(`/api/admin/users/access-records?${RANGE}&eventId=${D._id}`),
                    contacts: await opsFor(`/api/contacts?${RANGE}&eventId=${D._id}`) };

    assert.equal(small.access.rows, 2, 'Admin Z and one User before');
    assert.equal(large.access.rows, 32);
    assert.equal(large.contacts.rows, 31);
    assert.equal(large.access.ops.length, small.access.ops.length,
      `access: ${small.access.ops.join(', ')} | ${large.access.ops.join(', ')}`);
    assert.equal(large.contacts.ops.length, small.contacts.ops.length,
      `contacts: ${small.contacts.ops.join(', ')} | ${large.contacts.ops.join(', ')}`);
    assert.ok(large.access.ops.length <= 6, `access queries: ${large.access.ops.join(', ')}`);
    assert.ok(large.contacts.ops.length <= 3, `contact queries: ${large.contacts.ops.join(', ')}`);
  });
});

describe('Access Report one row per event: accessEventIds', () => {
  const holdersOf = (res: { body: any }, eventId: any) =>
    res.body.filter((r: any) => (r.accessEventIds || []).includes(String(eventId))).map((r: any) => r.name).sort();

  test('every record says which events it reaches', async () => {
    const res = await access(RANGE);
    assert.equal(res.status, 200);
    assert.ok(res.body.every((r: any) => Array.isArray(r.accessEventIds)));
    const by = (name: string) => res.body.find((r: any) => r.name === name).accessEventIds;
    assert.deepEqual(by('Rahul A1'), [String(fx.A._id)], 'assignedEventId');
    assert.deepEqual(by('Listed A4'), [String(fx.A._id)], 'on the event\'s own user list');
    assert.deepEqual(by('Bina B1'), [String(fx.B._id)]);
    assert.ok(by('Admin X').includes(String(fx.A._id)), 'the event\'s Admin');
    assert.equal(by('Admin X').includes(String(fx.B._id)), false);
    assert.ok(by('Admin Y').includes(String(fx.B._id)));
  });

  test('the rows agree exactly with each event\'s own View endpoint', async () => {
    // Two events with no adminId, reached by Admin Y only through Users they
    // manage: one by assignedEventId, one by the event's own user list.
    const G = await mkEvent('Guest Lecture', { createdBy: fx.superAdmin._id });
    const H = await mkEvent('Hackathon', { createdBy: fx.superAdmin._id });
    await mkUser('Gita G1', { adminId: fx.adminY._id, assignedEventId: G._id, accessGrantedOn: at('2026-10-06') });
    const listed = await mkUser('Hari H1', { adminId: fx.adminY._id, accessGrantedOn: at('2026-10-06') });
    await Event.updateOne({ _id: H._id }, { $set: { assignedUserIds: [listed._id] } });

    const all = await access(RANGE);
    assert.deepEqual(holdersOf(all, G._id), ['Admin Y', 'Gita G1'], 'Admin Y through an assigned User');
    assert.deepEqual(holdersOf(all, H._id), ['Admin Y', 'Hari H1'], 'Admin Y through a listed User');
    for (const event of [fx.A, fx.B, fx.C, G, H]) {
      const scoped = await access(`${RANGE}&eventId=${event._id}`);
      assert.deepEqual(holdersOf(all, event._id), names(scoped), `event ${event.eventName}`);
    }
  });

  test('with dates, the events follow the records the dates kept', async () => {
    const res = await access('startDate=2026-10-01&endDate=2026-10-02');
    assert.deepEqual(holdersOf(res, fx.A._id), ['Admin X', 'Priya A2', 'Rahul A1']);
    assert.deepEqual(holdersOf(res, fx.B._id), ['Bina B1'], 'Admin Y was granted on 3 Oct');
  });

  test('a report for one event lists that event alone on every record', async () => {
    const res = await access(`${RANGE}&eventId=${fx.A._id}`);
    assert.ok(res.body.length > 0);
    assert.ok(res.body.every((r: any) => r.accessEventIds.length === 1 && r.accessEventIds[0] === String(fx.A._id)));
  });

  test('an Admin is only offered events they may open', async () => {
    // A User managed by Admin X created an event of their own: the User reaches
    // it, but it is not within Admin X's scope, so X's report must not offer it.
    const creator = await mkUser('Creator F', { adminId: fx.adminX._id, accessGrantedOn: at('2026-10-07') });
    const F = await mkEvent('Fringe Event', { createdBy: creator._id });

    const asSuper = (await access(RANGE)).body.find((r: any) => r.name === 'Creator F');
    assert.deepEqual(asSuper.accessEventIds, [String(F._id)], 'a Super Admin sees the User reaches F');

    const asX = await access(RANGE, fx.xToken);
    const row = asX.body.find((r: any) => r.name === 'Creator F');
    assert.deepEqual(row.accessEventIds, [], 'Admin X is not offered F');
    assert.equal((await access(`${RANGE}&eventId=${F._id}`, fx.xToken)).status, 403, 'and could not open it');
    for (const r of asX.body) {
      for (const id of r.accessEventIds) {
        assert.equal((await access(`${RANGE}&eventId=${id}`, fx.xToken)).status, 200, `every offered event opens (${id})`);
      }
    }
  });

  test('no N+1: grouping 40 more records across 10 more events costs the same queries', async () => {
    const HOUSEKEEPING = new Set(['createIndex', 'createIndexes', 'ensureIndex', 'dropIndex', 'listIndexes', 'indexes']);
    const opsFor = async () => {
      const ops: string[] = [];
      mongoose.set('debug', (collection: string, method: string) => {
        if (!HOUSEKEEPING.has(method)) ops.push(`${collection}.${method}`);
      });
      try {
        const res = await access(RANGE);
        assert.equal(res.status, 200);
        return { ops, rows: res.body.length };
      } finally {
        mongoose.set('debug', false);
      }
    };
    const before = await opsFor();
    for (let e = 0; e < 10; e++) {
      const admin = await mkAdmin(`Grouping Admin ${e}`, 'Admin', '2026-10-08');
      const event = await mkEvent(`Grouping Event ${e}`, { adminId: admin._id });
      for (let u = 0; u < 3; u++) {
        await mkUser(`Grouping User ${e}-${u}`, { adminId: admin._id, assignedEventId: event._id, accessGrantedOn: at('2026-10-08') });
      }
    }
    const after = await opsFor();
    assert.equal(after.rows, before.rows + 40);
    assert.equal(after.ops.length, before.ops.length, `${before.ops.join(', ')} | ${after.ops.join(', ')}`);
  });
});

describe('Contact Report one row per event', () => {
  test('every contact names its one event, so it groups under it alone', async () => {
    const res = await contacts(RANGE);
    assert.ok(res.body.every((c: any) => c.eventId));
    const a = res.body.filter((c: any) => String(c.eventId) === String(fx.A._id)).map((c: any) => c.fullName).sort();
    const scoped = await contacts(`${RANGE}&eventId=${fx.A._id}`);
    assert.deepEqual(a, names(scoped), 'the grouped rows equal the event\'s own View endpoint');
  });
});

describe('the event View request: the event id alone', () => {
  test('Access: every record of the event, including ones outside the report\'s dates', async () => {
    await mkUser('Early A0', { adminId: fx.adminX._id, assignedEventId: fx.A._id, accessGrantedOn: at('2026-09-15') });
    const report = await access(`${RANGE}&eventId=${fx.A._id}`);
    assert.equal(names(report).includes('Early A0'), false, 'the October report leaves it out');

    const view = await access(`eventId=${fx.A._id}`);
    assert.equal(view.status, 200);
    assert.ok(names(view).includes('Early A0'), 'the View still shows it');
    for (const name of ['Admin X', 'Amit A3', 'Listed A4', 'Priya A2', 'Rahul A1']) assert.ok(names(view).includes(name), name);
    assert.equal(names(view).some((n: string) => /B\d|Admin Y/.test(n)), false, 'nothing from another event');
  });

  test('Contact: every contact of the event, including ones outside the report\'s dates', async () => {
    await mkContact(fx.A, 'Contact A0', '2026-09-15');
    const report = await contacts(`${RANGE}&eventId=${fx.A._id}`);
    assert.equal(names(report).includes('Contact A0'), false);

    const view = await contacts(`eventId=${fx.A._id}`);
    assert.equal(view.status, 200);
    assert.ok(names(view).includes('Contact A0'));
    assert.ok(view.body.every((c: any) => String(c.eventId) === String(fx.A._id)));
  });

  test('an event the caller may not see is still refused, with no records', async () => {
    const a = await access(`eventId=${fx.B._id}`, fx.xToken);
    assert.equal(a.status, 403);
    assert.equal(JSON.stringify(a.body).includes('Bina'), false);
    const c = await contacts(`eventId=${fx.B._id}`, fx.xToken);
    assert.equal(c.status, 403);
    assert.equal(JSON.stringify(c.body).includes('Contact B'), false);
    assert.equal((await access(`eventId=${fx.A._id}`, fx.uA1Token)).status, 403, 'a User cannot read access records');
    assert.equal((await get(`/api/contacts?eventId=${fx.A._id}`)).status, 401, 'no token');
  });
});
