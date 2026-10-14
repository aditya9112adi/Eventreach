import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Bulk POC mobile update (POST /api/events/poc-bulk/preview and
 * /api/events/poc-bulk), over real HTTP against the REAL compiled backend
 * (backend/dist) on a throwaway local MongoDB database, plus the service
 * directly for the cases that need an injected failure or delay.
 *
 *  - scope: a Super Admin reaches every event; an Admin only the events they
 *    own (decision B) - never one they merely see through an assigned User;
 *  - only `poc.mobile` changes, only where the event has its own POC; the
 *    sender, the rest of the POC, ownership and other fields stay;
 *  - invalid numbers are refused before anything is written;
 *  - a stale review, a repeat submission and a concurrent run write nothing;
 *  - a failure part-way is reported as exactly that.
 *
 * No Meta or WhatsApp call is involved; any outbound request would fail.
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_bulkpoc_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
delete process.env.WHATSAPP_TOKEN;

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const bulk = require('../backend/dist/services/bulkPocService');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { AuditLog } = require('../backend/dist/models/AuditLog');
const { AuditService } = require('../backend/dist/services/AuditService');
const { BulkPocRecovery } = require('../backend/dist/models/BulkPocRecovery');
const { WhatsAppSender } = require('../backend/dist/models/WhatsAppSender');

const NEW = '+919876543210';
const OLD = '+919811111111';

let server: any;
let baseUrl = '';
let ip = 0;
const fx: any = {};

const call = (method: string, p: string, token: string | null, body?: any): Promise<{ status: number; body: any; raw: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(baseUrl + p);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });
const actor = (account: any, role: string) => ({ id: String(account._id), role });

const poc = (name: string, mobile = OLD) => ({ name, mobile, email: `${name.toLowerCase().replace(/\s+/g, '')}@example.com`, responsibility: 'Venue' });

const mkEvent = (eventName: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', ...extra,
  });

const preview = (token: string | null, body: any) => call('POST', '/api/events/poc-bulk/preview', token, body);
const apply = (token: string | null, body: any) => call('POST', '/api/events/poc-bulk', token, body);

/** Reviews over HTTP, checks the count, and returns what confirming must send back. */
const reviewed = async (token: string, body: any, expected: number) => {
  const p = await preview(token, body);
  assert.equal(p.status, 200, p.raw);
  assert.equal(p.body.counts.willUpdate, expected, 'the reviewed count');
  assert.match(p.body.scopeToken, /^[0-9a-f]{32}$/);
  return { ...body, expectedCount: expected, scopeToken: p.body.scopeToken };
};
const confirm = async (token: string, body: any, expected: number) => apply(token, await reviewed(token, body, expected));
/** The same through the service directly. */
const svcReviewed = async (who: any, body: any, expected: number) => {
  const p = await bulk.previewBulkPocUpdate(who, body);
  assert.equal(p.counts.willUpdate, expected, 'the reviewed count');
  return { ...body, expectedCount: expected, scopeToken: p.scopeToken };
};
const mobileOf = async (event: any) => ((await Event.findById(event._id).lean()) as any)?.poc?.mobile ?? null;

/** Every event's id -> its POC mobile, for "nothing else changed" checks. */
const snapshot = async () => new Map(((await Event.find({}).lean()) as any[]).map((e) => [String(e._id), e.poc?.mobile ?? null]));

