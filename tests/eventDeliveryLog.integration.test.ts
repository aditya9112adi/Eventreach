import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * The Event Report's Delivery Log, over real HTTP against the REAL compiled
 * backend (routes, controllers, models from backend/dist) on a throwaway
 * database.
 *
 * GET /api/reports/event/:eventId/delivery-log returns one event's WhatsApp
 * recipients - the campaign's and the proactive template sends - from the
 * existing MessageLog collection. Nothing is copied or counted elsewhere, so
 * the webhook tests below show a status change arriving in the log by the same
 * path production uses.
 *
 * Meta is never contacted: rows are written directly, and the webhook is fed
 * callbacks the way Meta would deliver them.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_evtlog_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
delete process.env.WHATSAPP_APP_SECRET; // signature checking is covered elsewhere
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_ID;

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const reportRoutes = require('../backend/dist/routes/reportRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const webhookRoutes = require('../backend/dist/routes/webhookRoutes').default;
const { MessageLog } = require('../backend/dist/models/MessageLog');
const { Campaign } = require('../backend/dist/models/Campaign');
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { Admin } = require('../backend/dist/models/Admin');

let server: any;
let baseUrl = '';
let superToken = '';
let superId: any;

const call = (
  method: string,
  path: string,
  opts: { body?: any; token?: string } = {}
): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const headers: Record<string, string> = {};
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
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const makeEvent = (eventName: string, extra: Record<string, any> = {}) =>
  Event.create({
    organizerName: 'Organiser',
    organizerMobile: BigInt('9112472833'),
    eventName,
    eventType: 'Party',
    eventDate: new Date('2026-12-01T00:00:00.000Z'),
    eventTime: new Date('2026-12-01T18:30:00+05:30'),
    eventVenue: 'Hall',
    eventStatus: 'Upcoming',
    ...extra,
  });

let phoneSeq = 0;
const makeContact = (event: any, fullName: string) =>
  Contact.create({
    fullName,
    phoneNumber: `+9190000${String(100000 + phoneSeq++)}`,
    countryCode: 'IN',
    eventId: event._id,
    source: 'Manual',
    status: 'Valid',
  });

/** A campaign message: reaches its event through the campaign, not an eventId. */
const campaignRow = async (campaign: any, event: any, name: string, over: Record<string, any> = {}) => {
  const contact = await makeContact(event, name);
  return MessageLog.create({
    campaignId: campaign._id,
    contactId: contact._id,
    contactName: name,
    phoneNumber: contact.phoneNumber,
    ...over,
  });
};

/** A proactive template send: carries eventId and a template name, no campaign. */
const templateRow = async (event: any, name: string, over: Record<string, any> = {}) => {
  const contact = await makeContact(event, name);
  return MessageLog.create({
    eventId: event._id,
    templateName: 'event_document',
    contactId: contact._id,
    contactName: name,
    phoneNumber: contact.phoneNumber,
    ...over,
  });
};

const webhookStatus = (wamid: string, status: string, extra: Record<string, any> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA_ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }],
      },
    }],
  }],
});

const log = (eventId: any, query = '') =>
  call('GET', `/api/reports/event/${eventId}/delivery-log${query}`, { token: superToken });

const names = (res: { body: any }) => res.body.logs.map((l: any) => l.contactName).sort();

/**
 * The webhook acknowledges Meta BEFORE it applies the update - a fast 200 is
 * what stops Meta retrying - so the change lands a moment after the response.
 * Reading the log straight after the POST races it. This polls the Delivery
 * Log itself until the row looks the way the callback should have left it,
 * which also shows the change arriving through the very endpoint the report
 * reads.
 */
