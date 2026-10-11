import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * The Access Report by event: GET /api/admin/access-report - the events in the
 * period, and in each event's View everyone with access to it - over real HTTP
 * against the REAL compiled backend (backend/dist) on a throwaway database.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_accessreport_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const { Event } = require('../backend/dist/models/Event');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');

let server: any;
let baseUrl = '';

const get = (path: string, token: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const at = (iso: string) => new Date(`${iso}T06:00:00.000Z`);
const OCT = 'startDate=2026-10-01&endDate=2026-10-31';
const fx: any = {};

const mkEvent = (eventName: string, date: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Party',
    eventDate: new Date(`${date}T00:00:00.000Z`), eventTime: new Date(`${date}T04:30:00.000Z`),
    eventVenue: 'Pune', eventStatus: 'Upcoming', ...extra,
  });

before(async () => {
  await mongoose.connect(TEST_DB);

  // The Super Admin has no access grant date; Admin X's was long before the period.
  fx.superAdmin = await Admin.create({ name: 'Aditya Super', email: 'super@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminX = await Admin.create({ name: 'Xavier Admin', email: 'xavier@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', accessGrantedOn: at('2026-08-01') });
  fx.adminY = await Admin.create({ name: 'Yusuf Admin', email: 'yusuf@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', accessGrantedOn: at('2026-08-02') });

  fx.college = await mkEvent('College Fest', '2026-10-15', { createdBy: fx.superAdmin._id });
  fx.school = await mkEvent('School Event', '2026-10-20', { adminId: fx.adminX._id, createdBy: fx.adminX._id });
  fx.gala = await mkEvent('Annual Gala', '2026-10-25', { createdBy: fx.superAdmin._id });
  fx.meetup = await mkEvent('Yusuf Meetup', '2026-10-10', { adminId: fx.adminY._id, createdBy: fx.adminY._id });
  fx.old = await mkEvent('Old Party', '2026-06-01', { createdBy: fx.superAdmin._id });

  fx.priya = await User.create({ name: 'Priya Desai', email: 'priya@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.school._id, accessGrantedOn: at('2026-07-01') });
  fx.pending = await User.create({ name: 'Pending Pawan', email: 'pawan@example.com', passwordHash: 'x', status: 'Pending', adminId: fx.adminX._id, assignedEventId: fx.school._id });
  fx.neha = await User.create({ name: 'Neha Kulkarni', email: 'neha@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, accessGrantedOn: at('2026-10-05') });
  await Event.updateOne({ _id: fx.gala._id }, { $set: { assignedUserIds: [fx.neha._id] } });

  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.x = tokenFor(fx.adminX, 'Admin');
  fx.y = tokenFor(fx.adminY, 'Admin');

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

const report = (query: string, token = fx.super) => get(`/api/admin/access-report?${query}`, token);
const names = (res: { body: any[] }) => res.body.map((r) => r.name).sort();
const via = (res: { body: any[] }) => Object.fromEntries(res.body.map((r) => [r.name, r.accessVia]));
const eventsListed = (res: { body: any[] }) => [...new Set(res.body.flatMap((r) => r.accessEventIds))].sort();
const q = (value: string) => `q=${encodeURIComponent(value)}`;

// ─────────────────────────────────────────────────────────────────────────────

describe('the report lists events in the period, like the Event and Contact Reports', () => {
  test('every event in the period with someone who has access - by event date, whoever created it', async () => {
    const res = await report(OCT);
    assert.equal(res.status, 200);
    assert.deepEqual(eventsListed(res), [fx.college, fx.school, fx.gala, fx.meetup].map((e) => String(e._id)).sort());
  });

  test('an event outside the period is not listed', async () => {
    assert.equal(eventsListed(await report(OCT)).includes(String(fx.old._id)), false);
  });

  test('searching an event finds it - even one only a Super Admin can reach', async () => {
    const res = await report(`${OCT}&${q('college')}`);
    assert.deepEqual(names(res), ['Aditya Super']);
    assert.deepEqual(res.body[0].accessEventIds, [String(fx.college._id)], 'just that event, not the others the Super Admin created');
  });

  test('searching a person finds the events they can reach', async () => {
    const res = await report(`${OCT}&${q('PRIYA')}`);
    assert.deepEqual(names(res), ['Priya Desai']);
    assert.deepEqual(res.body[0].accessEventIds, [String(fx.school._id)]);
  });
});

describe('an event\'s View: everyone with access to it, and how', () => {
  test('created by a Super Admin: the Super Admin\'s details', async () => {
    const res = await report(`eventId=${fx.college._id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(names(res), ['Aditya Super']);
    assert.equal(res.body[0].role, 'SuperAdmin');
    assert.equal(res.body[0].email, 'super@example.com');
    assert.deepEqual(via(res), { 'Aditya Super': 'Created the event' });
    assert.equal('passwordHash' in res.body[0], false);
  });

  test('created by another Admin: that Admin - whenever their access was granted - and the assigned Users', async () => {
    const res = await report(`eventId=${fx.school._id}`);
    // Xavier created it, and manages Priya, who is assigned to it: both are said.
    assert.deepEqual(via(res), { 'Xavier Admin': 'Created the event, Manages an assigned user', 'Priya Desai': 'Assigned to the event' });
    assert.equal(names(res).includes('Pending Pawan'), false, 'no access granted yet');
  });

  test('a User assigned by the event\'s list, and the Admin who manages them', async () => {
    const res = await report(`eventId=${fx.gala._id}`);
    assert.deepEqual(via(res), {
      'Aditya Super': 'Created the event',
      'Neha Kulkarni': 'Assigned to the event',
      'Xavier Admin': 'Manages an assigned user',
    });
  });

  test('the View of a searched report: every holder when the event itself matched', async () => {
    const res = await report(`eventId=${fx.school._id}&${OCT}&${q('school')}`);
    assert.deepEqual(names(res), ['Priya Desai', 'Xavier Admin']);
    assert.deepEqual(names(await report(`eventId=${fx.school._id}&${OCT}&${q('priya')}`)), ['Priya Desai'], 'or the matching people');
  });

  test('the period applies to the event in a View too', async () => {
    assert.deepEqual((await report(`eventId=${fx.old._id}&${OCT}`)).body, []);
    assert.deepEqual(names(await report(`eventId=${fx.old._id}`)), ['Aditya Super'], 'with no period, the event alone');
  });
});

describe('who may see what', () => {
  test('an Admin sees their own account and their Users - never a Super Admin or another Admin', async () => {
    const res = await report(OCT, fx.x);
    assert.deepEqual(names(res), ['Neha Kulkarni', 'Priya Desai', 'Xavier Admin']);
    const gala = await report(`eventId=${fx.gala._id}`, fx.x);
    assert.deepEqual(names(gala), ['Neha Kulkarni', 'Xavier Admin'], 'not the Super Admin who created it');
    assert.equal(res.body.some((r: any) => 'approvedBy' in r), false, 'no approval metadata for an Admin');
  });

  test('another organizer\'s event is refused, and not found by searching', async () => {
    assert.equal((await report(`eventId=${fx.meetup._id}`, fx.x)).status, 403);
    assert.deepEqual((await report(`${OCT}&${q('meetup')}`, fx.x)).body, []);
    assert.deepEqual((await report(`${OCT}&${q('college')}`, fx.y)).body, []);
    assert.deepEqual(names(await report(`eventId=${fx.meetup._id}`, fx.y)), ['Yusuf Admin']);
  });

  test('a User cannot open the report', async () => {
    assert.equal((await report(OCT, tokenFor(fx.priya, 'User'))).status, 403);
  });
});

describe('filters, bad input, and the unchanged access list', () => {
  test('status works with the event search', async () => {
    assert.deepEqual(names(await report(`${OCT}&status=active&${q('gala')}`)), ['Aditya Super', 'Neha Kulkarni', 'Xavier Admin']);
    assert.deepEqual((await report(`${OCT}&status=rejected`)).body, []);
  });

  test('bad input is a 400', async () => {
    assert.equal((await report('eventId=nope')).status, 400);
    assert.equal((await report(`${OCT}&${q('x'.repeat(101))}`)).status, 400);
    assert.equal((await report('startDate=2026-10-01')).status, 400, 'half a period');
  });

  test('the Just Access list of access accounts is unchanged', async () => {
    const res = await get('/api/admin/users/access-records', fx.super);
    assert.equal(res.status, 200);
    assert.equal(names(res).includes('Aditya Super'), false, 'still no Super Admin accounts');
    assert.ok(names(res).includes('Priya Desai'));
  });
});