before(async () => {
  await mongoose.connect(TEST_DB);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-bp@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminA = await Admin.create({ name: 'Admin A', email: 'a-bp@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.adminB = await Admin.create({ name: 'Admin B', email: 'b-bp@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.adminC = await Admin.create({ name: 'Admin C', email: 'c-bp@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.sender = await WhatsAppSender.create({
    phoneNumberId: '300000000000123', wabaId: '900000000000123', displayPhoneNumber: '+91 90000 00123', verifiedName: 'Wedding Team',
    metaStatus: 'CONNECTED', statusCheckedAt: new Date(), listedInMeta: true, enabled: true, allowedAdminIds: [fx.adminA._id],
  });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');
  fx.c = tokenFor(fx.adminC, 'Admin');

  const app = express();
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
  await User.deleteMany({});
  await AuditLog.deleteMany({});
  await BulkPocRecovery.deleteMany({});
  const A = fx.adminA._id;
  const B = fx.adminB._id;
  // Admin A owns these.
  fx.mainA = await mkEvent('A Wedding', { adminId: A, createdBy: A, poc: poc('Asha'), whatsappSenderId: fx.sender._id });
  fx.subOwnA = await mkEvent('A Haldi', { adminId: A, createdBy: A, parentEventId: fx.mainA._id, poc: poc('Ravi') });
  fx.subInheritA = await mkEvent('A Sangeet', { adminId: A, createdBy: A, parentEventId: fx.mainA._id });
  fx.noPocA = await mkEvent('A Reception', { adminId: A, createdBy: A });
  fx.creatorA = await mkEvent('A Legacy', { createdBy: A, poc: poc('Leela') });
  fx.pastA = await mkEvent('A Past', { adminId: A, createdBy: A, poc: poc('Old'), eventStatus: 'Completed' });
  // A Sub-Event whose adminId contradicts its Main Event's: owner unverified.
  fx.oddSub = await mkEvent('Odd Sub', { adminId: B, createdBy: B, parentEventId: fx.mainA._id, poc: poc('Odd') });
  // Admin B owns this, and can SEE A's wedding through an assigned User.
  fx.mainB = await mkEvent('B Gala', { adminId: B, createdBy: B, poc: poc('Bina') });
  await User.create({ name: 'User B', email: 'ub-bp@example.com', passwordHash: 'x', status: 'Active', adminId: B, assignedEventId: fx.mainA._id });
  await Event.updateOne({ _id: fx.mainA._id }, { $set: { assignedUserIds: [] } });
  // A Super Admin's own event.
  fx.superEvent = await mkEvent('Platform Launch', { createdBy: fx.superAdmin._id, poc: poc('Sam') });
});

describe('who may use it', () => {
  test('no token is refused', async () => {
    assert.equal((await preview(null, { mobile: NEW })).status, 401);
    assert.equal((await apply(null, { mobile: NEW, expectedCount: 0 })).status, 401);
  });

  test('a User is refused before anything is counted or written', async () => {
    const user = await User.create({ name: 'Plain User', email: 'pu-bp@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminA._id, assignedEventId: fx.mainA._id });
    const token = tokenFor(user, 'User');
    const before = await snapshot();
    assert.equal((await preview(token, { mobile: NEW })).status, 403);
    assert.equal((await apply(token, { mobile: NEW, expectedCount: 3 })).status, 403);
    assert.deepEqual(await snapshot(), before);
  });
});

describe('invalid numbers are refused before anything happens', () => {
  for (const mobile of ['', '12345', 'abcdefghij', '+1 202 555 0123', '5123456789', '+91+919876543210', 99876543210]) {
    test(`"${mobile}" is refused`, async () => {
      const before = await snapshot();
      const p = await preview(fx.super, { mobile });
      const a = await apply(fx.super, { mobile, expectedCount: 6 });
      assert.equal(p.status, 400);
      assert.equal(p.body.code, 'INVALID_MOBILE');
      assert.equal(a.status, 400);
      assert.equal(a.body.code, 'INVALID_MOBILE');
      assert.deepEqual(await snapshot(), before);
      assert.equal(await AuditLog.countDocuments({ action: 'BULK_EVENT_POC_UPDATED' }), 0);
    });
  }

  test('spacing and a leading 0 or +91 are normalised to one stored form', async () => {
    for (const mobile of ['98765 43210', '09876543210', '+91 98765-43210']) {
      const res = await preview(fx.a, { mobile });
      assert.equal(res.status, 200, res.raw);
      assert.equal(res.body.mobile, NEW);
    }
  });

  test('applying needs the reviewed count and the reviewed scope', async () => {
    for (const body of [{ mobile: NEW }, { mobile: NEW, expectedCount: 3 }, { mobile: NEW, scopeToken: 'x'.repeat(32) }]) {
      const res = await apply(fx.a, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'VALIDATION_ERROR');
    }
    assert.equal(await mobileOf(fx.mainA), OLD);
  });
});

describe('an Admin reaches only the events they own', () => {
  test('the preview counts exactly their upcoming events, and says which are skipped', async () => {
    const res = await preview(fx.a, { mobile: NEW });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.scope.kind, 'own');
    assert.match(res.body.scope.label, /events you own/);
    // mainA, subOwnA, subInheritA, noPocA, creatorA (pastA is completed; oddSub's owner is unverified).
    assert.deepEqual(res.body.counts, { inScope: 5, willUpdate: 3, alreadySet: 0, noLocalPoc: 2, inheritingSubEvents: 1 });
  });

  test('completed and cancelled events are included only when asked', async () => {
    const res = await preview(fx.a, { mobile: NEW, includePast: true });
    assert.deepEqual(res.body.counts, { inScope: 6, willUpdate: 4, alreadySet: 0, noLocalPoc: 2, inheritingSubEvents: 1 });
    assert.match(res.body.scope.label, /completed and cancelled/);
  });

  test("applying changes only their events' POC mobile - nothing else, nobody else's", async () => {
    const before = await snapshot();
    const mainBefore: any = await Event.findById(fx.mainA._id).lean();
    const res = await confirm(fx.a, { mobile: NEW }, 3);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.updated, 3);
    assert.equal(res.body.failed, 0);
    assert.deepEqual(res.body.skipped, { alreadySet: 0, noLocalPoc: 2, changedMeanwhile: 0 });

    const after = await snapshot();
    const changed = [...after].filter(([id, m]) => before.get(id) !== m).map(([id]) => id).sort();
    assert.deepEqual(changed, [fx.mainA, fx.subOwnA, fx.creatorA].map((e) => String(e._id)).sort());
    for (const id of changed) assert.equal(after.get(id), NEW);

    // The rest of the POC, the sender, ownership and other fields are untouched.
    const mainAfter: any = await Event.findById(fx.mainA._id).lean();
    assert.equal(mainAfter.poc.name, mainBefore.poc.name);
    assert.equal(mainAfter.poc.email, mainBefore.poc.email);
    assert.equal(mainAfter.poc.responsibility, mainBefore.poc.responsibility);
    assert.equal(String(mainAfter.whatsappSenderId), String(fx.sender._id), 'the assigned sender is kept');
    assert.equal(String(mainAfter.adminId), String(mainBefore.adminId));
    assert.equal(mainAfter.eventName, mainBefore.eventName);
    assert.equal(String(mainAfter.organizerMobile), String(mainBefore.organizerMobile), 'the organizer number is not the POC');
    assert.equal(((await Event.findById(fx.subInheritA._id).lean()) as any).poc?.mobile ?? null, null, 'an inheriting Sub-Event is not given a POC');
    assert.equal(await WhatsAppSender.countDocuments({ phoneNumberId: '300000000000123', displayPhoneNumber: '+91 90000 00123' }), 1, 'the sender record is untouched');
  });

  test("seeing another Admin's event through an assigned User gives no reach over it", async () => {
    const p = await preview(fx.b, { mobile: NEW });
    assert.deepEqual(p.body.counts, { inScope: 1, willUpdate: 1, alreadySet: 0, noLocalPoc: 0, inheritingSubEvents: 0 });
    const res = await confirm(fx.b, { mobile: NEW }, 1);
    assert.equal(res.status, 200, res.raw);
    assert.equal(await mobileOf(fx.mainB), NEW);
    for (const e of [fx.mainA, fx.subOwnA, fx.oddSub, fx.creatorA, fx.superEvent]) assert.equal(await mobileOf(e), OLD);
  });

  test('an Admin with no events finds none, and applying zero changes nothing', async () => {
    const before = await snapshot();
    const p = await preview(fx.c, { mobile: NEW });
    assert.deepEqual(p.body.counts, { inScope: 0, willUpdate: 0, alreadySet: 0, noLocalPoc: 0, inheritingSubEvents: 0 });
    const res = await confirm(fx.c, { mobile: NEW }, 0);
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 0);
    assert.deepEqual(await snapshot(), before);
  });
});

describe('a Super Admin reaches every event', () => {
  test('every upcoming event with its own POC is updated, whoever owns it', async () => {
    const p = await preview(fx.super, { mobile: NEW });
    assert.equal(p.body.scope.kind, 'all');
    // All but pastA: mainA, subOwnA, subInheritA, noPocA, creatorA, oddSub, mainB, superEvent.
    assert.deepEqual(p.body.counts, { inScope: 8, willUpdate: 6, alreadySet: 0, noLocalPoc: 2, inheritingSubEvents: 1 });
    const res = await confirm(fx.super, { mobile: NEW }, 6);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.updated, 6);
    for (const e of [fx.mainA, fx.subOwnA, fx.creatorA, fx.oddSub, fx.mainB, fx.superEvent]) assert.equal(await mobileOf(e), NEW);
    assert.equal(await mobileOf(fx.pastA), OLD, 'a completed event is not rewritten unless asked');
  });

  test('the audit entry records actor, scope and counts, with the number masked', async () => {
    const res = await confirm(fx.super, { mobile: NEW }, 6);
    assert.equal(res.status, 200);
    const entries: any[] = await AuditLog.find({ action: 'BULK_EVENT_POC_UPDATED' }).lean();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.actor.role, 'SuperAdmin');
    assert.equal(entry.bulkOperationId, res.body.bulkOperationId);
    assert.equal(entry.bulk.isBulk, true);
    assert.equal(entry.bulk.totalRecords, 6);
    assert.equal(entry.bulk.successfulRecords, 6);
    assert.equal(entry.bulk.failedRecords, 0);
    assert.equal(entry.metadata.scope, 'all');
    assert.equal(entry.metadata.newMobile, '+91******3210');
    assert.equal(JSON.stringify(entry).includes('9876543210'), false, 'the full number is not in the audit log');
    assert.match(entry.description, /6 of 6 events/);
  });
});

