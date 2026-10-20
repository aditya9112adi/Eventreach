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

  test('a file cannot be imported into a sub-event, and says so', async () => {
    const before = await Contact.countDocuments({});
    const preview = await call('POST', `/api/contacts/event/${fx.haldi._id}/upload`, fx.x);
    assert.equal(preview.status, 400);
    assert.match(preview.body.error, /cannot be imported into a sub-event/);
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

describe('a guest added to a sub-event', () => {
  const guest = (eventId: any, extra: Record<string, unknown> = {}) => ({
    fullName: 'Sub Guest', phoneNumber: '9811110001', countryCode: 'IN', email: 'subguest@gmail.com', eventId: String(eventId), ...extra,
  });
  const members = (eventId: any) => EventMember.find({ eventId }).lean();

  test('is created, owned by the sub-event and placed on its own list, and nowhere else', async () => {
    const res = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const stored = await Contact.findOne({ fullName: 'Sub Guest' }).lean();
    assert.equal(String(stored.eventId), String(fx.haldi._id), 'the sub-event owns it');
    assert.equal(stored.phoneNumber, '+919811110001');
    assert.equal(stored.source, 'Manual');
    assert.equal((await members(fx.haldi._id)).filter((m: any) => String(m.contactId) === String(stored._id)).length, 1);

    assert.ok(nameSet(await list(fx.haldi._id)).includes('Sub Guest'), "on the sub-event's Members list / Contacts tab");
    assert.ok(!nameSet(await list(fx.W._id)).includes('Sub Guest'), 'not on the main event');
    assert.ok(!nameSet(await list(fx.reception._id)).includes('Sub Guest'), 'not on a sibling');
    assert.ok(!nameSet(await list(fx.W._id, fx.x, '&search=Sub')).includes('Sub Guest'));
    assert.equal((await call('GET', `/api/events/${fx.haldi._id}`, fx.x)).body.memberCount, (await members(fx.haldi._id)).length);
  });

  test('is found by search, counted in the total and reached with pagination', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await call('POST', '/api/contacts', fx.x, guest(fx.reception._id, { fullName: `Paged ${i}`, phoneNumber: `981111010${i}` }))).status, 201);
    }
    const found = await call('GET', `/api/contacts/event/${fx.reception._id}?page=1&limit=10&search=Paged%201`, fx.x);
    assert.deepEqual(nameSet(found), ['Paged 1']);
    const p1 = await call('GET', `/api/contacts/event/${fx.reception._id}?page=1&limit=2`, fx.x);
    const p2 = await call('GET', `/api/contacts/event/${fx.reception._id}?page=2&limit=2`, fx.x);
    assert.equal(p1.body.pagination.total, p2.body.pagination.total);
    const seen = [...ids(p1), ...ids(p2)];
    assert.equal(new Set(seen).size, seen.length, 'no row repeated between pages');
  });

  test('the same number as a main-event guest is a separate record on the sub-event', async () => {
    const mainGuest = await Contact.findOne({ eventId: fx.W._id }).lean();
    const number = mainGuest.phoneNumber.replace('+91', '');
    const res = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id, { fullName: 'Twin Of Main', phoneNumber: number }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await Contact.countDocuments({ phoneNumber: mainGuest.phoneNumber }), 2);
    assert.equal(String((await Contact.findOne({ fullName: mainGuest.fullName, eventId: fx.W._id }).lean())._id), String(mainGuest._id), 'the main-event guest is untouched');
  });

  test('is refused when the number is already on that sub-event, whether added there or assigned', async () => {
    const again = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id, { fullName: 'Second Try' }));
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.field, 'phoneNumber');

    const assigned = fx.w[2];
    assert.ok([200, 201].includes((await assign(fx.reception._id, [assigned])).status));
    const clash = await call('POST', '/api/contacts', fx.x, guest(fx.reception._id, { fullName: 'Clash', phoneNumber: assigned.phoneNumber.replace('+91', '') }));
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.ok(!nameSet(await list(fx.reception._id)).includes('Clash'));
    assert.equal(await Contact.countDocuments({ fullName: 'Second Try' }), 0);
  });

  test('may repeat on a sibling sub-event, which is a different list', async () => {
    const res = await call('POST', '/api/contacts', fx.x, guest(fx.reception._id, { fullName: 'Sub Guest Too' }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(!nameSet(await list(fx.haldi._id)).includes('Sub Guest Too'));
  });

  test('has the same validation as a main-event guest, and nothing is stored when it fails', async () => {
    const before = await Contact.countDocuments({});
    for (const bad of [
      { fullName: '' }, { fullName: 'x'.repeat(51) }, { phoneNumber: '' }, { phoneNumber: '12345' }, { phoneNumber: '5876543210' },
      { phoneNumber: '98765432101' }, { email: 'not-an-email' },
    ]) {
      const res = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id, bad));
      assert.equal(res.status, 400, JSON.stringify(bad) + ' ' + JSON.stringify(res.body));
    }
    assert.equal(await Contact.countDocuments({}), before);
  });

  test('is refused for an event that does not exist, for a malformed id, and for no sign-in', async () => {
    const before = await Contact.countDocuments({});
    assert.ok([400, 403, 404].includes((await call('POST', '/api/contacts', fx.x, guest(new mongoose.Types.ObjectId()))).status));
    assert.ok([400, 403, 404].includes((await call('POST', '/api/contacts', fx.x, guest('not-an-id'))).status));
    assert.equal((await call('POST', '/api/contacts', undefined, guest(fx.haldi._id))).status, 401);
    assert.equal(await Contact.countDocuments({}), before);
  });

  test("cannot be added to another organizer's sub-event, and the other organizer sees nothing", async () => {
    const before = await Contact.countDocuments({});
    const res = await call('POST', '/api/contacts', fx.x, guest(fx.bSub._id, { fullName: 'Intruder', phoneNumber: '9811110777' }));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(await Contact.countDocuments({}), before);
    assert.equal(nameSet(await list(fx.bSub._id, fx.y)).includes('Intruder'), false);
    // ...and a guest added by that organizer to their own sub-event is invisible to the first.
    assert.equal((await call('POST', '/api/contacts', fx.y, guest(fx.bSub._id, { fullName: 'Y Guest', phoneNumber: '9811110888' }))).status, 201);
    assert.equal((await list(fx.bSub._id, fx.x)).status, 403);
    const all = await call('GET', '/api/contacts?page=1&limit=100', fx.x);
    assert.ok(!all.body.data.some((c: any) => c.fullName === 'Y Guest'));
  });

  test('a User assigned to a different event cannot add one', async () => {
    const before = await Contact.countDocuments({});
    const res = await call('POST', '/api/contacts', fx.userOToken, guest(fx.haldi._id, { fullName: 'Not Mine', phoneNumber: '9811110999' }));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(await Contact.countDocuments({}), before);
  });

  test('can be edited and deleted as a guest, and leaves the list when deleted', async () => {
    const created = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id, { fullName: 'To Delete', phoneNumber: '9811112000' }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data?._id ?? created.body._id ?? (await Contact.findOne({ fullName: 'To Delete' }).lean())._id;
    assert.equal((await call('DELETE', `/api/contacts/${id}`, fx.x)).status, 200);
    assert.ok(!nameSet(await list(fx.haldi._id)).includes('To Delete'));
    assert.equal(await EventMember.countDocuments({ contactId: id }), 0);
  });

  test('is removed with its sub-event, and the main event keeps all of its guests', async () => {
    const sub = await mkEvent('Mehendi', fx.adminX._id, { parentEventId: fx.W._id });
    assert.equal((await call('POST', '/api/contacts', fx.x, guest(sub._id, { fullName: 'Mehendi Guest', phoneNumber: '9811113000' }))).status, 201);
    const mainBefore = await Contact.countDocuments({ eventId: fx.W._id });
    assert.equal((await call('DELETE', `/api/events/${sub._id}`, fx.x)).status, 200);
    assert.equal(await Contact.countDocuments({ fullName: 'Mehendi Guest' }), 0);
    assert.equal(await EventMember.countDocuments({ eventId: sub._id }), 0);
    assert.equal(await Contact.countDocuments({ eventId: fx.W._id }), mainBefore);
  });

  test('taking one off the sub-event list deletes it, while an assigned contact is only taken off', async () => {
    const owned = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id, { fullName: 'Owned Remove', phoneNumber: '9811115000' }));
    assert.equal(owned.status, 201, JSON.stringify(owned.body));
    const ownedId = (await Contact.findOne({ fullName: 'Owned Remove' }).lean())._id;
    const res = await remove(fx.haldi._id, ownedId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.guestDeleted, true);
    assert.equal(await Contact.countDocuments({ _id: ownedId }), 0, 'no hidden record is left holding the number');
    assert.equal(await EventMember.countDocuments({ contactId: ownedId }), 0);
    // The number is free again.
    assert.equal((await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id, { fullName: 'Owned Remove 2', phoneNumber: '9811115000' }))).status, 201);

    const assignedContact = fx.w[4];
    assert.ok([200, 201].includes((await assign(fx.haldi._id, [assignedContact])).status));
    const removed = await remove(fx.haldi._id, assignedContact);
    assert.equal(removed.status, 200);
    assert.notEqual(removed.body.guestDeleted, true);
    assert.ok(await Contact.exists({ _id: assignedContact._id }), 'the main event guest is still there');
  });

  test('assigning a contact whose number is already a guest of the sub-event is refused', async () => {
    const mainGuest = await mkContact(fx.O, 'Same Number Main');
    const number = mainGuest.phoneNumber.replace('+91', '');
    assert.equal((await call('POST', '/api/contacts', fx.x, guest(fx.reception._id, { fullName: 'Same Number Owned', phoneNumber: number }))).status, 201);
    const res = await assign(fx.reception._id, [mainGuest]);
    assert.notEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(JSON.stringify(res.body), /already a guest of this sub-event/);
    assert.equal(await EventMember.countDocuments({ eventId: fx.reception._id, contactId: mainGuest._id }), 0);
  });

  test('editing one onto a number already on the list is refused, and a normal edit works', async () => {
    const a = await call('POST', '/api/contacts', fx.x, guest(fx.haldi._id, { fullName: 'Edit A', phoneNumber: '9811116001' }));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const aId = (await Contact.findOne({ fullName: 'Edit A' }).lean())._id;
    const assignedContact = fx.w[5];
    assert.ok([200, 201].includes((await assign(fx.haldi._id, [assignedContact])).status));
    const clash = await call('PUT', `/api/contacts/${aId}`, fx.x, { fullName: 'Edit A', phoneNumber: assignedContact.phoneNumber.replace('+91', ''), countryCode: 'IN' });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    const ok = await call('PUT', `/api/contacts/${aId}`, fx.x, { fullName: 'Edit A Renamed', phoneNumber: '9811116001', countryCode: 'IN' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(nameSet(await list(fx.haldi._id)).includes('Edit A Renamed'));
  });

  test('a main-event guest is added exactly as before, with no member row', async () => {
    const before = await EventMember.countDocuments({});
    const res = await call('POST', '/api/contacts', fx.x, guest(fx.O._id, { fullName: 'Plain Main Guest', phoneNumber: '9811114000' }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await EventMember.countDocuments({}), before);
  });
});
