import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * The Dashboard's numbers, over real HTTP against the REAL compiled backend
 * (routes, middleware, controllers, models from backend/dist) on a throwaway
 * database.
 *
 *   GET /api/dashboard/stats?status=&eventId=
 *   GET /api/dashboard/activity?status=&eventId=
 *   GET /api/events/:id/statistics
 *
 * Every expected number below is worked out from the fixtures by hand AND
 * compared with counts taken straight from the collections, so the API is
 * checked against the data and not only against itself.
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_dashboard_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const dashboardRoutes = require('../backend/dist/routes/dashboardRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const reportRoutes = require('../backend/dist/routes/reportRoutes').default;
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { Campaign } = require('../backend/dist/models/Campaign');
const { MessageLog } = require('../backend/dist/models/MessageLog');
const { EventMember } = require('../backend/dist/models/EventMember');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { __applyStatusUpdatesForTest } = require('../backend/dist/controllers/webhookController');
const { parseStatusFilter, parseEventIdFilter, activityWindowStart } = require('../backend/dist/services/dashboardStats');

let server: any;
let baseUrl = '';
type Res = { status: number; body: any };

const get = (path: string, token?: string): Promise<Res> =>
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
const fx: any = {};

const mkAdmin = (name: string, role: string) =>
  Admin.create({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`, passwordHash: 'x', role, status: 'Active' });
const mkEvent = (eventName: string, status: string, adminId: any, extra: Record<string, any> = {}) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: at('2030-06-01'), eventTime: at('2030-06-01'), eventVenue: 'Hall', eventStatus: status,
    adminId, createdBy: adminId, ...extra,
  });
const mkCampaign = (event: any) => Campaign.create({ eventId: event._id, messageText: '', status: 'Completed' });

/** Contacts straight into the collection: only their count matters here. */
const mkContacts = async (event: any, count: number) => {
  const now = new Date();
  await Contact.collection.insertMany(Array.from({ length: count }, (_, i) => ({
    fullName: `Guest ${i}`, phoneNumber: `+91${String(9100000000 + i + Math.floor(Math.random() * 1e6) * 1000)}`,
    countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid', createdAt: now, updatedAt: now,
  })));
};

type Spec = Partial<Record<'pending' | 'sent' | 'delivered' | 'failed' | 'failedAfterAccepted', number>>;
/**
 * Message rows, one per recipient, in the shapes the application writes:
 * a campaign message carries campaignId; a template message carries eventId and
 * templateName and has no campaign. Sent and Delivered rows have sentAt; a
 * failure may or may not have been accepted first.
 */
const mkMessages = async (owner: { campaignId?: any; eventId?: any }, spec: Spec, createdAt = new Date()) => {
  const base = () => ({
    ...(owner.campaignId ? { campaignId: owner.campaignId } : { eventId: owner.eventId, templateName: 'event_document' }),
    contactId: new mongoose.Types.ObjectId(), phoneNumber: '+910000000000', createdAt, updatedAt: createdAt,
  });
  const rows: any[] = [];
  for (let i = 0; i < (spec.pending ?? 0); i++) rows.push({ ...base(), status: 'Pending' });
  for (let i = 0; i < (spec.sent ?? 0); i++) rows.push({ ...base(), status: 'Sent', sentAt: createdAt });
  for (let i = 0; i < (spec.delivered ?? 0); i++) rows.push({ ...base(), status: 'Delivered', sentAt: createdAt, deliveredAt: createdAt });
  for (let i = 0; i < (spec.failed ?? 0); i++) rows.push({ ...base(), status: 'Failed', failedAt: createdAt });
  for (let i = 0; i < (spec.failedAfterAccepted ?? 0); i++) rows.push({ ...base(), status: 'Failed', sentAt: createdAt, failedAt: createdAt });
  if (rows.length) await MessageLog.collection.insertMany(rows);
  return rows.length;
};

before(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([Event.init(), Contact.init(), Campaign.init(), MessageLog.init(), EventMember.init()]);

  fx.adminX = await mkAdmin('Admin X', 'Admin');
  fx.adminY = await mkAdmin('Admin Y', 'Admin');
  fx.adminW = await mkAdmin('Admin W', 'Admin');
  fx.adminZ = await mkAdmin('Admin Z', 'Admin');
  fx.adminR = await mkAdmin('Admin R', 'Admin');
  fx.superAdmin = await mkAdmin('Super', 'SuperAdmin');

  // ── Admin X: four events with different statuses, a Sub-Event, and 54 more ──
  fx.E1 = await mkEvent('Upcoming Wedding', 'Upcoming', fx.adminX._id);
  fx.E2 = await mkEvent('Completed Gala', 'Completed', fx.adminX._id);
  fx.E3 = await mkEvent('Big Event', 'Upcoming', fx.adminX._id);
  fx.E4 = await mkEvent('Cancelled Quiet', 'Cancelled', fx.adminX._id);
  fx.S1 = await mkEvent('Sangeet', 'Upcoming', fx.adminX._id, { parentEventId: fx.E1._id });
  for (let i = 0; i < 54; i++) await mkEvent(`Filler ${i}`, 'Upcoming', fx.adminX._id);

  fx.c1 = await mkCampaign(fx.E1);
  fx.c2 = await mkCampaign(fx.E2);
  fx.c3 = await mkCampaign(fx.E3);
  fx.cs1 = await mkCampaign(fx.S1);

  await mkContacts(fx.E1, 3);
  await mkContacts(fx.E2, 2);
  await mkContacts(fx.E3, 120); // more than any page of contacts
  await mkContacts(fx.E4, 1);
  // The Sub-Event's guests are two of E1's own contacts: never counted twice.
  const e1Contacts = await Contact.find({ eventId: fx.E1._id }).select('_id').lean();
  await EventMember.insertMany(e1Contacts.slice(0, 2).map((c: any) => ({ eventId: fx.S1._id, contactId: c._id })));

  fx.counts = {
    c1: await mkMessages({ campaignId: fx.c1._id }, { pending: 2, sent: 3, delivered: 4, failed: 1 }),
    c2: await mkMessages({ campaignId: fx.c2._id }, { sent: 1, delivered: 2, failed: 1, failedAfterAccepted: 1 }),
    t2: await mkMessages({ eventId: fx.E2._id }, { pending: 1, delivered: 1, failed: 1 }),
    // E3: the 38-message event - 20 from the campaign, 18 template sends.
    c3: await mkMessages({ campaignId: fx.c3._id }, { pending: 4, sent: 5, delivered: 8, failed: 3 }),
    t3: await mkMessages({ eventId: fx.E3._id }, { pending: 2, sent: 4, delivered: 10, failed: 2 }),
    cs1: await mkMessages({ campaignId: fx.cs1._id }, { pending: 1, sent: 1, delivered: 3, failed: 1 }),
  };

  // ── Admin Y: another organizer, with campaign and template messages ──
  fx.EY = await mkEvent('Y Event', 'Upcoming', fx.adminY._id);
  fx.cY = await mkCampaign(fx.EY);
  await mkContacts(fx.EY, 5);
  await mkMessages({ campaignId: fx.cY._id }, { delivered: 7 });
  await mkMessages({ eventId: fx.EY._id }, { delivered: 4 });

  // ── Admin W: an event with no campaign and no messages ──
  fx.EW = await mkEvent('W Event', 'Upcoming', fx.adminW._id);
  await mkContacts(fx.EW, 1);

  // ── Admin R: one message per day for eight days, for the chart ──
  fx.ER = await mkEvent('R Event', 'Upcoming', fx.adminR._id);
  fx.cR = await mkCampaign(fx.ER);
  for (let daysAgo = 0; daysAgo < 8; daysAgo++) {
    await mkMessages({ campaignId: fx.cR._id }, { delivered: 1 }, new Date(Date.now() - daysAgo * 86_400_000));
  }

  // A User assigned to the Completed Gala only.
  fx.userE2 = await User.create({ name: 'Gala Helper', email: 'gala@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.E2._id });

  fx.x = tokenFor(fx.adminX, 'Admin');
  fx.y = tokenFor(fx.adminY, 'Admin');
  fx.w = tokenFor(fx.adminW, 'Admin');
  fx.z = tokenFor(fx.adminZ, 'Admin');
  fx.r = tokenFor(fx.adminR, 'Admin');
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.userE2Token = tokenFor(fx.userE2, 'User');
  // A User whose only event has no campaign, while other events have template messages without one.
  fx.userE4 = await User.create({ name: 'Quiet Helper', email: 'quiet@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.E4._id });
  fx.userE4Token = tokenFor(fx.userE4, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/reports', reportRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

const stats = async (query = '', token = fx.x) => {
  const res = await get(`/api/dashboard/stats${query}`, token);
  assert.equal(res.status, 200, `${query}: ${JSON.stringify(res.body)}`);
  return res.body;
};
const card = (s: any) => [s.totalEvents, s.totalContacts, s.totalCampaigns, s.messagesSent, s.messagesDelivered, s.messagesFailed, s.messagesPending];
// [events, contacts, campaigns, sent, delivered, failed, pending]

/** The same numbers worked out from the collections, by a different route than the API takes. */
const directCounts = async (eventIds: any[]) => {
  const campaigns = await Campaign.collection.find({ eventId: { $in: eventIds } }).toArray();
  const rows = await MessageLog.collection.find({
    $or: [{ campaignId: { $in: campaigns.map((c: any) => c._id) } }, { eventId: { $in: eventIds }, templateName: { $type: 'string' } }],
  }).toArray();
  const events = await Event.collection.find({ _id: { $in: eventIds } }).toArray();
  const contacts = await Contact.collection.countDocuments({ eventId: { $in: eventIds } });
  const n = (f: (r: any) => boolean) => rows.filter(f).length;
  return [
    events.filter((e: any) => !e.parentEventId).length, contacts, campaigns.length,
    n((r) => r.status === 'Sent' || r.status === 'Delivered' || r.sentAt instanceof Date),
    n((r) => r.status === 'Delivered'), n((r) => r.status === 'Failed'), n((r) => r.status === 'Pending'),
  ];
};
const idsOf = async (adminId: any) => (await Event.collection.find({ adminId }).project({ _id: 1 }).toArray()).map((e: any) => e._id);

describe('Event Status = All', () => {
  test('includes every event the user may see, whatever its status, across all their events and messages', async () => {
    const s = await stats();
    // 58 main events (4 + 54), 126 contacts (3 + 2 + 120 + 1), 4 campaigns, and across E1+E2+E3+S1:
    // sent 43, delivered 28, failed 10, pending 10.
    assert.deepEqual(card(s), [58, 126, 4, 43, 28, 10, 10]);
  });

  test('matches counts taken straight from the collections', async () => {
    assert.deepEqual(card(await stats()), await directCounts(await idsOf(fx.adminX._id)));
  });

  test('"All", "all", an empty value and a missing value are the same request', async () => {
    const all = card(await stats());
    for (const q of ['?status=All', '?status=all', '?status=', '?status=ALL', '?eventId=&status=All', '?eventId=All']) {
      assert.deepEqual(card(await stats(q)), all, q);
    }
  });

  test('is not limited to the first page of events, contacts or messages', async () => {
    const s = await stats();
    assert.equal(s.totalEvents, 58, 'all 58 events, not one page of them');
    assert.equal(s.totalContacts, 126, '126 contacts, not a page of 100 or fewer');
  });

  test('a Super Admin sees every organizer; each Admin sees only their own', async () => {
    const [x, y] = [await stats('', fx.x), await stats('', fx.y)];
    const sup = await stats('', fx.super);
    assert.deepEqual(card(y), [1, 5, 1, 11, 11, 0, 0], "Y: one event, 5 contacts, its campaign's 7 and its template 4 delivered messages");
    assert.equal(sup.totalEvents, x.totalEvents + y.totalEvents + 1 + 1, 'X + Y + W + R (Z has no events)');
    assert.equal(sup.messagesDelivered, x.messagesDelivered + y.messagesDelivered + 8, "plus Admin R's eight delivered messages");
  });
});

describe('a single status', () => {
  test('Upcoming includes only Upcoming events (and the Sub-Event, which is Upcoming)', async () => {
    // 56 main events (E1, E3, 54 fillers); E1+E3 contacts; campaigns C1, C3, CS1;
    // messages of E1 + E3 + S1: sent 7+27+4, delivered 4+18+3, failed 1+5+1, pending 2+6+1.
    assert.deepEqual(card(await stats('?status=Upcoming')), [56, 123, 3, 38, 25, 7, 9]);
  });

  test('Completed includes only the Completed event, with its campaign and its template messages', async () => {
    assert.deepEqual(card(await stats('?status=Completed')), [1, 2, 1, 5, 3, 3, 1]);
  });

  test('Cancelled with no campaign and no messages is all zeros for messages', async () => {
    assert.deepEqual(card(await stats('?status=Cancelled')), [1, 1, 0, 0, 0, 0, 0]);
  });

  test('the statuses together account for everything under All', async () => {
    const parts = await Promise.all(['Upcoming', 'Completed', 'Cancelled'].map((s) => stats(`?status=${s}`)));
    const all = await stats();
    for (const key of ['totalEvents', 'totalContacts', 'totalCampaigns', 'messagesSent', 'messagesDelivered', 'messagesFailed', 'messagesPending']) {
      assert.equal(parts.reduce((sum, p) => sum + p[key], 0), all[key], key);
    }
  });

  test('the status is matched whatever its case, and an unknown status is refused rather than matching nothing', async () => {
    assert.deepEqual(card(await stats('?status=upcoming')), card(await stats('?status=Upcoming')));
    const bad = await get('/api/dashboard/stats?status=Bogus', fx.x);
    assert.equal(bad.status, 400);
    assert.equal((await get('/api/dashboard/stats?status=Upcoming&status=Completed', fx.x)).status, 400, 'a repeated parameter is not a status');
  });

  test('matches counts taken straight from the collections', async () => {
    const upcoming = await Event.collection.find({ adminId: fx.adminX._id, eventStatus: 'Upcoming' }).project({ _id: 1 }).toArray();
    assert.deepEqual(card(await stats('?status=Upcoming')), await directCounts(upcoming.map((e: any) => e._id)));
  });
});

describe('a single event', () => {
  test('shows that event only; the 38-message event contributes exactly its 38 rows', async () => {
    const s = await stats(`?eventId=${fx.E3._id}`);
    assert.deepEqual(card(s), [1, 120, 1, 27, 18, 5, 6]);
    assert.equal(fx.counts.c3 + fx.counts.t3, 38);
    assert.deepEqual(card(s), await directCounts([fx.E3._id]));
  });

  test('another event is unaffected by it', async () => {
    assert.deepEqual(card(await stats(`?eventId=${fx.E1._id}`)), [1, 3, 1, 7, 4, 1, 2]);
    assert.deepEqual(card(await stats(`?eventId=${fx.E2._id}`)), [1, 2, 1, 5, 3, 3, 1]);
  });

  test('an event with no campaign shows zero messages - not other events\' template messages', async () => {
    assert.deepEqual(card(await stats(`?eventId=${fx.EW._id}`, fx.w)), [1, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual(card(await stats(`?eventId=${fx.E4._id}`)), [1, 1, 0, 0, 0, 0, 0]);
  });

  test("a Sub-Event shows its own members and messages, and is not added on top of its Main Event under All", async () => {
    assert.deepEqual(card(await stats(`?eventId=${fx.S1._id}`)), [1, 2, 1, 4, 3, 1, 1]);
    assert.equal((await stats()).totalContacts, 126, "the Sub-Event's two guests are E1's own contacts, counted once");
  });

  test('the event id may be given as a string in any form the page sends it', async () => {
    const a = await stats(`?eventId=${fx.E3._id}`);
    const b = await stats(`?eventId=${String(fx.E3._id).toUpperCase()}`);
    assert.deepEqual(card(a), card(b));
  });

  test('a malformed event id is refused, and an unknown one is not found in the user\'s scope', async () => {
    assert.equal((await get('/api/dashboard/stats?eventId=not-an-id', fx.x)).status, 400);
    assert.equal((await get(`/api/dashboard/stats?eventId=${new mongoose.Types.ObjectId()}`, fx.x)).status, 403);
  });
});

describe('operator-shaped filters', () => {
  // Express's default query parser turns `eventId[$ne]=x` into an object. If that reached a query it
  // would be applied as an operator, so it must be refused outright - for every role, on both endpoints.
  const shapes = (id: string) => [
    `eventId[$ne]=${id}`, 'eventId[$gt]=', `eventId[$in][]=${id}`, 'eventId[$regex]=.*', 'eventId[$exists]=true',
    'status[$ne]=Upcoming', 'status[$regex]=.*', 'status[$in][]=Upcoming',
    `eventId=${id}&eventId=${id}`, `eventId[]=${id}`,
  ];

  test('an operator-shaped eventId or status is a 400 on the cards and the chart, for an Admin and a Super Admin', async () => {
    for (const token of [fx.x, fx.super]) {
      for (const query of shapes(String(fx.E1._id))) {
        for (const path of ['/api/dashboard/stats', '/api/dashboard/activity']) {
          const res = await get(`${path}?${query}`, token);
          assert.equal(res.status, 400, `${path}?${query}`);
          assert.ok(res.body.error, `${path}?${query} explains the refusal`);
        }
      }
    }
  });

  test('the refusal is not an unfiltered answer: nothing is returned that an operator could have selected', async () => {
    const res = await get(`/api/dashboard/stats?eventId[$ne]=${fx.E1._id}`, fx.x);
    assert.equal(res.status, 400);
    assert.equal(res.body.totalEvents, undefined);
    assert.equal(res.body.messagesSent, undefined);
  });

  test('a plain, well-formed filter in the same request shape still works', async () => {
    assert.deepEqual(card(await stats(`?eventId=${fx.E1._id}`)), [1, 3, 1, 7, 4, 1, 2]);
    assert.deepEqual(card(await stats('?status=Completed')), [1, 2, 1, 5, 3, 3, 1]);
  });
});

describe('Event Name and Event Status together', () => {
  test('both must match: the event\'s own status decides', async () => {
    assert.deepEqual(card(await stats(`?eventId=${fx.E1._id}&status=Upcoming`)), [1, 3, 1, 7, 4, 1, 2]);
    assert.deepEqual(card(await stats(`?eventId=${fx.E1._id}&status=Completed`)), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(card(await stats(`?eventId=${fx.E2._id}&status=Completed`)), [1, 2, 1, 5, 3, 3, 1]);
    assert.deepEqual(card(await stats(`?eventId=${fx.E2._id}&status=All`)), [1, 2, 1, 5, 3, 3, 1]);
  });
});

describe('the message numbers', () => {
  test('Sent includes Delivered: a fully delivered event does not read "Sent 0"', async () => {
    const e = await Event.create({ organizerName: 'O', organizerMobile: BigInt('9112472833'), eventName: 'All Delivered', eventType: 'Wedding', eventDate: at('2030-06-01'), eventTime: at('2030-06-01'), eventVenue: 'H', eventStatus: 'Upcoming', adminId: fx.adminZ._id, createdBy: fx.adminZ._id });
    const c = await mkCampaign(e);
    await mkMessages({ campaignId: c._id }, { delivered: 38 });
    const s = await stats(`?eventId=${e._id}`, fx.z);
    assert.equal(s.messagesSent, 38);
    assert.equal(s.messagesDelivered, 38);
    assert.equal(s.messagesFailed + s.messagesPending, 0);
    await MessageLog.collection.deleteMany({ campaignId: c._id });
    await Campaign.deleteOne({ _id: c._id });
    await Event.deleteOne({ _id: e._id });
  });

  test('Delivered, Failed and Pending equal the rows in those states; Sent counts accepted messages, so the four are not a partition', async () => {
    const s = await stats(`?eventId=${fx.E2._id}`);
    // 8 rows: campaign Sent 1, Delivered 2, Failed 2 (one accepted first); template Pending 1, Delivered 1, Failed 1.
    assert.deepEqual([s.messagesSent, s.messagesDelivered, s.messagesFailed, s.messagesPending], [5, 3, 3, 1]);
    assert.notEqual(s.messagesDelivered + s.messagesFailed + s.messagesPending, s.messagesSent);
  });

  test('a message that failed after WhatsApp accepted it counts as both sent and failed; one rejected outright counts only as failed', async () => {
    const s = await stats(`?eventId=${fx.E2._id}`);
    // Sent: 1 Sent + 2 Delivered (campaign) + 1 failed-after-accepted + 1 Delivered (template) = 5, not the 2 plain failures.
    assert.equal(s.messagesSent, 5);
    assert.equal(s.messagesFailed, 3);
  });

  test('template messages (no campaign) are counted for their event, and only for it', async () => {
    const e3 = await stats(`?eventId=${fx.E3._id}`);
    assert.equal(e3.messagesDelivered, 18, '8 campaign + 10 template');
    const nobody = await stats('', fx.z);
    assert.deepEqual(card(nobody), [0, 0, 0, 0, 0, 0, 0], "an Admin with no events sees none of the others' messages");
  });

  test("another organizer's messages are never included, including template messages with no campaign", async () => {
    for (const s of [await stats(), await stats('?status=Upcoming'), await stats(`?eventId=${fx.E1._id}`)]) {
      assert.ok(s.messagesDelivered <= 28, 'X never reaches Y\'s eleven delivered messages');
    }
    const w = await stats('', fx.w);
    assert.deepEqual(card(w), [1, 1, 0, 0, 0, 0, 0], "W has no campaign: the old `campaignId: null` fallback read everyone's template messages here");
  });

  // Rows are stored with ObjectId ids (the models cast to it, and migrateDbHardening.ts reports any
  // non-ObjectId campaignId or eventId as a defect to repair), so rows with string-typed ids are not
  // supported data and are not tested for. What is tested: the request carries the id as a string.
  test("a request's string event id finds the event's template rows, which are stored under an ObjectId eventId", async () => {
    assert.equal(await MessageLog.collection.countDocuments({ eventId: fx.E3._id }), 18, 'the rows are stored under the ObjectId');
    assert.equal(await MessageLog.collection.countDocuments({ eventId: String(fx.E3._id) }), 0, 'and not under its string form');
    assert.equal((await stats(`?eventId=${String(fx.E3._id)}`)).messagesDelivered, 18);
  });
});

describe('repeated webhook callbacks do not inflate anything', () => {
  const payload = (wamid: string, status: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });

  test('the same status delivered three times, then replayed out of order, changes the totals once', async () => {
    const before = await stats(`?eventId=${fx.E1._id}`);
    const wamid = `wamid.TEST${Date.now()}`;
    const now = new Date();
    await MessageLog.collection.insertOne({ campaignId: fx.c1._id, contactId: new mongoose.Types.ObjectId(), phoneNumber: '+910000000000', status: 'Sent', sentAt: now, wamid, createdAt: now, updatedAt: now });

    const withRow = await stats(`?eventId=${fx.E1._id}`);
    assert.equal(withRow.messagesSent, before.messagesSent + 1);

    for (let i = 0; i < 3; i++) await __applyStatusUpdatesForTest(payload(wamid, 'delivered'));
    await __applyStatusUpdatesForTest(payload(wamid, 'sent'));      // late, out of order
    await __applyStatusUpdatesForTest(payload(wamid, 'failed'));    // spurious once delivered
    await __applyStatusUpdatesForTest(payload(wamid, 'read'));
    await __applyStatusUpdatesForTest(payload(wamid, 'read'));

    const after = await stats(`?eventId=${fx.E1._id}`);
    assert.equal(after.messagesSent, withRow.messagesSent, 'still one accepted message');
    assert.equal(after.messagesDelivered, before.messagesDelivered + 1, 'delivered once');
    assert.equal(after.messagesFailed, before.messagesFailed, 'the late failure did not count');
    assert.equal(after.messagesPending, before.messagesPending);
    assert.equal(await MessageLog.collection.countDocuments({ wamid }), 1, 'one row, however many callbacks');

    await MessageLog.collection.deleteOne({ wamid });
    assert.deepEqual(card(await stats(`?eventId=${fx.E1._id}`)), card(before));
  });
});

describe('who may see what', () => {
  test('a User sees only their assigned event', async () => {
    assert.deepEqual(card(await stats('', fx.userE2Token)), [1, 2, 1, 5, 3, 3, 1]);
  });

  test("an event of another organizer is refused, for the cards, the chart and the event's statistics", async () => {
    assert.equal((await get(`/api/dashboard/stats?eventId=${fx.EY._id}`, fx.x)).status, 403);
    assert.equal((await get(`/api/dashboard/activity?eventId=${fx.EY._id}`, fx.x)).status, 403);
    assert.equal((await get(`/api/events/${fx.EY._id}/statistics`, fx.x)).status, 403);
    assert.equal((await get(`/api/dashboard/stats?eventId=${fx.E1._id}`, fx.userE2Token)).status, 403);
  });

  test('no token is refused', async () => {
    assert.equal((await get('/api/dashboard/stats')).status, 401);
  });

  test("a User whose event has no campaign sees zero messages, not other events' campaign-less template messages", async () => {
    // Template messages with no campaign exist for E2, E3 and Y's event; none belong to this User's event.
    assert.ok((await MessageLog.collection.countDocuments({ campaignId: { $exists: false }, templateName: { $type: 'string' } })) > 0);
    assert.deepEqual(card(await stats('', fx.userE4Token)), [1, 1, 0, 0, 0, 0, 0]);
    assert.equal((await get('/api/dashboard/activity', fx.userE4Token)).body.chartData.length, 0);
  });
});

describe('empty data', () => {
  test('a user with no events gets zeros, and a status with no events gets zeros', async () => {
    assert.deepEqual(card(await stats('', fx.z)), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(card(await stats('?status=Completed', fx.w)), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(card(await stats('?status=Cancelled', fx.y)), [0, 0, 0, 0, 0, 0, 0]);
  });

  test('every field is present and a number, even when empty', async () => {
    const s = await stats('', fx.z);
    for (const key of ['totalEvents', 'totalContacts', 'totalCampaigns', 'messagesSent', 'messagesDelivered', 'messagesFailed', 'messagesPending']) {
      assert.equal(typeof s[key], 'number', key);
    }
  });
});

describe("an event's own statistics agree with the Dashboard", () => {
  test('GET /events/:id/statistics gives the single-event cards, and no longer reads other events\' messages', async () => {
    const res = await get(`/api/events/${fx.E3._id}/statistics`, fx.x);
    assert.equal(res.status, 200);
    assert.deepEqual(
      [res.body.totalContacts, res.body.totalCampaigns, res.body.messagesSent, res.body.messagesDelivered, res.body.messagesFailed, res.body.messagesPending],
      [120, 1, 27, 18, 5, 6]
    );
    const noCampaign = await get(`/api/events/${fx.EW._id}/statistics`, fx.w);
    assert.deepEqual([noCampaign.body.messagesSent, noCampaign.body.messagesDelivered], [0, 0]);
  });
});

describe('the activity chart', () => {
  const sum = (rows: any[], key: string) => rows.reduce((n, r) => n + r[key], 0);

  test('uses the same scope and definitions as the cards: its totals equal them', async () => {
    const res = await get('/api/dashboard/activity', fx.x);
    assert.equal(res.status, 200);
    // All of X's messages were written today, so the seven days add up to the cards.
    assert.equal(sum(res.body.chartData, 'sent'), 43);
    assert.equal(sum(res.body.chartData, 'delivered'), 28);
  });

  test('delivered counts delivered messages, not every accepted one', async () => {
    const res = await get(`/api/dashboard/activity?eventId=${fx.E3._id}`, fx.x);
    assert.equal(sum(res.body.chartData, 'sent'), 27);
    assert.equal(sum(res.body.chartData, 'delivered'), 18);
  });

  test("covers exactly seven days, newest included, and the eighth-oldest day is left out", async () => {
    const res = await get('/api/dashboard/activity', fx.r);
    assert.equal(res.body.chartData.length, 7);
    assert.equal(sum(res.body.chartData, 'delivered'), 7, 'eight days of data, seven shown');
    const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getUTCDay()];
    assert.equal(res.body.chartData[res.body.chartData.length - 1].name, today, 'today is the last day');
    assert.equal(activityWindowStart(new Date('2030-06-10T15:00:00Z')).toISOString(), '2030-06-04T00:00:00.000Z');
  });

  test("is scoped by status and never includes another organizer's messages", async () => {
    assert.equal(sum((await get('/api/dashboard/activity?status=Completed', fx.x)).body.chartData, 'delivered'), 3);
    assert.deepEqual((await get('/api/dashboard/activity', fx.z)).body, { chartData: [], recentCampaigns: [] });
    assert.deepEqual((await get('/api/dashboard/activity', fx.w)).body.chartData, [], "W has no campaign: no one else's template messages");
  });

  test('recent campaigns are only the ones in scope', async () => {
    const res = await get('/api/dashboard/activity?status=Completed', fx.x);
    assert.equal(res.body.recentCampaigns.length, 1);
    assert.equal(String(res.body.recentCampaigns[0].eventId._id), String(fx.E2._id));
  });

  test('a bad filter is refused', async () => {
    assert.equal((await get('/api/dashboard/activity?status=Bogus', fx.x)).status, 400);
  });
});

describe("the application's own campaign report says the same", () => {
  const report = async (campaign: any) => {
    const res = await get(`/api/reports/campaign/${campaign._id}/stats`, fx.x);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.summary;
  };

  test('for a campaign-only event, the dashboard and the report agree: accepted, delivered, failed, pending', async () => {
    const r = await report(fx.c1);
    const d = await stats(`?eventId=${fx.E1._id}`);
    assert.deepEqual([d.messagesSent, d.messagesDelivered, d.messagesFailed, d.messagesPending], [r.accepted, r.delivered, r.failed, r.pending]);
  });

  test("with template messages added, the dashboard is the report's campaign messages plus the event's template messages", async () => {
    const r = await report(fx.c3);
    assert.deepEqual([r.accepted, r.delivered, r.failed, r.pending], [13, 8, 3, 4], "the campaign's 20 messages");
    const d = await stats(`?eventId=${fx.E3._id}`);
    // The 18 template messages: accepted 14, delivered 10, failed 2, pending 2.
    assert.deepEqual([d.messagesSent - r.accepted, d.messagesDelivered - r.delivered, d.messagesFailed - r.failed, d.messagesPending - r.pending], [14, 10, 2, 2]);
  });
});

describe('the chart window, to the instant', () => {
  test('includes its first instant and the whole of today, and excludes the instant before', async () => {
    const admin = await mkAdmin('Admin B', 'Admin');
    const event = await mkEvent('B Event', 'Upcoming', admin._id);
    const campaign = await mkCampaign(event);
    const now = new Date();
    const start = activityWindowStart(now);
    const endOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    await mkMessages({ campaignId: campaign._id }, { delivered: 1 }, new Date(start.getTime() - 1)); // just before: out
    await mkMessages({ campaignId: campaign._id }, { delivered: 1 }, start);                         // first instant: in
    await mkMessages({ campaignId: campaign._id }, { delivered: 1 }, now);                           // now: in
    await mkMessages({ campaignId: campaign._id }, { delivered: 1 }, endOfToday);                    // the last instant of the final day: in

    const res = await get('/api/dashboard/activity', tokenFor(admin, 'Admin'));
    const total = res.body.chartData.reduce((n: number, r: any) => n + r.delivered, 0);
    assert.equal(total, 3, 'three of the four: the one a millisecond before the window is left out');
    assert.equal(res.body.chartData.length, 2, 'two calendar days have data: the first day of the window and today');
    const dayName = (d: Date) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    assert.equal(res.body.chartData[0].name, dayName(start));
    assert.equal(res.body.chartData[1].name, dayName(now), 'the final day is present, with both of its messages');
    assert.equal(res.body.chartData[1].delivered, 2);
  });
});

describe('filter parsing', () => {
  test('every spelling of "no filter" reads as none', () => {
    for (const raw of [undefined, null, '', ' ', 'All', 'all', 'ALL', 'null', 'undefined']) {
      assert.deepEqual(parseStatusFilter(raw), { ok: true, value: null }, String(raw));
      assert.deepEqual(parseEventIdFilter(raw), { ok: true, value: null }, String(raw));
    }
  });

  test('statuses are matched without regard to case; anything else is refused', () => {
    assert.deepEqual(parseStatusFilter('upcoming'), { ok: true, value: 'Upcoming' });
    assert.deepEqual(parseStatusFilter(' Completed '), { ok: true, value: 'Completed' });
    for (const raw of ['Bogus', 'Active', ['Upcoming'], 5, {}]) assert.equal((parseStatusFilter(raw) as any).ok, false, JSON.stringify(raw));
    for (const raw of ['x', '123', 'abcdefghijkl', ['a'], {}]) assert.equal((parseEventIdFilter(raw) as any).ok, false, JSON.stringify(raw));
    assert.deepEqual(parseEventIdFilter('ABCDEFABCDEFABCDEFABCDEF'), { ok: true, value: 'abcdefabcdefabcdefabcdef' });
  });
});

describe('before and after', () => {
  /** The previous logic, as it was: campaigns only, Sent-only, and a `campaignId: null` fallback. */
  const legacy = async (adminId: any) => {
    const events = await Event.collection.find({ adminId }).toArray();
    const campaigns = await Campaign.collection.find({ eventId: { $in: events.map((e: any) => e._id) } }).toArray();
    const ids = campaigns.map((c: any) => c._id);
    const match: any = ids.length ? { campaignId: { $in: ids } } : { campaignId: null };
    const rows = await MessageLog.collection.find(match).toArray();
    const n = (status: string) => rows.filter((r: any) => r.status === status).length;
    return { sent: n('Sent'), delivered: n('Delivered'), failed: n('Failed'), pending: n('Pending') };
  };

  test('Admin X: the old numbers missed the template messages and the delivered messages under "Sent"', async () => {
    const before = await legacy(fx.adminX._id);
    assert.deepEqual(before, { sent: 10, delivered: 17, failed: 7, pending: 7 });
    const after = await stats();
    assert.deepEqual([after.messagesSent, after.messagesDelivered, after.messagesFailed, after.messagesPending], [43, 28, 10, 10]);
  });

  test("Admin W (no campaign): the old numbers were every organizer's template messages", async () => {
    const before = await legacy(fx.adminW._id);
    assert.equal(before.delivered + before.failed + before.sent + before.pending, 3 + 18 + 4, "X's 21 and Y's 4 template messages, none of them W's");
    assert.deepEqual(card(await stats('', fx.w)).slice(3), [0, 0, 0, 0]);
  });
});
