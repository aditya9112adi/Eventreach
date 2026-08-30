import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPaginatedData, getTotalPages } from './pagination.ts';

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
