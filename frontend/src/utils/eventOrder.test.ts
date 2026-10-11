/**
 * The Events tab's default order: newest-created first, ties by _id - the
 * order GET /events returns (tests/eventDbHardening.integration.test.ts checks
 * the server's side).
 *
 * Run: npx tsx --test frontend/src/utils/eventOrder.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { compareNewestCreatedFirst } from './eventOrder.ts';
import { getPaginatedData } from './pagination.ts';

const ev = (_id: string, createdAt: string | undefined, eventDate: string, eventType = 'Wedding', eventName = _id) =>
  ({ _id, createdAt, eventDate, eventType, eventName });

// Hex ObjectIds: a larger id was created later.
const A = ev('6a0000000000000000000001', '2026-10-01T06:00:00.000Z', '2027-06-01');
const B = ev('6a0000000000000000000002', '2026-10-05T06:00:00.000Z', '2027-01-01', 'Conference');
const C = ev('6a0000000000000000000003', '2026-10-03T06:00:00.000Z', '2028-01-01');
const D = ev('6a0000000000000000000004', '2026-10-07T06:00:00.000Z', '2026-12-01', 'Conference');
const E = ev('6a0000000000000000000005', '2026-10-07T06:00:00.000Z', '2027-03-01');
const LEGACY = ev('5f0000000000000000000009', undefined, '2027-02-01');

const order = (list: Array<{ _id: string; eventName: string; createdAt?: string }>) =>
  [...list].sort(compareNewestCreatedFirst).map((e) => e.eventName);
const name = (e: { eventName: string }) => e.eventName;

test('newest-created first, whatever the scheduled date', async (t) => {
  await t.test('a more recently created event comes first even when it is scheduled later', () => {
    // C is scheduled latest (2028) but was created before B.
    assert.deepEqual(order([A, B, C]), [name(B), name(C), name(A)]);
  });

  await t.test('and even when it is scheduled earlier', () => {
    // B is scheduled earliest (Jan 2027) and still leads, being the newest.
    assert.deepEqual(order([C, A, B]), [name(B), name(C), name(A)]);
  });

  await t.test('older-created events follow, newest to oldest', () => {
    const sorted = [D, A, C, B].sort(compareNewestCreatedFirst);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].createdAt! >= sorted[i].createdAt!);
  });
});

test('equal creation times are ordered by _id, newest first - the same on every run', () => {
  assert.deepEqual(order([D, E]), [name(E), name(D)]);
  assert.deepEqual(order([E, D]), [name(E), name(D)], 'input order does not matter');
  assert.equal(compareNewestCreatedFirst(D, D), 0);
});

test('an event with no createdAt comes after every dated one', () => {
  assert.deepEqual(order([LEGACY, A, E]), [name(E), name(A), name(LEGACY)]);
});

test('the order runs across pages: each page continues where the previous ended', () => {
  const all = [A, B, C, D, E, LEGACY].sort(compareNewestCreatedFirst);
  const pages = [1, 2, 3].map((p) => getPaginatedData(all, p, 2).map(name));
  assert.deepEqual(pages, [[name(E), name(D)], [name(B), name(C)], [name(A), name(LEGACY)]]);
  assert.deepEqual(pages.flat(), all.map(name));
});

test('a search or filter keeps the same order among the events it leaves', () => {
  const conferences = [A, B, C, D, E].filter((e) => e.eventType === 'Conference').sort(compareNewestCreatedFirst);
  assert.deepEqual(conferences.map(name), [name(D), name(B)]);
  const full = [A, B, C, D, E].sort(compareNewestCreatedFirst).map(name);
  const kept = conferences.map(name);
  assert.deepEqual(full.filter((n) => kept.includes(n)), kept, 'a subsequence of the full order');
});

test('the Events tab uses this order by default, before paging', () => {
  const list = fs.readFileSync('frontend/src/pages/Events/EventList.tsx', 'utf-8').split('\r\n').join('\n');
  assert.ok(list.includes("const [sortField, setSortField] = useState<SortField>('createdAt');"));
  assert.ok(list.includes("const [sortDir, setSortDir] = useState<SortDir>('desc');"));
  assert.ok(list.includes("if (sortField === 'createdAt') {\n        const cmp = compareNewestCreatedFirst(a, b);"));
  // Filter, then sort, then page - never a sort of the visible page alone.
  const filterAt = list.indexOf('const filtered = events.filter(');
  const sortAt = list.indexOf('filtered.sort((a, b) => {');
  const pageAt = list.indexOf('return getPaginatedData(processedEvents, currentPage, rowsPerPage);');
  assert.ok(filterAt > 0 && filterAt < sortAt && sortAt < pageAt);
  // The scheduled date shown in the table is unchanged.
  assert.ok(list.includes('{event.eventDate} at {event.eventTime}'));
  // Column headers still sort by their column.
  assert.ok(list.includes('<SortTh field="eventDate"       label="Event Date & Time" />'));
});