describe('stale reviews, repeats and concurrent runs write nothing', () => {
  test('a repeated submission after it finished is refused, and changes nothing', async () => {
    const first = await reviewed(fx.a, { mobile: NEW }, 3);
    assert.equal((await apply(fx.a, first)).status, 200);
    const before = await snapshot();
    const again = await apply(fx.a, first);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'SCOPE_CHANGED');
    assert.equal(again.body.preview.counts.willUpdate, 0);
    assert.equal(again.body.preview.counts.alreadySet, 3);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await AuditLog.countDocuments({ action: 'BULK_EVENT_POC_UPDATED' }), 1);
  });

  test('an event changed after the review makes the review stale: nothing is written', async () => {
    const stale = await reviewed(fx.a, { mobile: NEW }, 3);
    await Event.updateOne({ _id: fx.subOwnA._id }, { $unset: { poc: 1 } });
    const before = await snapshot();
    const res = await apply(fx.a, stale);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SCOPE_CHANGED');
    assert.equal(res.body.preview.counts.willUpdate, 2);
    assert.deepEqual(await snapshot(), before);
  });

  test('a different set of the same size is still a stale review: only the reviewed events can be confirmed', async () => {
    const stale = await reviewed(fx.a, { mobile: NEW }, 3);
    // One reviewed event loses its POC and another gains one: still 3 to update, but not the same 3.
    await Event.updateOne({ _id: fx.subOwnA._id }, { $unset: { poc: 1 } });
    await Event.updateOne({ _id: fx.noPocA._id }, { $set: { poc: poc('Newcomer') } });
    assert.equal((await preview(fx.a, { mobile: NEW })).body.counts.willUpdate, 3);
    const before = await snapshot();
    const res = await apply(fx.a, stale);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SCOPE_CHANGED');
    assert.notEqual(res.body.preview.scopeToken, stale.scopeToken);
    assert.deepEqual(await snapshot(), before);
  });

  test('a review is tied to its number and its status range', async () => {
    const reviewedScope = await reviewed(fx.a, { mobile: NEW }, 3);
    assert.equal((await apply(fx.a, { ...reviewedScope, mobile: '+919822222222' })).body.code, 'SCOPE_CHANGED');
    assert.equal((await apply(fx.a, { ...reviewedScope, includePast: true })).body.code, 'SCOPE_CHANGED');
    assert.equal(await mobileOf(fx.mainA), OLD);
  });

  test('a second run by the same account while one is in progress is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const scope = await svcReviewed(actor(fx.adminA, 'Admin'), { mobile: NEW }, 3);
    const slow = bulk.applyBulkPocUpdate(actor(fx.adminA, 'Admin'), scope, {
      updateBatch: async (filter: any, mobile: string) => {
        await gate;
        const r = await Event.updateMany(filter, { $set: { 'poc.mobile': mobile } });
        return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = await bulk.applyBulkPocUpdate(actor(fx.adminA, 'Admin'), scope).catch((e: any) => e);
    assert.equal(second.code, 'BULK_POC_IN_PROGRESS');
    assert.equal(second.httpStatus, 409);
    release();
    assert.equal((await slow).updated, 3);
    // Once finished, the account may run again (here: nothing left to change).
    const third = await bulk.applyBulkPocUpdate(actor(fx.adminA, 'Admin'), await svcReviewed(actor(fx.adminA, 'Admin'), { mobile: NEW }, 0));
    assert.equal(third.updated, 0);
  });

  test('an event changed by someone else during the run is left alone and counted', async () => {
    const result = await bulk.applyBulkPocUpdate(actor(fx.superAdmin, 'SuperAdmin'), await svcReviewed(actor(fx.superAdmin, 'SuperAdmin'), { mobile: NEW }, 6), {
      batchSize: 2,
      updateBatch: async (filter: any, mobile: string, batchIndex: number) => {
        // Before the second batch runs, another request removes one of its POCs.
        if (batchIndex === 2) {
          const pending: any[] = await Event.find(filter).select('_id').lean();
          await Event.updateOne({ _id: pending[0]._id }, { $unset: { poc: 1 } });
        }
        const r = await Event.updateMany(filter, { $set: { 'poc.mobile': mobile } });
        return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
      },
    });
    assert.equal(result.updated, 5);
    assert.equal(result.skipped.changedMeanwhile, 1);
    assert.equal(result.failed, 0);
  });
});