const untilLog = async (eventId: any, ready: (row: any) => boolean, query = '') => {
  let last: any;
  for (let i = 0; i < 60; i++) {
    last = (await log(eventId, query)).body.logs[0];
    if (last && ready(last)) return last;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail('the log never reached the expected state; last row: ' + JSON.stringify(last));
};

before(async () => {
  await mongoose.connect(TEST_DB);

  const superAdmin = await Admin.create({
    name: 'Super', email: 'super-evtlog@example.com',
    passwordHash: await bcrypt.hash('TestPass123', 10),
    role: 'SuperAdmin', status: 'Active', accessGrantedOn: new Date(),
  });
  superId = superAdmin._id;
  superToken = tokenFor(superAdmin, 'SuperAdmin');

  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
  app.use(express.json());
  app.use('/api/reports', reportRoutes);
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
  await Promise.all([
    MessageLog.deleteMany({}), Campaign.deleteMany({}), Contact.deleteMany({}), Event.deleteMany({}),
  ]);
  await Admin.deleteMany({ role: 'Admin' });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('what the Delivery Log holds for an event', () => {
  test('an event with no WhatsApp messages has an empty log, not an error', async () => {
    const event = await makeEvent('Quiet Evening');

    const res = await log(event._id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.logs, []);
    assert.equal(res.body.pagination.total, 0);
    assert.equal(res.body.campaignId, null, 'no campaign has been created for it');
  });

  test('an event with a campaign but nothing sent yet is empty too', async () => {
    const event = await makeEvent('Drafted Only');
    await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Draft' });

    const res = await log(event._id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.logs, []);
    assert.ok(res.body.campaignId, 'the campaign is known even though it has no messages');
  });

  test('an event with one recipient returns that recipient with name, phone and milestones', async () => {
    const event = await makeEvent('Gala');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    const sent = new Date('2026-10-01T10:00:00.000Z');
    await campaignRow(campaign, event, 'Akshat Singh', { status: 'Sent', wamid: 'wamid.A', sentAt: sent });

    const res = await log(event._id);
    assert.equal(res.body.logs.length, 1);
    const row = res.body.logs[0];
    assert.equal(row.contactName, 'Akshat Singh');
    assert.equal(row.contactId.fullName, 'Akshat Singh', 'the contact is populated for the table');
    assert.ok(row.contactId.phoneNumber.startsWith('+91'));
    assert.equal(new Date(row.sentAt).toISOString(), sent.toISOString());
    assert.equal(row.deliveredAt, undefined, 'a milestone that has not happened is absent, not invented');
    assert.equal(row.readAt, undefined);
    assert.equal(row.failedAt, undefined);
  });

  test('several recipients all appear, newest first', async () => {
    const event = await makeEvent('Gala');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    for (const [i, name] of ['First', 'Second', 'Third', 'Fourth'].entries()) {
      await campaignRow(campaign, event, name, {
        status: 'Sent',
        createdAt: new Date(Date.UTC(2026, 9, 1, 10, i)),
      });
    }

    const res = await log(event._id);
    assert.deepEqual(res.body.logs.map((l: any) => l.contactName), ['Fourth', 'Third', 'Second', 'First']);
    assert.equal(res.body.pagination.total, 4);
  });

  test('campaign recipients and template sends for the event come back together', async () => {
    const event = await makeEvent('Gala');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(campaign, event, 'Via Campaign', { status: 'Sent' });
    await templateRow(event, 'Via Template', { status: 'Delivered', deliveredAt: new Date() });

    const res = await log(event._id);
    assert.deepEqual(names(res), ['Via Campaign', 'Via Template']);
    assert.equal(
      res.body.logs.find((l: any) => l.contactName === 'Via Template').templateName,
      'event_document',
      'the template is identified, as the existing table already does'
    );
  });

  test('a template send for an event with no campaign is still shown', async () => {
    // The campaign-only Delivery Log could not reach these at all.
    const event = await makeEvent('Template Only');
    await templateRow(event, 'Template Guest', { status: 'Sent', sentAt: new Date() });

    const res = await log(event._id);
    assert.deepEqual(names(res), ['Template Guest']);
    assert.equal(res.body.campaignId, null);
  });
});

describe('statuses and the filter', () => {
  /**
   * One row of every kind the webhook can leave behind. Read is stored as
   * Delivered plus readAt, so it is two rows that are Delivered and one of
   * them is also Read.
   */
  const seedMixed = async () => {
    const event = await makeEvent('Mixed');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(campaign, event, 'Pending One', { status: 'Pending' });
    await campaignRow(campaign, event, 'Accepted One', { status: 'Sent', sentAt: new Date() });
    await campaignRow(campaign, event, 'Delivered One', {
      status: 'Delivered', sentAt: new Date(), deliveredAt: new Date(),
    });
    await campaignRow(campaign, event, 'Read One', {
      status: 'Delivered', sentAt: new Date(), deliveredAt: new Date(), readAt: new Date(),
    });
    await campaignRow(campaign, event, 'Failed One', {
      status: 'Failed', errorCode: 131047, errorReason: 'Re-engagement message', failedAt: new Date(),
    });
    return event;
  };

  test('mixed statuses each keep their own fields', async () => {
    const event = await seedMixed();
    const res = await log(event._id);
    const row = (n: string) => res.body.logs.find((l: any) => l.contactName === n);

    assert.equal(row('Pending One').status, 'Pending');
    assert.equal(row('Accepted One').status, 'Sent');
    assert.equal(row('Delivered One').status, 'Delivered');
    assert.ok(row('Read One').readAt);
    assert.equal(row('Failed One').errorCode, 131047);
    assert.equal(row('Failed One').errorReason, 'Re-engagement message');
  });

  test('All returns every row', async () => {
    const event = await seedMixed();
    assert.equal((await log(event._id, '?status=All')).body.logs.length, 5);
    assert.equal((await log(event._id)).body.logs.length, 5, 'no filter is the same as All');
  });

  test('Pending returns only queued rows', async () => {
    const event = await seedMixed();
    assert.deepEqual(names(await log(event._id, '?status=Pending')), ['Pending One']);
  });

  test('Sent (accepted by WhatsApp) returns only rows still at that stage', async () => {
    const event = await seedMixed();
    assert.deepEqual(names(await log(event._id, '?status=Sent')), ['Accepted One']);
  });

  test('Delivered returns every delivered row, the read one included', async () => {
    // A read message is a delivered message; this is the rule the existing
    // campaign Delivery Log already applies.
    const event = await seedMixed();
    assert.deepEqual(names(await log(event._id, '?status=Delivered')), ['Delivered One', 'Read One']);
  });

  test('Read returns only rows the recipient opened, by timestamp', async () => {
    const event = await seedMixed();
    assert.deepEqual(names(await log(event._id, '?status=Read')), ['Read One']);
  });

  test('Failed returns only failures', async () => {
    const event = await seedMixed();
    assert.deepEqual(names(await log(event._id, '?status=Failed')), ['Failed One']);
  });

  test('the filter applies to template sends as well as campaign rows', async () => {
    const event = await makeEvent('Both');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(campaign, event, 'Campaign Read', { status: 'Delivered', readAt: new Date() });
    await templateRow(event, 'Template Read', { status: 'Delivered', readAt: new Date() });
    await templateRow(event, 'Template Pending', { status: 'Pending' });

    assert.deepEqual(names(await log(event._id, '?status=Read')), ['Campaign Read', 'Template Read']);
    assert.deepEqual(names(await log(event._id, '?status=Pending')), ['Template Pending']);
  });

  test('the total reflects the filter, so the table can say how many it left out', async () => {
    const event = await seedMixed();
    const res = await log(event._id, '?status=Failed');
    assert.equal(res.body.pagination.total, 1);
  });
});

describe('the log belongs to its event', () => {
  test('only the requested event\'s recipients are returned', async () => {
    const mine = await makeEvent('Valentines');
    const theirs = await makeEvent('Other Party');
    const myCampaign = await Campaign.create({ eventId: mine._id, messageText: 'Hi', status: 'Completed' });
    const theirCampaign = await Campaign.create({ eventId: theirs._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(myCampaign, mine, 'Mine Campaign', { status: 'Sent' });
    await campaignRow(theirCampaign, theirs, 'Theirs Campaign', { status: 'Sent' });
    await templateRow(mine, 'Mine Template');
    await templateRow(theirs, 'Theirs Template');

    const res = await log(mine._id);
    assert.deepEqual(names(res), ['Mine Campaign', 'Mine Template']);
    assert.equal(
      res.body.logs.some((l: any) => /Theirs/.test(l.contactName)),
      false,
      'nothing from the other event, by either route'
    );
  });

  test('two events never mix their recipients, in either direction', async () => {
    const a = await makeEvent('Event A');
    const b = await makeEvent('Event B');
    const campaignA = await Campaign.create({ eventId: a._id, messageText: 'Hi', status: 'Completed' });
    const campaignB = await Campaign.create({ eventId: b._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(campaignA, a, 'A One');
    await campaignRow(campaignA, a, 'A Two');
    await campaignRow(campaignB, b, 'B One');
    await templateRow(b, 'B Template');

    assert.deepEqual(names(await log(a._id)), ['A One', 'A Two']);
    assert.deepEqual(names(await log(b._id)), ['B One', 'B Template']);
  });

  test('the same person messaged for two events appears once under each', async () => {
    const a = await makeEvent('Event A');
    const b = await makeEvent('Event B');
    await templateRow(a, 'Sashi');
    await templateRow(b, 'Sashi');

    assert.equal((await log(a._id)).body.logs.length, 1);
    assert.equal((await log(b._id)).body.logs.length, 1);
  });

  test('an unrelated event\'s template rows do not leak in through the campaign branch', async () => {
    // The $or has two arms; this pins that neither one can widen the other.
    const mine = await makeEvent('Mine');
    const theirs = await makeEvent('Theirs');
    await Campaign.create({ eventId: mine._id, messageText: 'Hi', status: 'Completed' });
    await templateRow(theirs, 'Theirs Template');

    assert.deepEqual((await log(mine._id)).body.logs, []);
  });
});

describe('a status change reaches the log', () => {
  test('pending -> delivered -> read is reflected, by the real webhook', async () => {
    const event = await makeEvent('Live');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(campaign, event, 'Asha', { status: 'Sent', wamid: 'wamid.LIVE1', sentAt: new Date() });

    const before = (await log(event._id)).body.logs[0];
    assert.equal(before.status, 'Sent');
    assert.equal(before.deliveredAt, undefined);

    let res = await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus('wamid.LIVE1', 'delivered') });
    assert.equal(res.status, 200);
    const delivered = await untilLog(event._id, (r) => r.status === 'Delivered');
    assert.ok(delivered.deliveredAt);
    assert.equal(delivered.readAt, undefined);

    res = await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus('wamid.LIVE1', 'read') });
    assert.equal(res.status, 200);
    const read = await untilLog(event._id, (r) => !!r.readAt);
    assert.ok(read.readAt, 'the recipient opening it arrives as readAt');
    assert.deepEqual(names(await log(event._id, '?status=Read')), ['Asha']);
  });

  test('a template message\'s failure is reflected too', async () => {
    const event = await makeEvent('Live Template');
    await templateRow(event, 'Swapnil', { status: 'Sent', wamid: 'wamid.LIVE2', sentAt: new Date() });

    const res = await call('POST', '/api/webhooks/whatsapp', {
      body: webhookStatus('wamid.LIVE2', 'failed', {
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      }),
    });
    assert.equal(res.status, 200);

    const row = await untilLog(event._id, (r) => r.status === 'Failed');
    assert.equal(row.errorCode, 131026);
    assert.deepEqual(names(await log(event._id, '?status=Failed')), ['Swapnil']);
  });

  test('a late out-of-order callback does not walk the status backwards', async () => {
    const event = await makeEvent('Order');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(campaign, event, 'Late', {
      status: 'Delivered', wamid: 'wamid.LATE', sentAt: new Date(), deliveredAt: new Date(), readAt: new Date(),
    });

    await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus('wamid.LATE', 'sent') });
    // A callback that changes nothing leaves nothing to poll for, so the
    // handler is simply given time to have applied it had it been going to.
    await new Promise((r) => setTimeout(r, 400));

    const row = (await log(event._id)).body.logs[0];
    assert.equal(row.status, 'Delivered', 'the log shows the furthest point reached');
    assert.ok(row.readAt);
  });
});

describe('authorization is the event\'s', () => {
  test('no token is refused', async () => {
    const event = await makeEvent('Private');
    const res = await call('GET', `/api/reports/event/${event._id}/delivery-log`);
    assert.equal(res.status, 401);
  });

  test('an Admin with no claim on the event is refused, and sees none of its recipients', async () => {
    const event = await makeEvent('Not Theirs');
    await templateRow(event, 'Secret Guest');
    const admin = await Admin.create({
      name: 'Outsider', email: 'outsider@example.com',
      passwordHash: await bcrypt.hash('TestPass123', 10),
      role: 'Admin', status: 'Active', accessGrantedOn: new Date(),
    });

    const res = await call('GET', `/api/reports/event/${event._id}/delivery-log`, { token: tokenFor(admin, 'Admin') });
    assert.equal(res.status, 403);
    assert.equal(JSON.stringify(res.body).includes('Secret Guest'), false, 'the refusal carries no rows');
  });

  test('an Admin reads the log of an event they created, and not another\'s', async () => {
    const admin = await Admin.create({
      name: 'Owner', email: 'owner@example.com',
      passwordHash: await bcrypt.hash('TestPass123', 10),
      role: 'Admin', status: 'Active', accessGrantedOn: new Date(),
    });
    const owned = await makeEvent('Owned', { createdBy: admin._id });
    const foreign = await makeEvent('Foreign');
    await templateRow(owned, 'Owned Guest');
    await templateRow(foreign, 'Foreign Guest');
    const token = tokenFor(admin, 'Admin');

    const ok = await call('GET', `/api/reports/event/${owned._id}/delivery-log`, { token });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.logs.map((l: any) => l.contactName), ['Owned Guest']);

    const refused = await call('GET', `/api/reports/event/${foreign._id}/delivery-log`, { token });
    assert.equal(refused.status, 403);
  });

  test('a malformed event id is a 400, not a server error', async () => {
    const res = await call('GET', '/api/reports/event/not-an-id/delivery-log', { token: superToken });
    assert.equal(res.status, 400);
  });

  test('the older per-campaign and template endpoints answer as they always did', async () => {
    const event = await makeEvent('Legacy');
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    await campaignRow(campaign, event, 'Campaign Guest', { status: 'Delivered', readAt: new Date() });
    await templateRow(event, 'Template Guest', { status: 'Delivered', readAt: new Date() });

    const c = await call('GET', `/api/reports/campaign/${campaign._id}/logs?status=Read`, { token: superToken });
    assert.deepEqual(c.body.logs.map((l: any) => l.contactName), ['Campaign Guest']);

    const t = await call('GET', `/api/reports/event/${event._id}/template-logs?status=Read`, { token: superToken });
    assert.deepEqual(t.body.logs.map((l: any) => l.contactName), ['Template Guest']);
  });
});

