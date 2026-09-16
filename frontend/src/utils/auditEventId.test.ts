import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuditEventId } from './auditEventId';

const OBJECT_ID = '6aa2d26de0730e88d29f5b1e';

test('resolveAuditEventId finds the human-readable Event ID', async (t) => {
  await t.test('reads it from `after` on a create', () => {
    const log = {
      collectionName: 'events',
      changes: { before: null, after: { eventId: 'EVT-000001', eventName: 'Anniversary' } },
    };
    assert.equal(resolveAuditEventId(log), 'EVT-000001');
  });

  await t.test('reads it from `after` on an update', () => {
    const log = {
      collectionName: 'events',
      changes: {
        before: { eventId: 'EVT-000123', eventName: 'Old' },
        after: { eventId: 'EVT-000123', eventName: 'New' },
      },
    };
    assert.equal(resolveAuditEventId(log), 'EVT-000123');
  });

  await t.test('falls back to `before` on a delete, where `after` is absent', () => {
    const log = {
      collectionName: 'events',
      changes: { before: { eventId: 'EVT-000456' }, after: null },
    };
    assert.equal(resolveAuditEventId(log), 'EVT-000456');
  });

  await t.test('trims surrounding whitespace', () => {
    const log = { collectionName: 'events', changes: { after: { eventId: '  EVT-000007  ' } } };
    assert.equal(resolveAuditEventId(log), 'EVT-000007');
  });
});

test('resolveAuditEventId never surfaces a MongoDB ObjectId', async (t) => {
  await t.test('ignores Contact.eventId, which is an ObjectId reference', () => {
    const log = {
      collectionName: 'contacts',
      changes: { after: { eventId: OBJECT_ID, fullName: 'Asha' } },
    };
    assert.equal(resolveAuditEventId(log), null);
  });

  await t.test('ignores Campaign.eventId, which is an ObjectId reference', () => {
    const log = {
      collectionName: 'campaigns',
      changes: { after: { eventId: OBJECT_ID, status: 'Draft' } },
    };
    assert.equal(resolveAuditEventId(log), null);
  });

  await t.test('rejects an ObjectId even on an events record', () => {
    const log = { collectionName: 'events', changes: { after: { eventId: OBJECT_ID } } };
    assert.equal(resolveAuditEventId(log), null);
  });

  await t.test('rejects a value that merely resembles an Event ID', () => {
    for (const bad of ['EVT-123', 'evt-000001', 'EVT000001', 'EVT-', 'EVT-00000A', '']) {
      const log = { collectionName: 'events', changes: { after: { eventId: bad } } };
      assert.equal(resolveAuditEventId(log), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

test('resolveAuditEventId degrades safely', async (t) => {
  await t.test('returns null for a non-event collection', () => {
    assert.equal(resolveAuditEventId({ collectionName: 'users', changes: { after: {} } }), null);
  });

  await t.test('returns null for an event document with no eventId', () => {
    const log = { collectionName: 'events', changes: { after: { eventName: 'Legacy' } } };
    assert.equal(resolveAuditEventId(log), null);
  });

  await t.test('returns null when changes are missing entirely', () => {
    assert.equal(resolveAuditEventId({ collectionName: 'events' }), null);
    assert.equal(resolveAuditEventId({ collectionName: 'events', changes: null }), null);
  });

  await t.test('returns null for a missing or empty log', () => {
    assert.equal(resolveAuditEventId(undefined), null);
    assert.equal(resolveAuditEventId(null), null);
    assert.equal(resolveAuditEventId({}), null);
  });

  await t.test('does not throw on a non-string eventId', () => {
    const log = { collectionName: 'events', changes: { after: { eventId: 42 } } };
    assert.equal(resolveAuditEventId(log), null);
  });
});