describe('a failure part-way is reported as exactly that', () => {
  test('one failed batch: the others are written, the failure is counted, a retry finishes the rest', async () => {
    const result = await bulk.applyBulkPocUpdate(actor(fx.superAdmin, 'SuperAdmin'), await svcReviewed(actor(fx.superAdmin, 'SuperAdmin'), { mobile: NEW }, 6), {
      batchSize: 2,
      updateBatch: async (filter: any, mobile: string, batchIndex: number) => {
        if (batchIndex === 2) throw new Error('simulated write failure');
        const r = await Event.updateMany(filter, { $set: { 'poc.mobile': mobile } });
        return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
      },
    });
    assert.equal(result.updated, 4);
    assert.equal(result.failed, 2);
    assert.deepEqual(result.failures, [{ batch: 2, events: 2, reason: 'The database refused the update.' }]);
    assert.equal(JSON.stringify(result.failures).includes('simulated'), false, 'internal error text is not passed on');

    // Reviewing again finds exactly the two that failed; applying finishes them.
    const p = await preview(fx.super, { mobile: NEW });
    assert.equal(p.body.counts.willUpdate, 2);
    assert.equal(p.body.counts.alreadySet, 4);
    const retry = await confirm(fx.super, { mobile: NEW }, 2);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.updated, 2);
  });

  test('reading the ids failing part-way: what was written stays, the rest is reported, not lost', async () => {
    const scope = await svcReviewed(actor(fx.superAdmin, 'SuperAdmin'), { mobile: NEW }, 6);
    const result = await bulk.applyBulkPocUpdate(actor(fx.superAdmin, 'SuperAdmin'), scope, {
      batchSize: 2,
      readIds: (filter: any) => (async function* () {
        const docs: any[] = await Event.find(filter).select('_id').sort({ _id: 1 }).lean();
        yield docs[0];
        yield docs[1];
        yield docs[2];
        throw new Error('connection lost');
      })(),
    });
    assert.equal(result.updated, 2, 'the first full batch was written');
    assert.equal(result.failed, 4, 'the unflushed id and the unread rest are reported');
    assert.deepEqual(result.failures, [{ batch: 2, events: 4, reason: 'The run stopped early: the database stopped answering.' }]);
    const p = await preview(fx.super, { mobile: NEW });
    assert.equal(p.body.counts.willUpdate, 4, 'reviewing again finds exactly what is left');
  });

  test('a run where every batch fails writes nothing and says so', async () => {
    const before = await snapshot();
    const result = await bulk.applyBulkPocUpdate(actor(fx.adminA, 'Admin'), await svcReviewed(actor(fx.adminA, 'Admin'), { mobile: NEW }, 3), {
      updateBatch: async () => { throw new Error('down'); },
    });
    assert.equal(result.failures[0].reason, 'The database refused the update.');
    assert.equal(result.updated, 0);
    assert.equal(result.failed, 3);
    assert.deepEqual(await snapshot(), before);
  });
});

