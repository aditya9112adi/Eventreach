import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * The Contacts tab with Sub-Events, over real HTTP against the REAL compiled backend
 * (routes, middleware, controllers, models from backend/dist) on a throwaway database.
 *
 *   GET    /api/events?includeSubEvents=true          what the selector offers
 *   GET    /api/contacts/event/:id                    an event's guests, or a sub-event's members
 *   POST   /api/events/:id/members                    assign existing contacts to a sub-event
 *   DELETE /api/events/:id/members/:contactId         take one off that sub-event's list
 *   POST   /api/contacts, /contacts/event/:id/import  guests: main events only
 *
 * What is proved: the selector's data, that a sub-event lists only the contacts assigned to it,
 * that assigning (one or many) never duplicates and never touches the main event or another
 * sub-event, that nobody can list, assign or remove across events they may not use, and that a
 * sub-event refuses guest creation and import. Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_contactssub_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const contactRoutes = require('../backend/dist/routes/contactRoutes').default;
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { EventMember } = require('../backend/dist/models/EventMember');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');

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
const mkEvent = (eventName: string, adminId: any, extra: Record<string, any> = {}) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9000000001'), eventName, eventType: 'Wedding',
    eventDate: at('2030-06-01'), eventTime: at('2030-06-01'), eventVenue: 'Hall', eventStatus: 'Upcoming', adminId, createdBy: adminId, ...extra,
  });
