import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPageSelectionState,
  toggleSelectAllOnPage,
  toggleSelection,
  pruneSelection,
} from './selection';

const PAGE = ['a', 'b', 'c'];

test('header checkbox state', async (t) => {
  await t.test('unchecked and not indeterminate when nothing is selected', () => {
    const s = getPageSelectionState(new Set(), PAGE);
    assert.equal(s.allSelected, false);
    assert.equal(s.someSelected, false);
    assert.deepEqual(s.selectedOnPage, []);
  });

  await t.test('indeterminate when only some rows are selected', () => {
    const s = getPageSelectionState(new Set(['b']), PAGE);
    assert.equal(s.allSelected, false);
    assert.equal(s.someSelected, true);
    assert.deepEqual(s.selectedOnPage, ['b']);
  });

  await t.test('checked and not indeterminate when every row is selected', () => {
    const s = getPageSelectionState(new Set(PAGE), PAGE);
    assert.equal(s.allSelected, true);
    assert.equal(s.someSelected, false);
  });

  await t.test('an empty page is never "all selected"', () => {
    const s = getPageSelectionState(new Set(), []);
    assert.equal(s.allSelected, false);
    assert.equal(s.someSelected, false);
  });

  await t.test('ids selected off-page do not make the page look selected', () => {
    const s = getPageSelectionState(new Set(['x', 'y']), PAGE);
    assert.equal(s.allSelected, false);
    assert.equal(s.someSelected, false);
  });
});

test('select all on page', async (t) => {
  await t.test('selects every row on the page', () => {
    const next = toggleSelectAllOnPage(new Set(), PAGE);
    assert.deepEqual([...next].sort(), ['a', 'b', 'c']);
  });

  await t.test('clicking again clears them', () => {
    const all = toggleSelectAllOnPage(new Set(), PAGE);
    const cleared = toggleSelectAllOnPage(all, PAGE);
    assert.equal(cleared.size, 0);
  });

  await t.test('promotes a partial selection to all, rather than clearing', () => {
    const next = toggleSelectAllOnPage(new Set(['b']), PAGE);
    assert.deepEqual([...next].sort(), ['a', 'b', 'c']);
  });

  await t.test('only touches ids on the current page', () => {
    const next = toggleSelectAllOnPage(new Set(['other']), PAGE);
    assert.deepEqual([...next].sort(), ['a', 'b', 'c', 'other']);
    const back = toggleSelectAllOnPage(next, PAGE);
    assert.deepEqual([...back], ['other'], 'deselecting the page leaves off-page ids alone');
  });

  await t.test('does not invent a selection on an empty page', () => {
    assert.equal(toggleSelectAllOnPage(new Set(), []).size, 0);
  });

  await t.test('does not mutate the set it was given', () => {
    const original = new Set(['a']);
    toggleSelectAllOnPage(original, PAGE);
    assert.deepEqual([...original], ['a']);
  });
});

test('row checkbox', async (t) => {
  await t.test('selects then deselects', () => {
    const on = toggleSelection(new Set(), 'a');
    assert.equal(on.has('a'), true);
    assert.equal(toggleSelection(on, 'a').has('a'), false);
  });

  await t.test('leaves other ids untouched', () => {
    const next = toggleSelection(new Set(['a', 'b']), 'b');
    assert.deepEqual([...next], ['a']);
  });

  await t.test('does not mutate the set it was given', () => {
    const original = new Set(['a']);
    toggleSelection(original, 'b');
    assert.deepEqual([...original], ['a']);
  });
});

test('pruneSelection drops ids that no longer exist', async (t) => {
  await t.test('removes deleted ids after a refetch', () => {
    const next = pruneSelection(new Set(['a', 'b', 'c']), ['a', 'c']);
    assert.deepEqual([...next].sort(), ['a', 'c']);
  });

  await t.test('returns empty when everything is gone', () => {
    assert.equal(pruneSelection(new Set(['a']), []).size, 0);
  });
});