describe('the cost of a request', () => {
  /**
   * Counts the database operations a request causes, by listening to
   * Mongoose's own debug hook, so the claim is measured rather than argued.
   */
  /**
   * Index management is Mongoose housekeeping, not work the request caused.
   * Each model builds its indexes in the background the first time it is used,
   * so a `createIndex` for some unrelated collection can land inside a
   * measurement and make a fixed-cost request look as if it grew. It is left
   * out of the count; every query the request itself makes is still in it.
   */
  const HOUSEKEEPING = new Set(['createIndex', 'createIndexes', 'ensureIndex', 'dropIndex', 'listIndexes', 'indexes']);

  const operationsFor = async (path: string) => {
    const ops: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => {
      if (!HOUSEKEEPING.has(method)) ops.push(`${collection}.${method}`);
    });
    try {
      const res = await call('GET', path, { token: superToken });
      assert.equal(res.status, 200);
      return { ops, rows: res.body.logs.length };
    } finally {
      mongoose.set('debug', false);
    }
  };

  const seed = async (count: number) => {
    const event = await makeEvent(`Load ${count}`);
    const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hi', status: 'Completed' });
    for (let i = 0; i < count; i++) {
      if (i % 2 === 0) await campaignRow(campaign, event, `C${i}`, { status: 'Sent' });
      else await templateRow(event, `T${i}`, { status: 'Sent' });
    }
    return event;
  };

  test('thirty recipients cost exactly as many queries as three', async () => {
    const small = await seed(3);
    const large = await seed(30);

    const few = await operationsFor(`/api/reports/event/${small._id}/delivery-log`);
    const many = await operationsFor(`/api/reports/event/${large._id}/delivery-log`);

    assert.equal(few.rows, 3);
    assert.equal(many.rows, 30);
    assert.equal(
      many.ops.length,
      few.ops.length,
      `the count must not grow with the rows (3 rows: ${few.ops.join(', ')} | 30 rows: ${many.ops.join(', ')})`
    );
  });

  test('the whole log is a small, fixed number of operations', async () => {
    const event = await seed(20);
    const { ops } = await operationsFor(`/api/reports/event/${event._id}/delivery-log`);
    // The campaign lookup, the page, the count, and the batched contact
    // populate. Nothing per recipient.
    assert.ok(ops.length <= 5, `expected a handful of operations, got ${ops.length}: ${ops.join(', ')}`);
  });
});

