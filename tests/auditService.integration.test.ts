import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * AuditService.log against a real (throwaway) database.
 *
 * Regression coverage for a production incident: events.organizerMobile is
 * BSON Int64 (a native JS bigint once hydrated by Mongoose), and
 * JSON.stringify throws outright on a bigint — so logging an event update
 * crashed inside AuditService's own change-detection before a record was ever
 * written. These exercise the REAL compiled AuditService (backend/dist) end
 * to end: nothing here reimplements its logic.
 *
 * A second, unrelated defect surfaced by the same code path is covered here
 * too: the pre-fix sanitizer spread any `typeof === 'object'` value to detect
 * nested fields to redact, which silently corrupted every Date (to `{}`) and
 * every ObjectId (to its raw buffer bytes) at any depth. Fixing BigInt
 * without also fixing this would leave every stored audit snapshot's dates
 * broken, so it is verified here alongside the BigInt fix.
 */

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');
const { Long } = mongoose.mongo;

const { AuditService } = require('../backend/dist/services/AuditService');
const { AuditLog } = require('../backend/dist/models/AuditLog');

const DB = `mongodb://127.0.0.1:27017/eventreach_audit_${Date.now()}`;

before(async () => {
  await mongoose.connect(DB);
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

/** Captures console.error output for the duration of `fn`, without printing it. */
const captureConsoleError = async (fn: () => Promise<void>): Promise<string[]> => {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: any[]) => { messages.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return messages;
};

const eventDoc = (o: Record<string, any> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: 'EVT-000001',
  organizerName: 'Asha Menon',
  organizerMobile: Long.fromString('9112472833'), // BSON Int64, as Mongoose hydrates it
  eventName: 'Wedding',
  eventType: 'Wedding',
  eventDate: new Date('2026-08-23T00:00:00.000Z'),
  eventTime: new Date('2026-08-23T12:42:00+05:30'),
  eventVenue: 'Grand Hall',
  eventStatus: 'Upcoming',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...o,
});

describe('AuditService.log with a BigInt (BSON Int64) field', () => {
  test('does not throw and writes a record for an event containing organizerMobile as bigint', async () => {
    const before = eventDoc();
    const after = eventDoc({ organizerMobile: Long.fromString('9112472833'), eventName: 'Wedding Reception' });

    const errors = await captureConsoleError(() => AuditService.log({
      action: 'EVENT_UPDATED',
      collectionName: 'events',
      documentId: String(after._id),
      before,
      after,
      description: 'test',
    }));

    assert.deepEqual(errors, [], 'AuditService.log must not log a failure for a bigint field');

    const saved = await AuditLog.findOne({ documentId: String(after._id) }).lean();
    assert.ok(saved, 'an audit record was actually written');
  });

  test('preserves the exact organizerMobile value as a string, not a lossy Number', async () => {
    // A value this large is still inside Number.MAX_SAFE_INTEGER, but the
    // fix must not rely on that — it always stores a string, never a Number.
    const mobile = '9876543210';
    const doc = eventDoc({ organizerMobile: Long.fromString(mobile) });

    await AuditService.log({ action: 'EVENT_CREATED', collectionName: 'events', documentId: String(doc._id), after: doc });

    const saved = await AuditLog.findOne({ documentId: String(doc._id) }).lean();
    assert.equal(typeof (saved as any).changes.after.organizerMobile, 'string');
    assert.equal((saved as any).changes.after.organizerMobile, mobile);
  });

  test('detects organizerMobile as a changed field across two different Int64 values', async () => {
    const id = new mongoose.Types.ObjectId();
    const before = eventDoc({ _id: id, organizerMobile: Long.fromString('9112472833') });
    const after = eventDoc({ _id: id, organizerMobile: Long.fromString('9999999999') });

    await AuditService.log({ action: 'EVENT_UPDATED', collectionName: 'events', documentId: String(id), before, after });

    const saved = await AuditLog.findOne({ documentId: String(id), action: 'EVENT_UPDATED' }).sort({ _id: -1 }).lean();
    assert.ok((saved as any).changes.changedFields.includes('organizerMobile'));
  });

  test('does not flag organizerMobile as changed when the Int64 value is identical', async () => {
    const id = new mongoose.Types.ObjectId();
    const before = eventDoc({ _id: id, organizerMobile: Long.fromString('9112472833'), eventName: 'Same' });
    const after = eventDoc({ _id: id, organizerMobile: Long.fromString('9112472833'), eventName: 'Same' });

    await AuditService.log({ action: 'EVENT_UPDATED', collectionName: 'events', documentId: String(id), before, after });

    const saved = await AuditLog.findOne({ documentId: String(id), action: 'EVENT_UPDATED' }).sort({ _id: -1 }).lean();
    assert.ok(!(saved as any).changes.changedFields.includes('organizerMobile'), 'identical Int64 values must not be reported as a change');
  });

  test('a native bigint (not just a BSON Long instance) is handled the same way', async () => {
    // Mongoose hydrates the schema-typed field as a native bigint, not a Long
    // wrapper — this is the shape AuditService actually receives in
    // production (via event.toObject()), so it must be covered directly.
    const doc = eventDoc({ organizerMobile: 9112472833n });

    const errors = await captureConsoleError(() => AuditService.log({
      action: 'EVENT_CREATED', collectionName: 'events', documentId: String(doc._id), after: doc,
    }));
    assert.deepEqual(errors, []);

    const saved = await AuditLog.findOne({ documentId: String(doc._id) }).lean();
    assert.equal((saved as any).changes.after.organizerMobile, '9112472833');
  });

  test('a BigInt nested inside an array or a sub-object is also normalized', async () => {
    const doc = eventDoc({
      history: [{ snapshot: { organizerMobile: 9112472833n }, note: 'x' }],
      relatedMobiles: [9112472833n, Long.fromString('9000000000')],
    });

    const errors = await captureConsoleError(() => AuditService.log({
      action: 'EVENT_CREATED', collectionName: 'events', documentId: String(doc._id), after: doc,
    }));
    assert.deepEqual(errors, []);

    const saved = await AuditLog.findOne({ documentId: String(doc._id) }).lean();
    const c = (saved as any).changes.after;
    assert.equal(c.history[0].snapshot.organizerMobile, '9112472833');
    assert.deepEqual(c.relatedMobiles, ['9112472833', '9000000000']);
  });
});

describe('AuditService.log preserves Date and ObjectId fields (regression: naive object-spread corrupted them)', () => {
  test('Date fields at the top level and nested are stored intact, not as {}', async () => {
    const doc = eventDoc({ nested: { reminderAt: new Date('2026-08-20T09:00:00.000Z') } });

    await AuditService.log({ action: 'EVENT_CREATED', collectionName: 'events', documentId: String(doc._id), after: doc });

    const saved = await AuditLog.findOne({ documentId: String(doc._id) }).lean();
    const c = (saved as any).changes.after;
    assert.equal(new Date(c.eventDate).toISOString(), '2026-08-23T00:00:00.000Z');
    assert.equal(new Date(c.createdAt).toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(new Date(c.nested.reminderAt).toISOString(), '2026-08-20T09:00:00.000Z');
  });

  test('an ObjectId field is stored as its id, not its raw buffer bytes', async () => {
    const refId = new mongoose.Types.ObjectId();
    const doc = eventDoc({ assignedUserId: refId });

    await AuditService.log({ action: 'EVENT_CREATED', collectionName: 'events', documentId: String(doc._id), after: doc });

    const saved = await AuditLog.findOne({ documentId: String(doc._id) }).lean();
    assert.equal(String((saved as any).changes.after.assignedUserId), refId.toString());
  });
});

describe('AuditService.log still redacts sensitive fields (regression)', () => {
  test('passwordHash is redacted at the top level and when nested', async () => {
    const doc = { _id: new mongoose.Types.ObjectId(), email: 'a@x.com', passwordHash: 'secret-hash', nested: { passwordHash: 'shh' } };

    await AuditService.log({ action: 'USER_CREATED', collectionName: 'users', documentId: String(doc._id), after: doc });

    const saved = await AuditLog.findOne({ documentId: String(doc._id) }).lean();
    const c = (saved as any).changes.after;
    assert.equal(c.passwordHash, '***REDACTED***');
    assert.equal(c.nested.passwordHash, '***REDACTED***');
    assert.equal(c.email, 'a@x.com');
  });
});
