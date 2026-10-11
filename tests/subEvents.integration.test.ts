import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Main Events, Sub-Events and their independent member lists, over real HTTP
 * against the REAL compiled backend (routes, middleware, controllers, models
 * from backend/dist) on a throwaway database.
 *
 *   POST   /api/events/:id/sub-events
 *   GET    /api/events?parentEventId= | ?includeSubEvents=true
 *   GET    /api/events/:id/members | /member-candidates
 *   POST   /api/events/:id/members
 *   DELETE /api/events/:id/members/:contactId
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_subevents_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const contactRoutes = require('../backend/dist/routes/contactRoutes').default;
const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { EventMember } = require('../backend/dist/models/EventMember');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { getAuthorizedEventIds } = require('../backend/dist/services/eventAuthService');
const { eventGuestFilter, findEventGuest } = require('../backend/dist/services/subEventService');

let server: any;
let baseUrl = '';

type Res = { status: number; body: any };
const call = (method: string, path: string, token?: string, body?: unknown): Promise<Res> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
    };
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const at = (iso: string) => new Date(`${iso}T06:00:00.000Z`);
const fx: any = {};

const mkAdmin = (name: string, role: string) =>
  Admin.create({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`, passwordHash: 'x', role, status: 'Active' });

const mkEvent = (eventName: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: at('2027-01-15'), eventTime: at('2027-01-15'), eventVenue: 'Hall', eventStatus: 'Upcoming', ...extra,
  });

let phoneSeq = 0;
const mkContact = (event: any, fullName: string) =>
  Contact.create({
    fullName, phoneNumber: `+9191000${String(10000 + phoneSeq++)}`, countryCode: 'IN',
    eventId: event._id, source: 'Manual', status: 'Valid',
  });

/** A valid sub-event body; the date is safely in the future. */
const subBody = (eventName: string, eventDate = '2027-01-14', extra: Record<string, any> = {}) => ({
  organizerName: 'Organiser', organizerMobile: '9112472833', eventName, eventType: 'Ceremony',
  eventDate, eventTime: '10:00', eventVenue: 'Garden', ...extra,
});

before(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([Event.init(), EventMember.init(), Contact.init()]);

  fx.superAdmin = await mkAdmin('Super', 'SuperAdmin');
  fx.adminX = await mkAdmin('Admin X', 'Admin');
  fx.adminY = await mkAdmin('Admin Y', 'Admin');

  fx.W = await mkEvent('Wedding', { adminId: fx.adminX._id, createdBy: fx.adminX._id });
  fx.O = await mkEvent('Other X Event', { adminId: fx.adminX._id, createdBy: fx.adminX._id });
  fx.B = await mkEvent('Y Birthday', { adminId: fx.adminY._id, createdBy: fx.adminY._id });
  fx.S = await mkEvent('Super Own', { createdBy: fx.superAdmin._id });
  fx.Done = await mkEvent('Finished', { adminId: fx.adminX._id, eventStatus: 'Completed' });

  // A legacy Main Event stored before parentEventId existed: no such field.
  const legacy = await Event.collection.insertOne({
    eventId: 'EVT-900001', organizerName: 'Legacy', organizerMobile: BigInt('9112472833'), eventName: 'Legacy Gala',
    eventType: 'Party', eventDate: at('2027-02-01'), eventTime: at('2027-02-01'), eventVenue: 'Old Hall',
    eventStatus: 'Upcoming', adminId: fx.adminX._id, createdAt: new Date(), updatedAt: new Date(),
  });
  fx.legacyId = legacy.insertedId;

  fx.userW = await User.create({
    name: 'Wedding Helper', email: 'helper@example.com', passwordHash: 'x', status: 'Active',
    adminId: fx.adminX._id, assignedEventId: fx.W._id,
  });

  fx.w1 = await mkContact(fx.W, 'Asha Wedding');
  fx.w2 = await mkContact(fx.W, 'Bala Wedding');
  fx.w3 = await mkContact(fx.W, 'Chitra Wedding');
  fx.o1 = await mkContact(fx.O, 'Dev Other');
  fx.b1 = await mkContact(fx.B, 'Esha Y');
  fx.s1 = await mkContact(fx.S, 'Farah Super');

  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.x = tokenFor(fx.adminX, 'Admin');
  fx.y = tokenFor(fx.adminY, 'Admin');
  fx.user = tokenFor(fx.userW, 'User');

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

const addMembers = (subId: any, ids: any[], token = fx.x) =>
  call('POST', `/api/events/${subId}/members`, token, { contactIds: ids.map(String) });
const memberNames = async (subId: any) =>
  (await call('GET', `/api/events/${subId}/members`, fx.super)).body.map((c: any) => c.fullName).sort();

// ─────────────────────────────────────────────────────────────────────────────

describe('creating sub-events', () => {
  test('an Admin creates sub-events under their Main Event; each is a real event with its own id', async () => {
    const haldi = await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.x, subBody('Haldi Ceremony', '2027-01-13'));
    assert.equal(haldi.status, 201, JSON.stringify(haldi.body));
    assert.equal(haldi.body.parentEventId, String(fx.W._id));
    assert.match(haldi.body.eventId, /^EVT-\d{6,}$/);
    assert.notEqual(haldi.body.eventId, fx.W.eventId);
    assert.equal(haldi.body.memberCount, 0, 'starts with an empty member list');
    assert.equal(haldi.body.eventStatus, 'Upcoming');
    assert.equal(haldi.body.parentEvent.eventName, 'Wedding');
    fx.haldi = haldi.body;

    const stored = await Event.findById(haldi.body._id).lean();
    assert.equal(String(stored.adminId), String(fx.adminX._id), 'owned by the Main Event\'s organizer');
    assert.deepEqual(stored.assignedUserIds, [], 'nobody is assigned to a sub-event directly');

    const reception = await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.x, subBody('Reception', '2027-01-16'));
    assert.equal(reception.status, 201);
    fx.reception = reception.body;
  });

  test('the parent is the one in the path - a parentEventId in the body is ignored', async () => {
    const res = await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.x, subBody('Mehendi', '2027-01-12', { parentEventId: String(fx.B._id) }));
    assert.equal(res.status, 201);
    assert.equal(res.body.parentEventId, String(fx.W._id));
    fx.mehendi = res.body;
  });

  test('one level only: a sub-event cannot have sub-events', async () => {
    const res = await call('POST', `/api/events/${fx.haldi._id}/sub-events`, fx.x, subBody('Nested'));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /cannot have sub-events/);
  });

  test('invalid, unknown and unauthorized parents are refused', async () => {
    assert.equal((await call('POST', '/api/events/not-an-id/sub-events', fx.x, subBody('X'))).status, 400);
    const unknown = new mongoose.Types.ObjectId();
    assert.equal((await call('POST', `/api/events/${unknown}/sub-events`, fx.super, subBody('X'))).status, 404);
    assert.equal((await call('POST', `/api/events/${unknown}/sub-events`, fx.x, subBody('X'))).status, 403);
    assert.equal((await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.y, subBody('X'))).status, 403, 'another organizer\'s event');
    assert.equal((await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.user, subBody('X'))).status, 403, 'a User cannot create one');
  });

  test('the ordinary event rules apply, and a completed event takes no sub-events', async () => {
    assert.equal((await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.x, subBody(''))).status, 400);
    const past = await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.x, subBody('Old', '2020-01-01'));
    assert.equal(past.status, 400);
    assert.match(past.body.error, /past/);
    assert.equal((await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.x, subBody('Toolong-name-over-twenty'))).status, 400);
    const assigned = await call('POST', `/api/events/${fx.W._id}/sub-events`, fx.x, subBody('Sangeet', '2027-01-12', { assignedUserId: String(fx.userW._id) }));
    assert.equal(assigned.status, 400);
    assert.equal((await call('POST', `/api/events/${fx.Done._id}/sub-events`, fx.x, subBody('Late'))).status, 409);
  });

  test('a legacy Main Event (no parentEventId field) takes sub-events too', async () => {
    const res = await call('POST', `/api/events/${fx.legacyId}/sub-events`, fx.x, subBody('Legacy Dinner', '2027-02-01'));
    assert.equal(res.status, 201);
    fx.legacySub = res.body;
  });
});

describe('listing and reading', () => {
  test('the default listing is Main Events only - legacy included - each with its sub-event count', async () => {
    const res = await call('GET', '/api/events', fx.x);
    assert.equal(res.status, 200);
    const names = res.body.map((e: any) => e.eventName).sort();
    assert.deepEqual(names, ['Finished', 'Legacy Gala', 'Other X Event', 'Wedding']);
    assert.equal(res.body.find((e: any) => e.eventName === 'Wedding').subEventCount, 3);
    assert.equal(res.body.find((e: any) => e.eventName === 'Other X Event').subEventCount, 0);
  });

  test('?parentEventId lists one Main Event\'s sub-events in date order, with member counts', async () => {
    const res = await call('GET', `/api/events?parentEventId=${fx.W._id}`, fx.x);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((e: any) => e.eventName), ['Mehendi', 'Haldi Ceremony', 'Reception']);
    assert.ok(res.body.every((e: any) => e.memberCount === 0));
    assert.equal((await call('GET', `/api/events?parentEventId=${fx.W._id}`, fx.y)).status, 403);
    assert.equal((await call('GET', `/api/events?parentEventId=${fx.haldi._id}`, fx.x)).status, 400);
    assert.equal((await call('GET', '/api/events?parentEventId=bogus', fx.x)).status, 400);
  });

  test('?includeSubEvents=true adds the sub-events, each naming its Main Event', async () => {
    const res = await call('GET', '/api/events?includeSubEvents=true', fx.x);
    const haldi = res.body.find((e: any) => e._id === fx.haldi._id);
    assert.equal(haldi.parentEvent.eventName, 'Wedding');
    assert.equal(res.body.length, 8);
  });

  test('a sub-event is reached through its Main Event: the Wedding\'s User may, another organizer may not', async () => {
    const own = await call('GET', `/api/events/${fx.haldi._id}`, fx.user);
    assert.equal(own.status, 200);
    assert.equal(own.body.parentEvent.eventName, 'Wedding');
    assert.equal(own.body.memberCount, 0);
    assert.equal((await call('GET', `/api/events/${fx.haldi._id}`, fx.y)).status, 403);

    const ids = await getAuthorizedEventIds({ id: String(fx.userW._id), role: 'User' });
    assert.ok(ids.includes(fx.haldi._id) && ids.includes(String(fx.W._id)));
    assert.equal(ids.includes(String(fx.O._id)), false);
  });

  test('the Main Event\'s detail counts its sub-events', async () => {
    const res = await call('GET', `/api/events/${fx.W._id}`, fx.x);
    assert.equal(res.body.subEventCount, 3);
    assert.equal(res.body.contactCount, 3);
  });

  test('editing a sub-event keeps its parent - nothing in the body can move it', async () => {
    const res = await call('PUT', `/api/events/${fx.haldi._id}`, fx.x, subBody('Haldi', '2027-01-13', { parentEventId: String(fx.O._id) }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.eventName, 'Haldi');
    assert.equal(res.body.parentEventId, String(fx.W._id));
    const assign = await call('PUT', `/api/events/${fx.haldi._id}`, fx.x, subBody('Haldi', '2027-01-13', { assignedUserId: String(fx.userW._id) }));
    assert.equal(assign.status, 400);
  });
});

describe('member lists', () => {
  test('a new sub-event has no members - the Main Event\'s guests are not copied', async () => {
    assert.deepEqual(await memberNames(fx.haldi._id), []);
    assert.deepEqual(await memberNames(fx.reception._id), []);
  });

  test('adding contacts manually, then in bulk; repeats are reported, never duplicated', async () => {
    const first = await addMembers(fx.haldi._id, [fx.w1._id]);
    assert.equal(first.status, 200);
    assert.equal(first.body.addedCount, 1);

    const bulk = await addMembers(fx.haldi._id, [fx.w1._id, fx.w2._id, fx.w3._id, fx.w2._id]);
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.equal(bulk.body.addedCount, 2);
    assert.equal(bulk.body.alreadyMemberCount, 1);
    assert.equal(bulk.body.memberCount, 3);
    assert.equal(await EventMember.countDocuments({ eventId: fx.haldi._id }), 3);

    const again = await addMembers(fx.haldi._id, [fx.w1._id, fx.w2._id]);
    assert.equal(again.status, 200);
    assert.equal(again.body.addedCount, 0);
    assert.equal(again.body.alreadyMemberCount, 2);
  });

  test('the same contact on two sub-events - one contact record, independent lists', async () => {
    const res = await addMembers(fx.reception._id, [fx.w1._id]);
    assert.equal(res.body.addedCount, 1);
    assert.deepEqual(await memberNames(fx.reception._id), ['Asha Wedding']);
    assert.equal(await Contact.countDocuments({ fullName: 'Asha Wedding' }), 1);
    assert.equal(await Contact.countDocuments({ eventId: fx.W._id }), 3, 'the Main Event\'s guest list is unchanged');
    assert.equal(await Contact.countDocuments({ eventId: fx.haldi._id }), 0, 'no contact is created on the sub-event');
  });

  test('removing a member touches only that sub-event', async () => {
    const res = await call('DELETE', `/api/events/${fx.haldi._id}/members/${fx.w1._id}`, fx.x);
    assert.equal(res.status, 200);
    assert.equal(res.body.memberCount, 2);
    assert.deepEqual(await memberNames(fx.haldi._id), ['Bala Wedding', 'Chitra Wedding']);
    assert.deepEqual(await memberNames(fx.reception._id), ['Asha Wedding'], 'still on Reception');
    assert.ok(await Contact.exists({ _id: fx.w1._id }), 'the contact itself remains');
    assert.equal((await call('DELETE', `/api/events/${fx.haldi._id}/members/${fx.w1._id}`, fx.x)).status, 404);
    assert.equal((await call('DELETE', `/api/events/${fx.haldi._id}/members/nope`, fx.x)).status, 400);
  });

  test('another organizer\'s contacts are refused, whoever asks - even a SuperAdmin', async () => {
    const x = await addMembers(fx.haldi._id, [fx.b1._id]);
    assert.equal(x.status, 403);
    assert.deepEqual(x.body.rejected, [{ id: String(fx.b1._id), reason: 'Access denied' }]);

    const sup = await addMembers(fx.haldi._id, [fx.b1._id, fx.s1._id], fx.super);
    assert.equal(sup.status, 403, 'Y\'s and the SuperAdmin\'s own contacts are not the Wedding organizer\'s');
    assert.equal(await EventMember.countDocuments({ contactId: { $in: [fx.b1._id, fx.s1._id] } }), 0);

    assert.equal((await addMembers(fx.haldi._id, [fx.w1._id], fx.y)).status, 403, 'nor may Y touch X\'s sub-event');
  });

  test('the same organizer\'s contacts from another of their events may be added', async () => {
    const res = await addMembers(fx.haldi._id, [fx.o1._id], fx.super);
    assert.equal(res.status, 200);
    assert.equal(res.body.addedCount, 1);
  });

  test('a mixed request reports every id and is not presented as complete', async () => {
    const unknown = new mongoose.Types.ObjectId();
    const res = await call('POST', `/api/events/${fx.haldi._id}/members`, fx.x, {
      contactIds: [String(fx.w3._id), String(fx.w1._id), String(fx.b1._id), 'abc', String(unknown)],
    });
    assert.equal(res.status, 207);
    assert.equal(res.body.addedCount, 1);
    assert.equal(res.body.alreadyMemberCount, 1);
    assert.deepEqual(res.body.rejected.map((r: any) => r.reason).sort(), ['Access denied', 'Contact not found', 'Invalid contact id']);
  });

  test('request bounds and body validation', async () => {
    assert.equal((await call('POST', `/api/events/${fx.haldi._id}/members`, fx.x, { contactIds: [] })).status, 400);
    assert.equal((await call('POST', `/api/events/${fx.haldi._id}/members`, fx.x, { contactIds: 'x' })).status, 400);
    const many = Array.from({ length: 501 }, () => String(new mongoose.Types.ObjectId()));
    assert.equal((await call('POST', `/api/events/${fx.haldi._id}/members`, fx.x, { contactIds: many })).status, 400);
  });

  test('counts are of members whose contact exists - a stray membership never inflates them', async () => {
    const before = (await call('GET', `/api/events/${fx.haldi._id}`, fx.x)).body.memberCount;
    // A membership left pointing at a contact that no longer exists (as a
    // contact deleted mid-add could leave): written straight to the database.
    await EventMember.collection.insertOne({ eventId: new mongoose.Types.ObjectId(fx.haldi._id), contactId: new mongoose.Types.ObjectId() });
    assert.equal((await call('GET', `/api/events/${fx.haldi._id}`, fx.x)).body.memberCount, before);
    const listed = (await call('GET', `/api/events?parentEventId=${fx.W._id}`, fx.x)).body.find((e: any) => e._id === fx.haldi._id);
    assert.equal(listed.memberCount, before);
    const page = await call('GET', `/api/events/${fx.haldi._id}/members?page=1&limit=50`, fx.x);
    assert.equal(page.body.memberCount, before);
    assert.equal(page.body.pagination.total, before, 'the count and the list agree');
    await EventMember.collection.deleteMany({ eventId: new mongoose.Types.ObjectId(fx.haldi._id), contactId: { $nin: (await Contact.find().select('_id').lean()).map((c: any) => c._id) } });
  });

  test('a Main Event has no member list - its guests are its contacts', async () => {
    assert.equal((await call('GET', `/api/events/${fx.W._id}/members`, fx.x)).status, 400);
    assert.equal((await addMembers(fx.W._id, [fx.w1._id])).status, 400);
  });

  test('the member list pages and searches', async () => {
    const res = await call('GET', `/api/events/${fx.haldi._id}/members?page=1&limit=2`, fx.x);
    assert.equal(res.status, 200);
    assert.equal(res.body.pagination.total, 4);
    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.memberCount, 4);
    assert.equal(res.body.data[0].sourceEvent.eventName, 'Wedding');
    const found = await call('GET', `/api/events/${fx.haldi._id}/members?search=dev&page=1&limit=10`, fx.x);
    assert.deepEqual(found.body.data.map((c: any) => c.fullName), ['Dev Other']);
    assert.equal((await call('GET', `/api/events/${fx.haldi._id}/members`, fx.user)).status, 200, 'the Wedding\'s User may view it');
  });

  test('candidates: the caller\'s own events of the same organizer, marked when already members', async () => {
    const res = await call('GET', `/api/events/${fx.reception._id}/member-candidates?page=1&limit=50`, fx.super);
    assert.equal(res.status, 200);
    const sources = res.body.sources.map((s: any) => s.eventName).sort();
    assert.deepEqual(sources, ['Finished', 'Legacy Gala', 'Other X Event', 'Wedding']);
    const names = res.body.data.map((c: any) => c.fullName).sort();
    assert.deepEqual(names, ['Asha Wedding', 'Bala Wedding', 'Chitra Wedding', 'Dev Other']);
    assert.equal(res.body.data.find((c: any) => c.fullName === 'Asha Wedding').isMember, true);
    assert.equal(res.body.data.find((c: any) => c.fullName === 'Bala Wedding').isMember, false);

    const one = await call('GET', `/api/events/${fx.reception._id}/member-candidates?sourceEventId=${fx.W._id}`, fx.x);
    assert.equal(one.body.data.length, 3);
    assert.equal((await call('GET', `/api/events/${fx.reception._id}/member-candidates?sourceEventId=${fx.B._id}`, fx.super)).status, 403);
  });
});

describe('guest lists, contacts and messaging', () => {
  test('a sub-event\'s guest list is its members only - the composer and send preview read it', async () => {
    const res = await call('GET', `/api/contacts/event/${fx.reception._id}`, fx.x);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((c: any) => c.fullName), ['Asha Wedding']);
    const main = await call('GET', `/api/contacts/event/${fx.W._id}`, fx.x);
    assert.equal(main.body.length, 3, 'the Main Event\'s guest list is as before');
  });

  test('campaign and template recipients resolve to the sub-event\'s members only', async () => {
    const reception = await Event.findById(fx.reception._id).lean();
    const recipients = await Contact.find(await eventGuestFilter(reception)).lean();
    assert.deepEqual(recipients.map((c: any) => c.fullName), ['Asha Wedding']);
    assert.ok(await findEventGuest(reception, fx.w1._id));
    assert.equal(await findEventGuest(reception, fx.w2._id), null, 'a Wedding guest not on Reception\'s list');
    const wedding = await Event.findById(fx.W._id).lean();
    assert.equal((await Contact.find(await eventGuestFilter(wedding)).lean()).length, 3);
  });

  test('a User is assigned to the Main Event, never straight to a sub-event', async () => {
    const assign = await call('PUT', `/api/admin/users/${fx.userW._id}/assign-event`, fx.x, { eventId: fx.haldi._id });
    assert.equal(assign.status, 400);
    assert.match(assign.body.error, /main event/);
    const pending = await User.create({ name: 'Pending Guest', email: 'pending@example.com', passwordHash: 'x', status: 'Pending' });
    const approve = await call('PUT', `/api/admin/users/${pending._id}/approve?type=User`, fx.super, { assignedEventId: fx.haldi._id });
    assert.equal(approve.status, 400);
    const stored = await User.findById(pending._id).lean();
    assert.equal(stored.status, 'Pending', 'nothing was changed');
    assert.equal(stored.assignedEventId, undefined);
    assert.equal(String((await User.findById(fx.userW._id).lean()).assignedEventId), String(fx.W._id), 'still the Wedding');
    assert.deepEqual((await Event.findById(fx.haldi._id).lean()).assignedUserIds, []);
  });

  test('contacts are added to the Main Event, never straight into a sub-event', async () => {
    const res = await call('POST', '/api/contacts', fx.x, { fullName: 'New Guest', phoneNumber: '9812345678', countryCode: 'IN', eventId: fx.haldi._id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /main event/);
    const imp = await call('POST', `/api/contacts/event/${fx.haldi._id}/import`, fx.x, { contacts: [{ fullName: 'A', phoneNumber: '9812345679' }] });
    assert.equal(imp.status, 400);
  });

  test('deleting a contact takes it off every member list', async () => {
    const res = await call('DELETE', `/api/contacts/${fx.w2._id}`, fx.x);
    assert.equal(res.status, 200);
    assert.equal(await EventMember.countDocuments({ contactId: fx.w2._id }), 0);
    assert.equal((await call('GET', `/api/events/${fx.haldi._id}`, fx.x)).body.memberCount, 3);
  });

  test('deleting a Main Event with no sub-events takes its guests off other events\' member lists', async () => {
    assert.ok(await EventMember.exists({ eventId: fx.haldi._id, contactId: fx.o1._id }));
    const res = await call('DELETE', `/api/events/${fx.O._id}`, fx.x);
    assert.equal(res.status, 200);
    assert.equal(await EventMember.countDocuments({ contactId: fx.o1._id }), 0);
  });
});

describe('deletion', () => {
  test('a Main Event with sub-events is not deleted - singly or in bulk', async () => {
    const res = await call('DELETE', `/api/events/${fx.W._id}`, fx.x);
    assert.equal(res.status, 409);
    assert.equal(res.body.subEventCount, 3);
    assert.match(res.body.error, /Delete the sub-events first/);
    const bulk = await call('POST', '/api/events/bulk-delete', fx.x, { ids: [String(fx.W._id)] });
    assert.equal(bulk.status, 400);
    assert.match(bulk.body.failed[0].reason, /sub-events/);
    assert.ok(await Event.exists({ _id: fx.W._id }));
  });

  test('a User cannot delete a sub-event; another organizer cannot either', async () => {
    assert.equal((await call('DELETE', `/api/events/${fx.reception._id}`, fx.user)).status, 403);
    assert.equal((await call('DELETE', `/api/events/${fx.reception._id}`, fx.y)).status, 403);
  });

  test('deleting a sub-event removes its member list only - contacts and other lists remain', async () => {
    const before = await Contact.countDocuments({ eventId: fx.W._id });
    const haldiMembers = await EventMember.countDocuments({ eventId: fx.haldi._id });
    assert.ok(haldiMembers > 0);
    const res = await call('DELETE', `/api/events/${fx.reception._id}`, fx.x);
    assert.equal(res.status, 200);
    assert.equal(await EventMember.countDocuments({ eventId: fx.reception._id }), 0);
    assert.equal(await Contact.countDocuments({ eventId: fx.W._id }), before);
    assert.equal(await EventMember.countDocuments({ eventId: fx.haldi._id }), haldiMembers);
    assert.ok(await Event.exists({ _id: fx.W._id }), 'the Main Event remains');
  });

  test('once its sub-events are gone, the Main Event deletes as before', async () => {
    for (const sub of [fx.haldi, fx.mehendi]) {
      assert.equal((await call('DELETE', `/api/events/${sub._id}`, fx.x)).status, 200);
    }
    const res = await call('DELETE', `/api/events/${fx.W._id}`, fx.x);
    assert.equal(res.status, 200);
    assert.equal(await Contact.countDocuments({ eventId: fx.W._id }), 0);
    assert.equal(await EventMember.countDocuments({}), 0, 'no membership is left behind');
    assert.equal(await Event.countDocuments({ parentEventId: fx.W._id }), 0, 'no orphaned sub-event');
  });
});
