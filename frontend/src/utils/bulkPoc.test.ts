/**
 * The Bulk POC page: its pure logic, and how the page and route use it.
 *
 * Run: npx tsx --test frontend/src/utils/bulkPoc.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { bulkPocOutcome, canConfirmBulkPoc, plural, pocMobileProblem, type BulkPocPreview, type BulkPocResult } from './bulkPoc';

const read = (p: string) => fs.readFileSync(p, 'utf-8').split('\r\n').join('\n');

const preview = (willUpdate: number): BulkPocPreview => ({
  scope: { kind: 'own', label: 'the events you own that are upcoming' },
  includePast: false,
  mobile: '+919876543210',
  counts: { inScope: 5, willUpdate, alreadySet: 0, noLocalPoc: 2, inheritingSubEvents: 1 },
  scopeToken: 'a1b2c3',
});

const result = (updated: number, failed: number): BulkPocResult => ({
  ...preview(updated + failed),
  bulkOperationId: 'BULK-20261013-ABCD1234',
  expected: updated + failed,
  updated,
  skipped: { alreadySet: 1, noLocalPoc: 2, changedMeanwhile: 0 },
  failed,
  failures: failed ? [{ batch: 2, events: failed, reason: 'The database refused the update.' }] : [],
});

test('an Indian mobile passes the client check; anything else says why', () => {
  for (const ok of ['9876543210', '98765 43210', '+91 98765 43210', '09876543210']) assert.equal(pocMobileProblem(ok), '', ok);
  for (const bad of ['', '12345', 'abcdefghij', '+91+919876543210']) {
    const problem = pocMobileProblem(bad);
    assert.notEqual(problem, '', bad);
    assert.equal(problem.includes('WhatsApp number'), false, 'worded for a POC number, not a WhatsApp number');
  }
});

test('Confirm needs a review that would change something, and no run in progress', () => {
  assert.equal(canConfirmBulkPoc(null, false), false);
  assert.equal(canConfirmBulkPoc(preview(0), false), false);
  assert.equal(canConfirmBulkPoc(preview(3), true), false);
  assert.equal(canConfirmBulkPoc(preview(3), false), true);
});

test('the outcome never claims more than was done', () => {
  assert.deepEqual(bulkPocOutcome(result(3, 0)), { tone: 'success', text: 'Updated 3 events; 3 skipped; 0 failed.' });
  assert.deepEqual(bulkPocOutcome(result(2, 1)), { tone: 'warning', text: 'Updated 2 events; 3 skipped; 1 failed.' });
  assert.deepEqual(bulkPocOutcome(result(0, 3)), { tone: 'error', text: 'Updated 0 events; 3 skipped; 3 failed.' });
  assert.equal(plural(1, 'event'), '1 event');
});

test('the page reviews first, confirms once with the reviewed count, and keeps the number out of the URL', () => {
  const page = read('frontend/src/pages/Events/BulkPocUpdate.tsx');
  assert.ok(page.includes("api.post('/events/poc-bulk/preview', { mobile, includePast })"));
  assert.ok(page.includes("api.post('/events/poc-bulk', { mobile, includePast, expectedCount: preview.counts.willUpdate, scopeToken: preview.scopeToken })"), 'confirms exactly the reviewed events');
  assert.ok(page.includes('if (applyingRef.current || !canConfirmBulkPoc(preview, isApplying) || !preview) return;'), 'a double click cannot submit twice');
  assert.ok(page.includes("data?.code === 'SCOPE_CHANGED' && data.preview"), 'a stale review is replaced, not applied');
  assert.equal(/api\.get\([^)]*mobile/.test(page), false, 'the number is never sent in a query string');
  assert.ok(page.includes('setMobile(e.target.value); setMobileError(\'\'); resetReview();'), 'editing the number needs a new review');
  assert.ok(page.includes('Scope: {preview.scope.label}'), 'the scope is shown before confirming');
  assert.ok(page.includes('role="status" aria-live="polite"'), 'the outcome is announced to screen readers');
});

test('the page is reachable by Admins and Super Admins only, from the Events page', () => {
  const app = read('frontend/src/App.tsx');
  assert.ok(app.includes('<Route path="/events/poc-bulk" element={<PageWrapper><RoleRoute allow={[\'SuperAdmin\', \'Admin\']}><BulkPocUpdate /></RoleRoute></PageWrapper>} />'));
  const list = read('frontend/src/pages/Events/EventList.tsx');
  assert.ok(list.includes('<Link to="/events/poc-bulk">'));
  const linkAt = list.indexOf('<Link to="/events/poc-bulk">');
  const guardAt = list.lastIndexOf("{user?.role !== 'User' && (", linkAt);
  assert.ok(guardAt !== -1 && linkAt - guardAt < 200, 'the link is inside the non-User block');
});
