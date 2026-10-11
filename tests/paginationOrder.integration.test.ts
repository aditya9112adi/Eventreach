import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Deterministic pagination (audit R-3): the guest list and the three
 * delivery-log reports page through records that share one createdAt - as a
 * bulk import or a campaign batch produces - without skipping or repeating a
 * row, newest first with _id breaking ties.
 *
 * Over real HTTP against the REAL compiled backend (backend/dist) on a
 * throwaway database. Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_paginationorder_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const contactRoutes = require('../backend/dist/routes/contactRoutes').default;
const reportRoutes = require('../backend/dist/routes/reportRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');
const { Campaign } = require('../backend/dist/models/Campaign');
const { MessageLog } = require('../backend/dist/models/MessageLog');

let server: any;
let baseUrl = '';
let token = '';

const get = (path: string): Promise<{ status: number; body: any }> =>
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

/** One instant shared by a whole batch, as insertMany gives a bulk import. */
const SAME_INSTANT = new Date('2026-10-01T06:00:00.000Z');
const LATER = new Date('2026-10-02T06:00:00.000Z');
const EARLIER = new Date('2026-09-30T06:00:00.000Z');

const mkEvent = (eventName: string) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Party',
    eventDate: new Date('2026-10-15T00:00:00.000Z'), eventTime: new Date('2026-10-15T04:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming',
  });

let phoneSeq = 0;

/** Written through the driver so createdAt is exactly the given instant. */
const seedContacts = async (eventId: any, count: number, createdAt: Date, prefix = 'Guest') => {
  const docs = Array.from({ length: count }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    fullName: `${prefix} ${String(i).padStart(3, '0')}`,
    phoneNumber: `+91987${String(phoneSeq++).padStart(7, '0')}`,
    countryCode: 'IN', eventId, source: 'Manual', status: 'Valid', createdAt, updatedAt: createdAt,
  }));
  await Contact.collection.insertMany(docs);
  return docs.map((d) => String(d._id));
};

const seedLogs = async (owner: Record<string, any>, count: number, createdAt: Date, status = 'Sent') => {
  const docs = Array.from({ length: count }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    ...owner,
    contactId: new mongoose.Types.ObjectId(),
    contactName: `Recipient ${i}`,
    phoneNumber: `+9198700${String(i).padStart(5, '0')}`,
    status, createdAt, updatedAt: createdAt,
  }));
  await MessageLog.collection.insertMany(docs);
  return docs.map((d) => String(d._id));
};

/** Reads every page of a listing; rowsOf picks the array out of a response. */
const walk = async (path: string, limit: number, rowsOf: (body: any) => any[]) => {
  const sep = path.includes('?') ? '&' : '?';
  const seen: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await get(`${path}${sep}page=${page}&limit=${limit}`);
    assert.equal(res.status, 200, `page ${page} of ${path}`);
    const rows = rowsOf(res.body);
    if (rows.length === 0) break;
    seen.push(...rows.map((r: any) => String(r._id)));
  }
  return seen;
};

/** Newest first; among equal createdAt, the larger _id first. */
const expectedOrder = (groups: { at: Date; ids: string[] }[]) =>
  [...groups]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .flatMap((g) => [...g.ids].sort().reverse());

const assertEveryRowOnce = (seen: string[], expected: string[], label: string) => {
  assert.equal(new Set(seen).size, seen.length, `${label}: no row appears on two pages`);
  assert.deepEqual([...seen].sort(), [...expected].sort(), `${label}: every row appears, none is skipped`);
  assert.deepEqual(seen, expected, `${label}: newest first, _id breaking ties`);
};

const fx: any = {};

