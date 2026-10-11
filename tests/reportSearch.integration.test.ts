import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * The Reports tab's "All Fields" search (?q=) for the Event, Access and
 * Contact Reports, over real HTTP against the REAL compiled backend
 * (backend/dist) on a throwaway database.
 *
 *   GET /api/events?q=
 *   GET /api/contacts?q=
 *   GET /api/admin/users/access-records?q=
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_reportsearch_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const contactRoutes = require('../backend/dist/routes/contactRoutes').default;
const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');
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
const OCT_NOV = 'startDate=2026-10-01&endDate=2026-11-30';
const fx: any = {};

const mkAdmin = (name: string, role: string) =>
  Admin.create({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`, passwordHash: 'x', role, status: 'Active', accessGrantedOn: at('2026-10-02') });

/** An event on `date` at `time` India time. */
const mkEvent = (eventName: string, date: string, time: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9000000000'), eventName, eventType: 'Party',
    eventDate: new Date(`${date}T00:00:00.000Z`), eventTime: new Date(`${date}T${time}:00+05:30`),
    eventVenue: 'Hall', eventStatus: 'Upcoming', ...extra,
  });

let phoneSeq = 0;
const mkContact = (event: any, fullName: string, extra: Record<string, any> = {}) =>
  Contact.create({
    fullName, phoneNumber: `+9198765${String(10000 + phoneSeq++)}`, countryCode: 'IN',
    eventId: event._id, source: 'Manual', status: 'Valid', ...extra,
  });

before(async () => {
  await mongoose.connect(TEST_DB);

  fx.superAdmin = await mkAdmin('Super Search', 'SuperAdmin');
  fx.adminX = await mkAdmin('Organizer Xavier', 'Admin');
  fx.adminY = await mkAdmin('Organizer Yusuf', 'Admin');

  fx.college = await mkEvent('College Party', '2026-10-31', '10:00', {
    adminId: fx.adminX._id, organizerName: 'Akshat Singh', organizerMobile: BigInt('9112472833'),
    eventVenue: 'Ausa Maharashtra', eventDescription: 'Annual alumni meet',
  });
  fx.wedding = await mkEvent('Sharma Wedding', '2026-11-15', '18:30', {
    adminId: fx.adminX._id, eventType: 'Wedding', eventVenue: 'Pune Palace', organizerMobile: BigInt('9822000000'),
  });
  fx.gala = await mkEvent('Yusuf Gala', '2026-10-20', '20:00', { adminId: fx.adminY._id, eventVenue: 'Mumbai' });

  fx.riya = await mkContact(fx.college, 'Riya Patil', { email: 'riya@example.com' });
  fx.aman = await mkContact(fx.wedding, 'Aman Verma', { status: 'Duplicate' });
  fx.ravi = await mkContact(fx.gala, 'Ravi College'); // another organizer's contact, named "College"

  fx.priya = await User.create({ name: 'Priya Desai', email: 'priya@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.college._id, accessGrantedOn: at('2026-10-05') });
  fx.neha = await User.create({ name: 'Neha Kulkarni', email: 'neha@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.wedding._id, accessGrantedOn: at('2026-10-06') });
  fx.kid = await User.create({ name: 'College Kid', email: 'kid@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminY._id, assignedEventId: fx.gala._id, accessGrantedOn: at('2026-10-07') });

  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.x = tokenFor(fx.adminX, 'Admin');
  fx.y = tokenFor(fx.adminY, 'Admin');

  const app = express();
  app.use(express.json());
  app.use('/api/events', eventRoutes);
  app.use('/api/contacts', contactRoutes);
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

const q = (value: string) => `q=${encodeURIComponent(value)}`;
const names = (res: { body: any[] }) => res.body.map((r) => r.eventName ?? r.fullName ?? r.name).sort();

// ─────────────────────────────────────────────────────────────────────────────

describe('Event Report: every event field', () => {
  const events = async (query: string, token = fx.x) => names(await get(`/api/events?${query}`, token));

  test('event name, case-insensitive and partial, surrounding spaces ignored', async () => {
    assert.deepEqual(await events(q('College Party')), ['College Party']);
    assert.deepEqual(await events(q('COLLEGE')), ['College Party']);
    assert.deepEqual(await events(q('  coll  ')), ['College Party']);
    assert.deepEqual(await events(q('arma wed')), ['Sharma Wedding']);
  });

  test('Event ID, whole or partial', async () => {
    assert.deepEqual(await events(q(fx.wedding.eventId)), ['Sharma Wedding']);
    assert.deepEqual(await events(q(fx.college.eventId.toLowerCase())), ['College Party']);
  });

  test('venue, type, organizer, mobile, description and status', async () => {
    assert.deepEqual(await events(q('ausa')), ['College Party']);
    assert.deepEqual(await events(q('pune pal')), ['Sharma Wedding']);
    assert.deepEqual(await events(q('wedding')), ['Sharma Wedding']);
    assert.deepEqual(await events(q('akshat')), ['College Party']);
    assert.deepEqual(await events(q('91124')), ['College Party']);
    assert.deepEqual(await events(q('alumni')), ['College Party']);
    assert.deepEqual(await events(q('upcoming')), ['College Party', 'Sharma Wedding']);
  });

  test('event date as the report prints it and in numeric forms, and the time', async () => {
    for (const date of ['31 Oct 2026', '31 oct', 'Oct 2026', '2026-10-31', '31/10/2026', '31-10-2026']) {
      assert.deepEqual(await events(q(date)), ['College Party'], date);
    }
    assert.deepEqual(await events(q('15 Nov 2026')), ['Sharma Wedding']);
    assert.deepEqual(await events(q('10:00')), ['College Party']);
    assert.deepEqual(await events(q('18:30')), ['Sharma Wedding']);
  });

  test('works with the date range: both must match', async () => {
    assert.deepEqual(await events(`${q('college')}&startDate=2026-10-01&endDate=2026-10-31`), ['College Party']);
    assert.deepEqual(await events(`${q('college')}&startDate=2026-11-01&endDate=2026-11-30`), []);
  });

  test('only the caller\'s own events are searched', async () => {
    assert.deepEqual(await events(q('gala')), [], 'Organizer X cannot find Y\'s event');
    assert.deepEqual(await events(q('gala'), fx.y), ['Yusuf Gala']);
    assert.deepEqual(await events(q('gala'), fx.super), ['Yusuf Gala']);
  });

  test('no search: the listing is unchanged; bad input is a 400', async () => {
    assert.deepEqual(await events(''), ['College Party', 'Sharma Wedding']);
    assert.deepEqual(await events('q=%20%20'), ['College Party', 'Sharma Wedding'], 'blank is no search');
    assert.equal((await get(`/api/events?${q('x'.repeat(101))}`, fx.x)).status, 400);
    assert.equal((await get('/api/events?q[]=a', fx.x)).status, 400);
    assert.deepEqual(await events(q('.*')), [], 'typed characters are literal, not a pattern');
  });
});

describe('Contact Report: contact fields and the contact\'s event', () => {
  const contacts = async (query: string, token = fx.x) => names(await get(`/api/contacts?${OCT_NOV.replace('2026-10-01', '2000-01-01').replace('2026-11-30', '2100-01-01')}&${query}`, token));

  test('contact name, phone, email and status, case-insensitive and partial', async () => {
    assert.deepEqual(await contacts(q('  RIYA ')), ['Riya Patil']);
    assert.deepEqual(await contacts(q(fx.aman.phoneNumber.slice(-7))), ['Aman Verma'], 'part of the number');
    assert.deepEqual(await contacts(q(fx.aman.phoneNumber.slice(3))), ['Aman Verma'], 'the 10-digit mobile');
    assert.deepEqual(await contacts(q('riya@exa')), ['Riya Patil']);
    assert.deepEqual(await contacts(q('duplic')), ['Aman Verma']);
  });

  test('the contact\'s event: name, ID, venue, date', async () => {
    assert.deepEqual(await contacts(q('college party')), ['Riya Patil']);
    assert.deepEqual(await contacts(q(fx.wedding.eventId)), ['Aman Verma']);
    assert.deepEqual(await contacts(q('pune')), ['Aman Verma']);
    assert.deepEqual(await contacts(q('31 Oct 2026')), ['Riya Patil']);
  });

  test('only the caller\'s contacts and events', async () => {
    assert.deepEqual(await contacts(q('college')), ['Riya Patil'], 'not the other organizer\'s "Ravi College"');
    assert.deepEqual(await contacts(q('college'), fx.super), ['Ravi College', 'Riya Patil']);
    assert.deepEqual(await contacts(q('riya'), fx.y), []);
  });

  test('works with the existing event, name and status filters', async () => {
    assert.deepEqual(await contacts(`eventId=${fx.wedding._id}&${q('college')}`), []);
    assert.deepEqual(await contacts(`eventId=${fx.college._id}&${q('college')}`), ['Riya Patil']);
    assert.deepEqual(await contacts(`status=valid&${q('verma')}`), [], 'Aman is a Duplicate');
    assert.deepEqual(await contacts(`name=aman&${q('pune')}`), ['Aman Verma']);
  });

  test('the Contacts tab\'s own ?search= is unchanged', async () => {
    const res = await get('/api/contacts?search=college', fx.x);
    assert.deepEqual(res.body.map((c: any) => c.fullName), [], 'still name/phone only - no event matching');
  });
});

describe('Access Report: user and access fields and the events each person reaches', () => {
  const access = (query: string, token = fx.super) => get(`/api/admin/users/access-records?${OCT_NOV}&${query}`, token);

  test('name, email, role and status, case-insensitive and partial', async () => {
    assert.deepEqual(names(await access(q('PRIYA'))), ['Priya Desai']);
    assert.deepEqual(names(await access(q('neha@'))), ['Neha Kulkarni']);
    assert.deepEqual(names(await access(q('admin'))), ['Organizer Xavier', 'Organizer Yusuf']);
    assert.deepEqual(names(await access(q('activ'))).length, 5);
  });

  test('event fields: people who can reach a matching event', async () => {
    const res = await access(q('college party'));
    assert.deepEqual(names(res), ['Organizer Xavier', 'Priya Desai']);
    assert.deepEqual(names(await access(q('pune'))), ['Neha Kulkarni', 'Organizer Xavier']);
    assert.deepEqual(names(await access(q(fx.gala.eventId))), ['College Kid', 'Organizer Yusuf']);
  });

  test('someone found only through an event keeps only the matching events', async () => {
    const xavier = (await access(q('college party'))).body.find((r: any) => r.name === 'Organizer Xavier');
    assert.deepEqual(xavier.accessEventIds, [String(fx.college._id)], 'not the Wedding as well');
    const own = (await access(q('xavier'))).body.find((r: any) => r.name === 'Organizer Xavier');
    assert.equal(own.accessEventIds.length, 2, 'found by name: every event they reach');
  });

  test('an Admin searches only the Users they manage', async () => {
    assert.deepEqual(names(await access(q('college'), fx.x)), ['Priya Desai'], 'not Y\'s "College Kid"');
    assert.deepEqual(names(await access(q('kid'), fx.x)), []);
  });

  test('works with the existing event, username and status filters', async () => {
    assert.deepEqual(names(await access(`eventId=${fx.college._id}&${q('college')}`)), ['Organizer Xavier', 'Priya Desai']);
    assert.deepEqual(names(await access(`eventId=${fx.wedding._id}&${q('college')}`)), [], 'the Wedding does not match "college"');
    assert.deepEqual(names(await access(`username=priya&${q('college')}`)), ['Priya Desai']);
    assert.deepEqual(names(await access(`status=rejected&${q('college')}`)), []);
  });

  test('bad input is a 400', async () => {
    assert.equal((await access(q('x'.repeat(101)))).status, 400);
    assert.equal((await access('q[]=a')).status, 400);
  });
});