describe('large scopes are written in bounded batches', () => {
  test('events are updated a batch at a time, each batch re-checking its condition', async () => {
    const A = fx.adminA._id;
    for (let i = 0; i < 25; i++) await mkEvent(`Bulk ${i}`, { adminId: A, createdBy: A, poc: poc(`P${i}`) });
    const sizes: number[] = [];
    const result = await bulk.applyBulkPocUpdate(actor(fx.adminA, 'Admin'), await svcReviewed(actor(fx.adminA, 'Admin'), { mobile: NEW }, 28), {
      batchSize: 10,
      updateBatch: async (filter: any, mobile: string) => {
        sizes.push(filter.$and[0].$or.length);
        assert.ok(filter.$and[1], 'the full condition is applied to every batch');
        const r = await Event.updateMany(filter, { $set: { 'poc.mobile': mobile } });
        return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
      },
    });
    assert.deepEqual(sizes, [10, 10, 8]);
    assert.equal(result.updated, 28);
  });
});

describe('the stored number matches what a single-event edit stores', () => {
  test('the same Indian mobile, however it is typed, is stored identically by both', async () => {
    for (const typed of ['98765 43210', '09876543210', '+91 98765-43210']) {
      const single = await call('PUT', `/api/events/${fx.mainA._id}/contact`, fx.a, { poc: { name: 'Asha', mobile: typed } });
      assert.equal(single.status, 200, `${typed}: ${single.raw}`);
      const storedBySingleEdit = await mobileOf(fx.mainA);
      const bulkForm = (await preview(fx.a, { mobile: typed })).body.mobile;
      assert.equal(bulkForm, storedBySingleEdit, typed);
      assert.equal(bulkForm, NEW);
    }
  });

  test('bulk accepts Indian mobiles only - stricter than the single edit, which also takes other numbers', async () => {
    for (const typed of ['+1 202 555 0123', '020 2612 3456']) {
      const single = await call('PUT', `/api/events/${fx.mainA._id}/contact`, fx.a, { poc: { name: 'Asha', mobile: typed } });
      assert.equal(single.status, 200, `the single edit accepts ${typed}`);
      const bulkPreview = await preview(fx.a, { mobile: typed });
      assert.equal(bulkPreview.status, 400, `bulk refuses ${typed}`);
      assert.equal(bulkPreview.body.code, 'INVALID_MOBILE');
    }
  });
});

// ── run audit, recovery data and audit failures ─────────────────────────────

const SOMEONE_ELSES = '+919833333333';
const FULL_NUMBERS = ['9811111111', '9876543210', '9833333333'];

/** Everything written to the console while fn runs. */
const captureConsole = async <T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> => {
  const lines: string[] = [];
  const saved: Record<string, any> = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[level] = (console as any)[level];
    (console as any)[level] = (...args: any[]) => lines.push(args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' '));
  }
  try { return { value: await fn(), output: lines.join('\n') }; } finally { for (const level of Object.keys(saved)) (console as any)[level] = saved[level]; }
};

/** AuditService.log made to fail for the entries `failWhen` picks; restored afterwards. */
const withAuditFailing = async <T>(failWhen: (params: any) => boolean, fn: () => Promise<T>): Promise<T> => {
  const real = AuditService.log;
  AuditService.log = async (params: any) => (failWhen(params) ? false : real.call(AuditService, params));
  try { return await fn(); } finally { AuditService.log = real; }
};

