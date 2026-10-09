import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as page from '../frontend/src/utils/accessStatus.ts';
import * as server from '../backend/src/utils/accessStatus.ts';

/**
 * The Access Report's Status filter runs on the server; the page shows the
 * status it derives itself. The two copies of the rules must agree for every
 * kind of record, or a filtered report would show a status it was not
 * filtered by.
 *
 * Run: npx tsx --test tests/accessStatusParity.test.ts
 */

const DAY = 24 * 3600 * 1000;
const past = new Date(Date.now() - 30 * DAY).toISOString();
const future = new Date(Date.now() + 30 * DAY).toISOString();

const RECORDS: Array<[string, any]> = [
  ['approved, no window', { status: 'Active' }],
  ['approved, window open', { status: 'Active', accessStartDate: past, accessExpiryDate: future }],
  ['not started yet', { status: 'Active', accessStartDate: future, accessExpiryDate: future }],
  ['expired', { status: 'Active', accessExpiryDate: past }],
  ['cancelled', { status: 'Active', isAccessCancelled: true, accessExpiryDate: future }],
  ['cancelled and expired', { status: 'Active', isAccessCancelled: true, accessExpiryDate: past }],
  ['rejected', { status: 'Rejected' }],
  ['rejected and cancelled', { status: 'Rejected', isAccessCancelled: true }],
  ['pending approval', { status: 'Pending' }],
  ['no record', null],
];

test('the server derives every status exactly as the page does', () => {
  for (const [label, record] of RECORDS) {
    assert.equal(server.getAccessStatus(record), page.getAccessStatus(record), label);
  }
});

test('both offer the same statuses, in the same order', () => {
  assert.deepEqual([...server.ACCESS_STATUSES], [...page.ACCESS_STATUSES]);
  for (const [, record] of RECORDS) {
    assert.ok((server.ACCESS_STATUSES as readonly string[]).includes(server.getAccessStatus(record)));
  }
});