before(async () => {
  await mongoose.connect(TEST_DB);
  const superAdmin = await Admin.create({ name: 'Super', email: 'super-page@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  token = jwt.sign({ id: superAdmin._id, email: superAdmin.email, role: 'SuperAdmin' }, process.env.JWT_SECRET, { expiresIn: '1d' });

  // A bulk import: 25 guests in one instant, with one added later and one earlier.
  fx.guestEvent = await mkEvent('Guest Event');
  fx.batch = await seedContacts(fx.guestEvent._id, 25, SAME_INSTANT);
  fx.later = await seedContacts(fx.guestEvent._id, 1, LATER, 'Newest');
  fx.earlier = await seedContacts(fx.guestEvent._id, 1, EARLIER, 'Oldest');

  // A campaign batch and a template send, each written in one instant.
  fx.logEvent = await mkEvent('Log Event');
  const campaign = await Campaign.create({ eventId: fx.logEvent._id, messageText: 'Hello', status: 'Completed' });
  fx.campaignLogs = await seedLogs({ campaignId: campaign._id }, 23, SAME_INSTANT);
  fx.campaignFailed = await seedLogs({ campaignId: campaign._id }, 4, SAME_INSTANT, 'Failed');
  fx.templateLogs = await seedLogs({ eventId: fx.logEvent._id, templateName: 'event_invite' }, 21, SAME_INSTANT);
  fx.templateLater = await seedLogs({ eventId: fx.logEvent._id, templateName: 'event_invite' }, 2, LATER);
  fx.campaignId = String(campaign._id);

  const app = express();
  app.use(express.json());
  app.use('/api/contacts', contactRoutes);
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

const guestGroups = () => [
  { at: SAME_INSTANT, ids: fx.batch },
  { at: LATER, ids: fx.later },
  { at: EARLIER, ids: fx.earlier },
];

describe('the guest list pages through a bulk import exactly once', () => {
  for (const limit of [10, 7, 1]) {
    test(`event guest list, ${limit} per page`, async () => {
      const seen = await walk(`/api/contacts/event/${fx.guestEvent._id}`, limit, (b) => b.data);
      assertEveryRowOnce(seen, expectedOrder(guestGroups()), `limit ${limit}`);
    });
  }

  test('the unpaginated list is in the same order as the pages', async () => {
    const res = await get(`/api/contacts/event/${fx.guestEvent._id}`);
    assert.ok(Array.isArray(res.body), 'still a plain array without page params');
    assert.deepEqual(res.body.map((c: any) => String(c._id)), expectedOrder(guestGroups()));
  });

  test('the primary order is unchanged: newest first', async () => {
    const seen = await walk(`/api/contacts/event/${fx.guestEvent._id}`, 10, (b) => b.data);
    assert.equal(seen[0], fx.later[0], 'the newest guest leads');
    assert.equal(seen[seen.length - 1], fx.earlier[0], 'the oldest guest is last');
  });

  test('a search pages through its matches exactly once', async () => {
    const seen = await walk(`/api/contacts/event/${fx.guestEvent._id}?search=Guest%200`, 4, (b) => b.data);
    // "Guest 000".."Guest 024" in one instant: the 0xx names match "Guest 0".
    assertEveryRowOnce(seen, [...fx.batch].sort().reverse(), 'search');
  });

  test('the all-guests list (GET /api/contacts) pages the same way', async () => {
    const seen = await walk('/api/contacts', 10, (b) => b.data);
    assertEveryRowOnce(seen, expectedOrder(guestGroups()), 'all guests');
  });
});

describe('the delivery-log reports page through a batch exactly once', () => {
  test('campaign logs', async () => {
    const seen = await walk(`/api/reports/campaign/${fx.campaignId}/logs`, 10, (b) => b.logs);
    assertEveryRowOnce(seen, expectedOrder([{ at: SAME_INSTANT, ids: [...fx.campaignLogs, ...fx.campaignFailed] }]), 'campaign logs');
  });

  test('campaign logs filtered by status', async () => {
    const seen = await walk(`/api/reports/campaign/${fx.campaignId}/logs?status=Failed`, 3, (b) => b.logs);
    assertEveryRowOnce(seen, expectedOrder([{ at: SAME_INSTANT, ids: fx.campaignFailed }]), 'failed only');
  });

  test('event template logs', async () => {
    const seen = await walk(`/api/reports/event/${fx.logEvent._id}/template-logs`, 10, (b) => b.logs);
    assertEveryRowOnce(
      seen,
      expectedOrder([{ at: SAME_INSTANT, ids: fx.templateLogs }, { at: LATER, ids: fx.templateLater }]),
      'template logs'
    );
  });

  test('event delivery log - the source of the Delivery Log Excel and PDF export', async () => {
    const seen = await walk(`/api/reports/event/${fx.logEvent._id}/delivery-log`, 10, (b) => b.logs);
    assertEveryRowOnce(
      seen,
      expectedOrder([
        { at: SAME_INSTANT, ids: [...fx.campaignLogs, ...fx.campaignFailed, ...fx.templateLogs] },
        { at: LATER, ids: fx.templateLater },
      ]),
      'delivery log'
    );
    const first = await get(`/api/reports/event/${fx.logEvent._id}/delivery-log?page=1&limit=10`);
    assert.equal(first.body.pagination.total, 50, 'the total is unchanged');
  });
});
