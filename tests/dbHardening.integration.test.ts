import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

/**
 * Database-level enforcement, end to end.
 *
 * Seeds a throwaway local database with every EventReach collection (including
 * production-shaped rows: Double organizerMobile, Int32 minutes eventTime, no
 * eventId), runs the real migrateDbHardening.ts, then bypasses the UI, the API
 * and Mongoose entirely by writing through the raw driver to prove MongoDB
 * itself rejects invalid documents.
 *
 * Requires a mongod on 127.0.0.1:27017.
 */

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');
const { Long } = mongoose.mongo;
const TSNODE = require.resolve('ts-node/dist/bin.js');

const DB = `mongodb://127.0.0.1:27017/eventreach_hard_${Date.now()}`;
let db: any;
const oid = () => new mongoose.Types.ObjectId();
let evId: any, campId: any, contactId: any;

/** Asserts the raw driver refuses the write. */
const rejects = async (fn: () => Promise<any>) => {
  await assert.rejects(fn, (err: any) => /validation|duplicate key/i.test(String(err?.message)));
};

const baseEvent = (o: Record<string, any> = {}) => ({
  eventId: `EVT-9${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
  organizerName: 'A', organizerMobile: Long.fromString('9112472833'), eventName: 'N', eventType: 'T',
  eventDate: new Date(), eventTime: 600, eventVenue: 'V', eventStatus: 'Upcoming',
  createdAt: new Date(), updatedAt: new Date(), ...o,
});

before(async () => {
  await mongoose.connect(DB);
  db = mongoose.connection.db;
  evId = oid(); campId = oid(); contactId = oid();

  await db.collection('events').insertMany([
    { _id: evId, organizerName: 'Asha', organizerMobile: 9112472833, eventName: 'Wedding',
      eventType: 'Wedding', eventDate: new Date('2026-08-23'), eventTime: 762, eventVenue: 'Hall',
      eventStatus: 'Upcoming', createdAt: new Date(1), updatedAt: new Date() },
    { organizerName: 'Prior', organizerMobile: '9112477076', eventName: 'Birthday', eventType: 'Birthday',
      eventDate: new Date('2026-08-23'), eventTime: 1119, eventVenue: 'Cafe', eventStatus: 'Upcoming',
      eventId: 'EVT-000002', createdAt: new Date(3), updatedAt: new Date() },
  ]);
  await db.collection('contacts').insertMany([
    { _id: contactId, fullName: 'Guest', phoneNumber: '+919112472833', countryCode: 'IN',
      email: 'g@gmail.com', eventId: evId, source: 'Manual', status: 'Valid', createdAt: new Date(), updatedAt: new Date() },
    { fullName: 'Bad Row', phoneNumber: '12345abc', countryCode: 'ZZ', email: 'x@yahoo.co.in',
      eventId: evId, source: 'Bulk Import', status: 'Invalid', validationReason: 'bad', createdAt: new Date(), updatedAt: new Date() },
  ]);
  await db.collection('campaigns').insertOne({ _id: campId, eventId: evId, messageText: 'Hi', status: 'Draft',
    mediaAttachments: [], history: [], createdAt: new Date(), updatedAt: new Date() });
  await db.collection('messagelogs').insertOne({ campaignId: campId, contactId, phoneNumber: '+91', status: 'Sent', createdAt: new Date(), updatedAt: new Date() });
  await db.collection('admins').insertOne({ name: 'S', email: 'sa@x.com', passwordHash: 'h', role: 'SuperAdmin',
    status: 'Active', accessDurationValue: 30, accessDurationUnit: 'days', createdAt: new Date(), updatedAt: new Date() });
  await db.collection('users').insertOne({ name: 'U', email: 'u@x.com', passwordHash: 'h', status: 'Active',
    assignedEventId: evId, accessDurationValue: 7, accessDurationUnit: 'days', createdAt: new Date(), updatedAt: new Date() });
  await db.collection('settings').insertOne({ key: 'company_name', value: 'EBO', createdAt: new Date(), updatedAt: new Date() });
  await db.collection('auditlogs').insertOne({ timestamp: new Date(), action: 'X', collectionName: 'events', success: true,
    changes: { before: null, after: { any: [1] }, changedFields: [] }, metadata: {} });

  // Run the real migration.
  execFileSync(process.execPath, [TSNODE, 'migrateDbHardening.ts', '--apply'],
    { cwd: 'backend', env: { ...process.env, MONGODB_URI: DB }, encoding: 'utf8' });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('Migration outcome', () => {
  test('backfills eventId, converts types, preserves the pre-set id', async () => {
    const events = await db.collection('events').find({}).toArray();
    assert.ok(events.every((e: any) => /^EVT-\d{6,}$/.test(e.eventId)), 'all have an eventId');
    assert.equal(new Set(events.map((e: any) => e.eventId)).size, events.length, 'ids unique');
    assert.ok(events.some((e: any) => e.eventId === 'EVT-000002'), 'existing id preserved');
    const types = await db.collection('events').aggregate([{ $group: { _id: { $type: '$organizerMobile' }, n: { $sum: 1 } } }]).toArray();
    assert.deepEqual(types.map((t: any) => t._id), ['long'], 'every organizerMobile is BSON Int64');
    assert.ok(events.every((e: any) => Number.isInteger(e.eventTime) && e.eventTime >= 0 && e.eventTime <= 1439));
  });

  test('every collection has a validator', async () => {
    const withV = (await db.listCollections().toArray()).filter((c: any) => c.options?.validator).map((c: any) => c.name).sort();
    for (const n of ['admins', 'auditlogs', 'campaigns', 'contacts', 'counters', 'events', 'messagelogs', 'settings', 'users']) {
      assert.ok(withV.includes(n), `${n} must have a validator`);
    }
  });
});

describe('MongoDB rejects invalid direct writes (UI, API and Mongoose all bypassed)', () => {
  test('events', async () => {
    await rejects(() => db.collection('events').insertOne(baseEvent({ organizerName: 'x'.repeat(51) })));
    await rejects(() => db.collection('events').insertOne(baseEvent({ organizerMobile: Long.fromString('123') })));        // 3 digits
    await rejects(() => db.collection('events').insertOne(baseEvent({ organizerMobile: Long.fromString('99999999999') })));  // 11 digits
    await rejects(() => db.collection('events').insertOne(baseEvent({ organizerMobile: '9112472833' })));                   // String, not Int64
    await rejects(() => db.collection('events').insertOne(baseEvent({ organizerMobile: 9112472833 })));                     // Double, not Int64
    await rejects(() => db.collection('events').insertOne(baseEvent({ eventTime: 1440 })));
    await rejects(() => db.collection('events').insertOne(baseEvent({ eventTime: -1 })));
    await rejects(() => db.collection('events').insertOne(baseEvent({ eventTime: 600.5 })));
    await rejects(() => db.collection('events').insertOne(baseEvent({ eventStatus: 'Nope' })));
    await rejects(() => db.collection('events').insertOne(baseEvent({ eventName: 'x'.repeat(21) })));
    await rejects(() => db.collection('events').insertOne(baseEvent({ eventId: 'EVT-000002' })));  // duplicate
    await db.collection('events').insertOne(baseEvent()); // valid still accepted
  });

  test('contacts — invalid rejected, intentionally-invalid imports preserved', async () => {
    await rejects(() => db.collection('contacts').insertOne({ fullName: 'x'.repeat(51), phoneNumber: '1', countryCode: 'IN', eventId: evId, source: 'Manual', status: 'Valid' }));
    await rejects(() => db.collection('contacts').insertOne({ fullName: 'A', phoneNumber: '1', countryCode: 'IN', eventId: evId, source: 'Manual', status: 'Bogus' }));
    await rejects(() => db.collection('contacts').insertOne({ fullName: 'A', phoneNumber: '1', countryCode: 'IN', eventId: evId, source: 'Telepathy', status: 'Valid' }));
    await rejects(() => db.collection('contacts').insertOne({ fullName: 'A', phoneNumber: '1', countryCode: 'IN', eventId: String(evId), source: 'Manual', status: 'Valid' }));
    // Must still accept: unparseable phone + non-gmail email, kept on purpose.
    await db.collection('contacts').insertOne({ fullName: 'Kept', phoneNumber: 'not-a-number', countryCode: 'ZZ',
      email: 'a@yahoo.com', eventId: evId, source: 'Bulk Import', status: 'Invalid', validationReason: 'bad' });
  });

  test('campaigns', async () => {
    await rejects(() => db.collection('campaigns').insertOne({ eventId: oid(), status: 'Nope' }));
    await rejects(() => db.collection('campaigns').insertOne({ eventId: oid(), status: 'Draft', mediaAttachments: [{ url: 'u', type: 'hologram', filename: 'f' }] }));
    // No length limit exists today, so a long message must still be accepted.
    await db.collection('campaigns').insertOne({ eventId: oid(), status: 'Draft', messageText: 'x'.repeat(9000), mediaAttachments: [] });
  });

  test('messagelogs', async () => {
    await rejects(() => db.collection('messagelogs').insertOne({ campaignId: campId, contactId, phoneNumber: '+91', status: 'Exploded' }));
    await rejects(() => db.collection('messagelogs').insertOne({ campaignId: String(campId), contactId, phoneNumber: '+91', status: 'Sent' }));
  });

  test('admins and users', async () => {
    await rejects(() => db.collection('admins').insertOne({ name: 'X', email: 'a@x.com', passwordHash: 'h', role: 'Overlord', status: 'Active' }));
    await rejects(() => db.collection('admins').insertOne({ name: 'X', email: 'b@x.com', passwordHash: 'h', role: 'Admin', status: 'Active', accessDurationValue: 2.5 }));
    await rejects(() => db.collection('users').insertOne({ name: 'X', email: 'c@x.com', passwordHash: 'h', status: 'Zombie' }));
    await rejects(() => db.collection('users').insertOne({ name: 'X', email: 'd@x.com', passwordHash: 'h', status: 'Active', accessDurationUnit: 'fortnights' }));
    // A legitimate account must still be writable — this is the lockout guard.
    await db.collection('admins').insertOne({ name: 'S', email: 'valid@x.com', passwordHash: 'h', role: 'SuperAdmin', status: 'Active' });
  });

  test('settings and counters', async () => {
    await rejects(() => db.collection('settings').insertOne({ key: 'secret_backdoor', value: 'v' }));
    await rejects(() => db.collection('settings').insertOne({ key: 'company_name', value: 'x'.repeat(2001) }));
    await rejects(() => db.collection('counters').insertOne({ _id: 'bogus', seq: 1.5 }));
    await rejects(() => db.collection('counters').insertOne({ _id: 'bogus2', seq: -1 }));
  });

  test('auditlogs keeps accepting arbitrary Mixed payloads', async () => {
    // A validator must never be able to make audit logging fail.
    await db.collection('auditlogs').insertOne({
      timestamp: new Date(), action: 'ANYTHING', collectionName: 'whatever', success: false,
      changes: { before: { a: [1, 2, { b: null }] }, after: 'a plain string', changedFields: [] },
      metadata: { deeply: { nested: { arbitrary: [1, 'two', { three: true }] } } },
    });
  });
});