describe('the Event Report\'s own data is untouched by the log', () => {
  test('the events listing still filters by eventDate, as before', async () => {
    await makeEvent('Inside', { eventDate: new Date('2026-10-01T00:00:00.000Z') });
    await makeEvent('Outside', { eventDate: new Date('2026-11-20T00:00:00.000Z') });

    const res = await call('GET', '/api/events?startDate=2026-10-01&endDate=2026-10-02', { token: superToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((e: any) => e.eventName), ['Inside']);
  });

  test('the events listing carries nothing from the Delivery Log', async () => {
    const event = await makeEvent('Plain');
    await templateRow(event, 'Some Guest');

    const res = await call('GET', '/api/events', { token: superToken });
    const row = res.body.find((e: any) => e.eventName === 'Plain');
    assert.equal('logs' in row, false);
    assert.equal(JSON.stringify(row).includes('Some Guest'), false, 'no recipient data on an event row');
  });

  test('filtering the log never changes which events the report lists', async () => {
    const event = await makeEvent('Stable');
    await templateRow(event, 'Failing Guest', { status: 'Failed' });

    const before = await call('GET', '/api/events', { token: superToken });
    await log(event._id, '?status=Failed');
    await log(event._id, '?status=Read');
    const after = await call('GET', '/api/events', { token: superToken });
    assert.deepEqual(after.body, before.body);
  });
});