const realUpdateMany = async (filter: any, mobile: string) => {
  const r = await Event.updateMany(filter, { $set: { 'poc.mobile': mobile } });
  return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
};
const runEntries = async (runId: string) => ((await AuditLog.find({ bulkOperationId: runId }).sort({ timestamp: 1, _id: 1 }).lean()) as any[]);
const recoveryOf = async (runId: string) => ((await BulkPocRecovery.find({ runId }).sort({ batchIndex: 1 }).lean()) as any[]);

describe('every run is audited before, during and after, and can be recovered', () => {
  const superActor = () => actor(fx.superAdmin, 'SuperAdmin');

  test('a start record exists, and the recovery data is saved, before the first event changes', async () => {
    const scope = await svcReviewed(superActor(), { mobile: NEW }, 6);
    let seenAtFirstWrite: any = null;
    const result = await bulk.applyBulkPocUpdate(superActor(), scope, {
      batchSize: 6,
      updateBatch: async (filter: any, mobile: string, batchIndex: number) => {
        const started: any[] = await AuditLog.find({ action: 'BULK_EVENT_POC_STARTED' }).lean();
        const finished = await AuditLog.countDocuments({ action: 'BULK_EVENT_POC_UPDATED' });
        const recovery = await recoveryOf(started[0]?.bulkOperationId);
        seenAtFirstWrite = {
          started: started.length, finished, recoveryBatches: recovery.length, status: recovery[0]?.status,
          entries: recovery[0]?.entries.length, eventsStillOld: await Event.countDocuments({ 'poc.mobile': OLD }),
        };
        return realUpdateMany(filter, mobile);
      },
    });
    assert.deepEqual(seenAtFirstWrite, { started: 1, finished: 0, recoveryBatches: 1, status: 'prepared', entries: 6, eventsStillOld: 7 });
    const entries = await runEntries(result.bulkOperationId);
    assert.deepEqual(entries.map((e) => e.action), ['BULK_EVENT_POC_STARTED', 'BULK_EVENT_POC_UPDATED'], 'one run id links the start and the outcome');
    assert.deepEqual(result.audit, { runId: result.bulkOperationId, started: true, completed: true });
    assert.equal(entries[0].bulk.totalRecords, 6);
    assert.equal(entries[1].metadata.outcome, 'completed');
    assert.equal(entries[1].success, true);
  });

  test('recovery data keeps every previous number in full; audit entries and console output never show a full number', async () => {
    const { value: res, output } = await captureConsole(async () => confirm(fx.a, { mobile: NEW }, 3));
    assert.equal(res.status, 200, res.raw);
    const runId = res.body.bulkOperationId;
    const docs = await recoveryOf(runId);
    assert.equal(docs.length, 1);
    const [doc] = docs;
    assert.equal(doc.status, 'applied');
    assert.deepEqual(doc.outcome, { matched: 3, modified: 3 });
    assert.equal(doc.newMobile, NEW);
    assert.deepEqual(doc.entries.map((e: any) => String(e.eventId)).sort(), [fx.mainA, fx.subOwnA, fx.creatorA].map((e: any) => String(e._id)).sort());
    assert.ok(doc.entries.every((e: any) => e.previousMobile === OLD), 'previous values are kept in full');
    assert.equal(doc.actorId, String(fx.adminA._id));
    const keptDays = (new Date(doc.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(keptDays > 89 && keptDays <= 90.01, `kept for about 90 days, got ${keptDays}`);
    assert.equal(res.body.recovery.batches, 1);
    assert.equal(res.body.recovery.retentionDays, 90);

    const audit = JSON.stringify(await runEntries(runId));
    for (const n of FULL_NUMBERS) {
      assert.equal(audit.includes(n), false, `audit entries must not contain ${n}`);
      assert.equal(output.includes(n), false, `console output must not contain ${n}`);
    }
    assert.ok(audit.includes('+91******3210'), 'the number is shown masked');
  });

  test('the saved data is enough to put events back (manual procedure: only where the event still holds the new number)', async () => {
    const res = await confirm(fx.super, { mobile: NEW }, 6);
    const docs = await recoveryOf(res.body.bulkOperationId);
    // Someone edits one event after the run: that one must not be restored over.
    await Event.updateOne({ _id: fx.mainB._id }, { $set: { 'poc.mobile': SOMEONE_ELSES } });
    let restored = 0;
    for (const doc of docs) {
      for (const entry of doc.entries) {
        const r = await Event.updateOne({ _id: entry.eventId, 'poc.mobile': doc.newMobile }, { $set: { 'poc.mobile': entry.previousMobile } });
        restored += r.modifiedCount;
      }
    }
    assert.equal(restored, 5);
    for (const e of [fx.mainA, fx.subOwnA, fx.creatorA, fx.oddSub, fx.superEvent]) assert.equal(await mobileOf(e), OLD);
    assert.equal(await mobileOf(fx.mainB), SOMEONE_ELSES, 'a later edit is not overwritten by the restore');
  });

  test('a partial failure is recorded as partial, under the same run id; the unfinished batch stays recoverable', async () => {
    const scope = await svcReviewed(superActor(), { mobile: NEW }, 6);
    const result = await bulk.applyBulkPocUpdate(superActor(), scope, {
      batchSize: 2,
      updateBatch: async (filter: any, mobile: string, batchIndex: number) => {
        if (batchIndex === 2) throw new Error('write failed');
        return realUpdateMany(filter, mobile);
      },
    });
    assert.equal(result.updated, 4);
    assert.equal(result.failed, 2);
    const entries = await runEntries(result.bulkOperationId);
    assert.deepEqual(entries.map((e) => e.action), ['BULK_EVENT_POC_STARTED', 'BULK_EVENT_POC_UPDATED']);
    assert.equal(entries[1].success, false);
    assert.equal(entries[1].metadata.outcome, 'partial');
    assert.equal(entries[1].bulk.successfulRecords, 4);
    assert.equal(entries[1].bulk.failedRecords, 2);
    assert.equal(entries[1].metadata.failedBatches, 1);
    const docs = await recoveryOf(result.bulkOperationId);
    assert.deepEqual(docs.map((d) => [d.batchIndex, d.status, d.entries.length]), [[1, 'applied', 2], [2, 'prepared', 2], [3, 'applied', 2]]);
    for (const entry of docs[1].entries) assert.equal(await mobileOf({ _id: entry.eventId }), OLD, 'the failed batch changed nothing');
  });

  test('if the start record cannot be saved, nothing is changed', async () => {
    const reviewedScope = await reviewed(fx.super, { mobile: NEW }, 6);
    const before = await snapshot();
    const res = await withAuditFailing((p) => p.action === 'BULK_EVENT_POC_STARTED', () => apply(fx.super, reviewedScope));
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'AUDIT_UNAVAILABLE');
    assert.deepEqual(await snapshot(), before);
    assert.equal(await BulkPocRecovery.countDocuments({}), 0);
    assert.equal(await AuditLog.countDocuments({ action: { $regex: /^BULK_EVENT_POC/ } }), 0);
    // The failure does not poison the account: the same review can be confirmed once audit works again.
    const again = await apply(fx.super, reviewedScope);
    assert.equal(again.status, 200, again.raw);
  });

  test('if the outcome record cannot be saved, the changes stand and the result says it is not fully audited', async () => {
    const reviewedScope = await reviewed(fx.a, { mobile: NEW }, 3);
    const res = await withAuditFailing((p) => p.action === 'BULK_EVENT_POC_UPDATED', () => apply(fx.a, reviewedScope));
    assert.equal(res.status, 207, 'not a clean success');
    assert.equal(res.body.updated, 3);
    assert.equal(res.body.failed, 0);
    assert.deepEqual(res.body.audit, { runId: res.body.bulkOperationId, started: true, completed: false });
    assert.equal(await mobileOf(fx.mainA), NEW);
    const entries = await runEntries(res.body.bulkOperationId);
    assert.deepEqual(entries.map((e) => e.action), ['BULK_EVENT_POC_STARTED'], 'an unfinished-looking run: a start with no outcome');
    assert.equal((await recoveryOf(res.body.bulkOperationId)).length, 1);
  });

  test('a clean run reports itself as fully audited', async () => {
    const res = await confirm(fx.a, { mobile: NEW }, 3);
    assert.equal(res.status, 200);
    assert.equal(res.body.audit.completed, true);
  });

  test('if a batch\'s recovery data cannot be saved, that batch is not changed and is reported as failed', async () => {
    const scope = await svcReviewed(superActor(), { mobile: NEW }, 6);
    const realCreate = BulkPocRecovery.create.bind(BulkPocRecovery);
    BulkPocRecovery.create = async (doc: any) => { if (doc.batchIndex === 2) throw new Error(`disk full for ${doc.entries[0].previousMobile}`); return realCreate(doc); };
    let outcome: any;
    try {
      outcome = await captureConsole(() => bulk.applyBulkPocUpdate(superActor(), scope, { batchSize: 2 }));
    } finally { BulkPocRecovery.create = realCreate; }
    const result = outcome.value;
    assert.equal(result.updated, 4);
    assert.equal(result.failed, 2);
    assert.deepEqual(result.failures, [{ batch: 2, events: 2, reason: 'Recovery data could not be saved, so this batch was not changed.' }]);
    assert.equal(await Event.countDocuments({ 'poc.mobile': OLD }), 3, 'the two events of the failed batch and the completed event still hold their old number');
    assert.equal(result.recovery.batches, 2);
    for (const n of FULL_NUMBERS) assert.equal(outcome.output.includes(n), false, 'the error text is not logged');
    assert.equal((await runEntries(result.bulkOperationId))[1].metadata.outcome, 'partial');
  });

  test('a run that stops mid-way leaves a start record, no outcome, and recovery data for what was in flight', async () => {
    const scope = await svcReviewed(superActor(), { mobile: NEW }, 6);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const running = bulk.applyBulkPocUpdate(superActor(), scope, {
      batchSize: 2,
      updateBatch: async (filter: any, mobile: string, batchIndex: number) => {
        if (batchIndex === 2) await gate; // the process "stops" here: batch 2 is saved but not applied
        return realUpdateMany(filter, mobile);
      },
    });
    // Wait until batch 2's recovery data is saved and the batch is waiting.
    let docs: any[] = [];
    for (let i = 0; i < 100 && !(docs.length === 2 && docs[0].status === 'applied'); i++) {
      await new Promise((r) => setTimeout(r, 30));
      const started: any[] = await AuditLog.find({ action: 'BULK_EVENT_POC_STARTED' }).lean();
      docs = started[0] ? await recoveryOf(started[0].bulkOperationId) : [];
    }
    const started: any[] = await AuditLog.find({ action: 'BULK_EVENT_POC_STARTED' }).lean();
    assert.equal(started.length, 1);
    assert.equal(await AuditLog.countDocuments({ action: 'BULK_EVENT_POC_UPDATED' }), 0, 'no outcome yet: the run is recognisably unfinished');
    assert.deepEqual(docs.map((d) => [d.batchIndex, d.status]), [[1, 'applied'], [2, 'prepared']]);
    for (const entry of docs[0].entries) assert.equal(await mobileOf({ _id: entry.eventId }), NEW);
    for (const entry of docs[1].entries) {
      assert.equal(entry.previousMobile, OLD);
      assert.equal(await mobileOf({ _id: entry.eventId }), OLD, 'batch 2 is saved but not applied');
    }
    release();
    const result = await running;
    assert.equal(result.updated, 6);
  });

  test('an edit made after the previous values were saved is never overwritten', async () => {
    const scope = await svcReviewed(superActor(), { mobile: NEW }, 6);
    const result = await bulk.applyBulkPocUpdate(superActor(), scope, {
      batchSize: 6,
      updateBatch: async (filter: any, mobile: string) => {
        // After the snapshot, before the write: someone sets a different number on one event.
        await Event.updateOne({ _id: fx.mainA._id }, { $set: { 'poc.mobile': SOMEONE_ELSES } });
        return realUpdateMany(filter, mobile);
      },
    });
    assert.equal(result.updated, 5);
    assert.equal(result.skipped.changedMeanwhile, 1);
    assert.equal(await mobileOf(fx.mainA), SOMEONE_ELSES);
  });

  test('two runs by different accounts racing over the same events change each event exactly once', async () => {
    const second = await Admin.create({ name: 'Super Two', email: 'super2-bp@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
    const first = superActor();
    const other = actor(second, 'SuperAdmin');
    const reviewedFirst = await svcReviewed(first, { mobile: NEW }, 6);
    const reviewedOther = await svcReviewed(other, { mobile: NEW }, 6);
    // Hold both runs after they have saved their previous values, so both have seen the old numbers.
    let arrived = 0;
    let open!: () => void;
    const barrier = new Promise<void>((r) => { open = r; });
    const hold = async (filter: any, mobile: string, batchIndex: number) => {
      if (batchIndex === 1) { arrived += 1; if (arrived === 2) open(); await barrier; }
      return realUpdateMany(filter, mobile);
    };
    const [a, b] = await Promise.all([
      bulk.applyBulkPocUpdate(first, reviewedFirst, { batchSize: 2, updateBatch: hold }),
      bulk.applyBulkPocUpdate(other, reviewedOther, { batchSize: 2, updateBatch: hold }),
    ]);
    assert.equal(a.updated + b.updated, 6, 'each event is changed by exactly one of the two runs');
    assert.notEqual(a.bulkOperationId, b.bulkOperationId);
    for (const run of [a, b]) {
      assert.equal(run.audit.completed, true);
      for (const doc of await recoveryOf(run.bulkOperationId)) assert.ok(doc.entries.every((e: any) => e.previousMobile === OLD), 'no run ever recorded the new number as "previous"');
    }
    assert.equal(await Event.countDocuments({ 'poc.mobile': NEW }), 6);
  });

  test('the recovery collection can only be reached by the service: no route, controller or report uses it', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && fs.readFileSync(full, 'utf8').includes('BulkPocRecovery')) users.push(path.relative('backend/src', full).replace(/\\/g, '/'));
      }
    };
    walk('backend/src');
    assert.deepEqual(users.sort(), ['models/BulkPocRecovery.ts', 'services/bulkPocService.ts']);
  });

  test('recovery documents are one per batch and expire: unique run+batch, and a TTL index', async () => {
    await BulkPocRecovery.init();
    const indexes: any[] = await BulkPocRecovery.collection.indexes();
    const ttl = indexes.find((i) => i.key.expiresAt === 1);
    assert.equal(ttl?.expireAfterSeconds, 0);
    const unique = indexes.find((i) => i.key.runId === 1 && i.key.batchIndex === 1);
    assert.equal(unique?.unique, true);
  });
});
