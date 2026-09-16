import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPaginatedData, getTotalPages, getSerialNumber } from './pagination.ts';

test('getTotalPages calculates correctly', () => {
  assert.equal(getTotalPages(25, 10), 3);
  assert.equal(getTotalPages(0, 10), 0);
  assert.equal(getTotalPages(10, 10), 1);
});

test('getPaginatedData slices correctly', () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(getPaginatedData(items, 1, 2), [1, 2]);
  assert.deepEqual(getPaginatedData(items, 3, 2), [5]);
  assert.deepEqual(getPaginatedData(items, 1, 10), [1, 2, 3, 4, 5]);
});

test('getSerialNumber numbers rows across pages', async (t) => {
  await t.test('page 1 starts at 1', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => getSerialNumber(1, 10, i)), [1, 2, 3, 4, 5]);
  });

  await t.test('page 2 continues from where page 1 ended', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => getSerialNumber(2, 5, i)), [6, 7, 8, 9, 10]);
  });

  await t.test('40 rows per page: page 1 is 1-40, page 2 is 41-80, page 3 is 81-120', () => {
    assert.equal(getSerialNumber(1, 40, 0), 1);
    assert.equal(getSerialNumber(1, 40, 39), 40);
    assert.equal(getSerialNumber(2, 40, 0), 41);
    assert.equal(getSerialNumber(2, 40, 39), 80);
    assert.equal(getSerialNumber(3, 40, 0), 81);
    assert.equal(getSerialNumber(3, 40, 39), 120);
  });

  await t.test('changing rows per page to 10 renumbers: page 2 starts at 11', () => {
    assert.equal(getSerialNumber(1, 10, 9), 10);
    assert.equal(getSerialNumber(2, 10, 0), 11);
    assert.equal(getSerialNumber(2, 10, 9), 20);
  });

  await t.test('a short last page still continues the sequence', () => {
    // 25 items at 10 per page: page 3 holds items 21-25.
    const lastPage = getPaginatedData(Array.from({ length: 25 }, (_, i) => i), 3, 10);
    assert.deepEqual(lastPage.map((_, i) => getSerialNumber(3, 10, i)), [21, 22, 23, 24, 25]);
  });

  await t.test('numbers follow the displayed order, not the source order', () => {
    // Filter then sort, then paginate — exactly what the client-side lists do.
    const source = [{ n: 'c' }, { n: 'a' }, { n: 'x' }, { n: 'b' }, { n: 'd' }];
    const shown = source.filter((r) => r.n !== 'x').sort((a, b) => a.n.localeCompare(b.n));
    const page2 = getPaginatedData(shown, 2, 2);
    assert.deepEqual(page2.map((r) => r.n), ['c', 'd']);
    assert.deepEqual(page2.map((_, i) => getSerialNumber(2, 2, i)), [3, 4]);
  });

  await t.test('invalid page or size degrades to page 1 rather than NaN', () => {
    assert.equal(getSerialNumber(0, 10, 0), 1);
    assert.equal(getSerialNumber(NaN, 10, 2), 3);
    assert.equal(getSerialNumber(2, 0, 0), 1);
  });
});
