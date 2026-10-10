import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as page from '../frontend/src/utils/accessStatus.ts';
import * as server from '../backend/src/utils/accessStatus.ts';
import { matchesStatusWord } from '../frontend/src/utils/reportSearch.ts';

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

test('a typed Status search means the same statuses on the server as on the page', () => {
  const lists: ReadonlyArray<readonly string[]> = [server.ACCESS_STATUSES, ['Valid', 'Invalid', 'Duplicate']];
  const typed = ['valid', 'Valid', 'inv', 'act', 'ACTIVE', 'sched', 'exp', 'can', 'rej', 'dup', 'd', 'e', 'alid', 'sleeping', '  invalid  '];
  for (const list of lists) {
    for (const text of typed) {
      const onPage = list.filter((status) => matchesStatusWord(status, text));
      assert.deepEqual(server.statusesMatching(list, text), onPage, `"${text}" in ${list.join('/')}`);
    }
  }
  assert.deepEqual(server.statusesMatching(['Valid', 'Invalid', 'Duplicate'], 'valid'), ['Valid'], '"valid" never takes in Invalid');
});