let phoneSeq = 0;
const mkContact = (event: any, fullName: string) =>
  Contact.create({ fullName, phoneNumber: `+9190000${String(20000 + phoneSeq++)}`, countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid' });

before(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([Event.init(), Contact.init(), EventMember.init()]);

  fx.adminX = await mkAdmin('Admin X', 'Admin');
  fx.adminY = await mkAdmin('Admin Y', 'Admin');

  fx.W = await mkEvent('Sharma Wedding', fx.adminX._id);
  fx.O = await mkEvent('Other X Event', fx.adminX._id);
  fx.haldi = await mkEvent('Haldi', fx.adminX._id, { parentEventId: fx.W._id });
  fx.reception = await mkEvent('Reception', fx.adminX._id, { parentEventId: fx.W._id });
  fx.B = await mkEvent('Y Birthday', fx.adminY._id);
  fx.bSub = await mkEvent('Y Cake Cutting', fx.adminY._id, { parentEventId: fx.B._id });

  fx.names = ['Asha Rao', 'Bala Kumar', 'Chitra Nair', 'Dev Patel', 'Esha Shah', 'Farah Khan'];
  fx.w = [] as any[];
  for (const name of fx.names) fx.w.push(await mkContact(fx.W, name));
  fx.o1 = await mkContact(fx.O, 'Gita Menon');
  fx.b1 = await mkContact(fx.B, 'Hari Iyer');

  fx.userW = await User.create({ name: 'Wedding Helper', email: 'helper@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.W._id });
  fx.userO = await User.create({ name: 'Other Helper', email: 'otherhelper@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.O._id });

  fx.x = tokenFor(fx.adminX, 'Admin');
  fx.y = tokenFor(fx.adminY, 'Admin');
  fx.userWToken = tokenFor(fx.userW, 'User');
  fx.userOToken = tokenFor(fx.userO, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/events', eventRoutes);
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

const list = (eventId: any, token = fx.x, query = '') => call('GET', `/api/contacts/event/${eventId}?page=1&limit=10${query}`, token);
const assign = (subId: any, contacts: any[], token = fx.x) => call('POST', `/api/events/${subId}/members`, token, { contactIds: contacts.map((c) => String(c._id ?? c)) });
const remove = (subId: any, contact: any, token = fx.x) => call('DELETE', `/api/events/${subId}/members/${contact._id ?? contact}`, token);
const nameSet = (res: Res) => res.body.data.map((c: any) => c.fullName).sort();
const ids = (res: Res) => res.body.data.map((c: any) => String(c._id)).sort();

describe("the selector's data", () => {
  test('main events and sub-events both come back, each sub-event naming its main event, only the caller\'s own', async () => {
    const res = await call('GET', '/api/events?includeSubEvents=true', fx.x);
    assert.equal(res.status, 200);
    const byName = Object.fromEntries(res.body.map((e: any) => [e.eventName, e]));
    assert.deepEqual(Object.keys(byName).sort(), ['Haldi', 'Other X Event', 'Reception', 'Sharma Wedding']);
    assert.equal(byName['Sharma Wedding'].parentEventId ?? null, null);
    assert.equal(byName['Sharma Wedding'].subEventCount, 2);
    for (const sub of ['Haldi', 'Reception']) {
      assert.equal(String(byName[sub].parentEventId), String(fx.W._id));
      assert.equal(byName[sub].parentEvent.eventName, 'Sharma Wedding');
      assert.ok(byName[sub].eventId, 'it has an identifier of its own');
    }
    assert.equal(byName['Y Birthday'], undefined, "another organizer's events are not offered");
    assert.equal(byName['Y Cake Cutting'], undefined);
  });

  test('without the option the list is main events only, as before', async () => {
    const res = await call('GET', '/api/events', fx.x);
    assert.deepEqual(res.body.map((e: any) => e.eventName).sort(), ['Other X Event', 'Sharma Wedding']);
  });

  test('a User sees their own event and its sub-events only', async () => {
    const forW = await call('GET', '/api/events?includeSubEvents=true', fx.userWToken);
    assert.deepEqual(forW.body.map((e: any) => e.eventName).sort(), ['Haldi', 'Reception', 'Sharma Wedding']);
    const forO = await call('GET', '/api/events?includeSubEvents=true', fx.userOToken);
    assert.deepEqual(forO.body.map((e: any) => e.eventName), ['Other X Event']);
  });

  test("another organizer sees only their own, sub-event included", async () => {
    const res = await call('GET', '/api/events?includeSubEvents=true', fx.y);
    assert.deepEqual(res.body.map((e: any) => e.eventName).sort(), ['Y Birthday', 'Y Cake Cutting']);
  });
});

describe("a sub-event's own contacts", () => {
  test('an empty sub-event lists no one - the main event\'s guests are not copied into it', async () => {
    const res = await list(fx.haldi._id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.pagination.total, 0);
    assert.equal((await list(fx.W._id)).body.pagination.total, 6, 'the main event still has all its guests');
  });

  test('assigning one contact: the sub-event lists exactly it; the main event and the other sub-event are unchanged', async () => {
    const res = await assign(fx.haldi._id, [fx.w[0]]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.addedCount, 1);
    assert.deepEqual(nameSet(await list(fx.haldi._id)), ['Asha Rao']);
    assert.deepEqual(ids(await list(fx.W._id)), fx.w.map((c: any) => String(c._id)).sort(), 'main event: untouched');
    assert.deepEqual((await list(fx.reception._id)).body.data, [], 'the sibling sub-event: untouched');
  });

  test('assigning several at once adds each, and a repeat is reported and never duplicated', async () => {
    const res = await assign(fx.haldi._id, [fx.w[1], fx.w[2], fx.w[3]]);
    assert.equal(res.body.addedCount, 3);
    assert.equal((await list(fx.haldi._id)).body.pagination.total, 4);

    const again = await assign(fx.haldi._id, [fx.w[0], fx.w[1], fx.w[4]]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.addedCount, 1, 'only the new one');
    assert.equal(again.body.alreadyMemberCount, 2, 'the repeats are reported');
    assert.equal((await list(fx.haldi._id)).body.pagination.total, 5);
    assert.equal(await EventMember.countDocuments({ eventId: fx.haldi._id, contactId: fx.w[0]._id }), 1, 'one membership, whatever was sent');

    const same = await assign(fx.haldi._id, [fx.w[0], fx.w[0]]);
    assert.equal(same.body.addedCount, 0);
  });

  test('no contact record is created or copied by assigning', async () => {
    assert.equal(await Contact.countDocuments({}), 8, 'six wedding guests, one other-event guest, one of another organizer');
  });

  test('searching within a sub-event finds only its members', async () => {
    assert.deepEqual(nameSet(await list(fx.haldi._id, fx.x, '&search=asha')), ['Asha Rao']);
    const phone = fx.w[1].phoneNumber.slice(-5);
    assert.deepEqual(nameSet(await list(fx.haldi._id, fx.x, `&search=${phone}`)), ['Bala Kumar']);
    assert.deepEqual((await list(fx.haldi._id, fx.x, '&search=farah')).body.data, [], 'a guest of the main event who is not a member is not found');
    assert.equal((await list(fx.W._id, fx.x, '&search=farah')).body.data.length, 1, 'but the main event still finds her');
  });

  test('a sub-event list pages like any other, with the total across pages', async () => {
    const first = await call('GET', `/api/contacts/event/${fx.haldi._id}?page=1&limit=2`, fx.x);
    const second = await call('GET', `/api/contacts/event/${fx.haldi._id}?page=2&limit=2`, fx.x);
    const third = await call('GET', `/api/contacts/event/${fx.haldi._id}?page=3&limit=2`, fx.x);
    assert.equal(first.body.pagination.total, 5);
    assert.equal(first.body.pagination.totalPages, 3);
    assert.deepEqual([first.body.data.length, second.body.data.length, third.body.data.length], [2, 2, 1]);
    const all = [...first.body.data, ...second.body.data, ...third.body.data].map((c: any) => String(c._id));
    assert.equal(new Set(all).size, 5, 'no contact repeats and none is skipped');
  });

  test("a contact of another of the organizer's events can be assigned, and nothing in that event changes", async () => {
    const res = await assign(fx.reception._id, [fx.o1]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(nameSet(await list(fx.reception._id)), ['Gita Menon']);
    assert.deepEqual(nameSet(await list(fx.O._id)), ['Gita Menon']);
    assert.equal((await list(fx.W._id)).body.pagination.total, 6, 'and the wedding is untouched');
  });
});

describe('independent lists', () => {
  test('the same contact on two sub-events is one contact with two memberships', async () => {
    const res = await assign(fx.reception._id, [fx.w[0]]);
    assert.equal(res.body.addedCount, 1);
    assert.ok(ids(await list(fx.haldi._id)).includes(String(fx.w[0]._id)));
    assert.ok(ids(await list(fx.reception._id)).includes(String(fx.w[0]._id)));
    assert.equal(await Contact.countDocuments({ phoneNumber: fx.w[0].phoneNumber }), 1, 'one record');
  });

  test('removing it from one sub-event leaves it on the other and on the main event, and the contact itself', async () => {
    const res = await remove(fx.haldi._id, fx.w[0]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!ids(await list(fx.haldi._id)).includes(String(fx.w[0]._id)));
    assert.ok(ids(await list(fx.reception._id)).includes(String(fx.w[0]._id)), 'still on the other sub-event');
    assert.ok(ids(await list(fx.W._id)).includes(String(fx.w[0]._id)), 'still a guest of the main event');
    assert.ok(await Contact.exists({ _id: fx.w[0]._id }), 'the contact is not deleted');
  });

  test('removing a contact that is not on the list is refused, and changes nothing', async () => {
    const before = (await list(fx.haldi._id)).body.pagination.total;
    assert.equal((await remove(fx.haldi._id, fx.w[0])).status, 404);
    assert.equal((await list(fx.haldi._id)).body.pagination.total, before);
  });

  test("deleting a guest from the main event takes it off every sub-event list", async () => {
    const guest = await mkContact(fx.W, 'Temporary Guest');
    await assign(fx.haldi._id, [guest]);
    await assign(fx.reception._id, [guest]);
    assert.equal((await call('DELETE', `/api/contacts/${guest._id}`, fx.x)).status, 200);
    assert.ok(!nameSet(await list(fx.haldi._id)).includes('Temporary Guest'));
    assert.ok(!nameSet(await list(fx.reception._id)).includes('Temporary Guest'));
  });
});

describe('authorization is enforced by the server', () => {
  test("another organizer cannot list a sub-event's contacts", async () => {
    assert.equal((await list(fx.haldi._id, fx.y)).status, 403);
  });

  test("another organizer cannot assign to, or remove from, this organizer's sub-event", async () => {
    const before = await EventMember.countDocuments({ eventId: fx.haldi._id });
    assert.equal((await assign(fx.haldi._id, [fx.w[5]], fx.y)).status, 403);
    assert.equal((await remove(fx.haldi._id, fx.w[1], fx.y)).status, 403);
    assert.equal(await EventMember.countDocuments({ eventId: fx.haldi._id }), before, 'nothing changed');
  });

  test("another organizer's contacts cannot be assigned to this organizer's sub-event", async () => {
    const res = await assign(fx.haldi._id, [fx.b1]);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.addedCount, 0);
    assert.equal(await EventMember.countDocuments({ eventId: fx.haldi._id, contactId: fx.b1._id }), 0);
  });

  test("and this organizer's contacts cannot be assigned into the other organizer's sub-event", async () => {
    const res = await assign(fx.bSub._id, [fx.w[5]], fx.y);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual((await list(fx.bSub._id, fx.y)).body.data, []);
  });

  test('a User assigned to a different event can neither list nor assign', async () => {
    assert.equal((await list(fx.haldi._id, fx.userOToken)).status, 403);
    assert.equal((await assign(fx.haldi._id, [fx.w[5]], fx.userOToken)).status, 403);
  });

  test("a User assigned to the main event may see its sub-event's contacts", async () => {
    const res = await list(fx.haldi._id, fx.userWToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.pagination.total >= 1);
  });

  test('no sign-in is refused', async () => {
    assert.equal((await call('GET', `/api/contacts/event/${fx.haldi._id}`)).status, 401);
    assert.equal((await call('POST', `/api/events/${fx.haldi._id}/members`, undefined, { contactIds: [String(fx.w[5]._id)] })).status, 401);
  });
});

describe('what a sub-event refuses', () => {
  const guest = (eventId: any, extra: Record<string, unknown> = {}) => ({
    fullName: 'New Guest', phoneNumber: '9876543211', countryCode: 'IN', email: 'newguest@gmail.com', eventId: String(eventId), ...extra,
  });

  test('a guest cannot be created on a sub-event, and nothing is stored', async () => {
    const before = await Contact.countDocuments({});
    const res = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Guests are added to the main event/);
    assert.equal(await Contact.countDocuments({}), before);
  });

  test('a file cannot be imported into a sub-event', async () => {
    const before = await Contact.countDocuments({});
    const preview = await call('POST', `/api/contacts/event/${fx.haldi._id}/upload`, fx.x);
    assert.equal(preview.status, 400);
    const imported = await call('POST', `/api/contacts/event/${fx.haldi._id}/import`, fx.x, { contacts: [{ fullName: 'Imported', phoneNumber: '9876543212', status: 'Valid' }] });
    assert.equal(imported.status, 400);
    assert.equal(await Contact.countDocuments({}), before);
  });

  test('the main event still takes a guest, which then belongs to it and to no sub-event', async () => {
    const res = await call('POST', '/api/contacts', fx.x, guest(fx.W._id));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(nameSet(await list(fx.W._id)).includes('New Guest'));
    assert.ok(!nameSet(await list(fx.haldi._id)).includes('New Guest'));
    assert.ok(!nameSet(await list(fx.reception._id)).includes('New Guest'));
  });

  test('the main event still takes an imported file, with the same duplicate rule', async () => {
    const res = await call('POST', `/api/contacts/event/${fx.W._id}/import`, fx.x, {
      contacts: [
        { fullName: 'Imported Guest', phoneNumber: '9876543212', status: 'Valid' },
        { fullName: 'Imported Again', phoneNumber: '9876543212', status: 'Valid' },
      ],
    });
    assert.ok([200, 201, 207].includes(res.status), JSON.stringify(res.body));
    assert.equal(res.body.importedCount, 1, 'the repeat in the same file is skipped');
    assert.ok(nameSet(await list(fx.W._id)).includes('Imported Guest'));
    assert.ok(!nameSet(await list(fx.haldi._id)).includes('Imported Guest'));
  });

  test("a main event's list is its own guests, whatever has been assigned to its sub-events", async () => {
    const main = await list(fx.W._id);
    const guestNames = nameSet(main);
    for (const name of fx.names) assert.ok(guestNames.includes(name), name);
    assert.equal(guestNames.includes('Gita Menon'), false, "a guest of another event, assigned to a sub-event, did not join the main event");
  });
});
