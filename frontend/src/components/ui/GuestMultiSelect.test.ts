import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { filterGuests, selectAllGuests, toggleGuest } from '../../utils/templateTest';

/**
 * The picker's behaviour lives in the pure helpers below, which are tested for
 * real. The source assertions after them cover the parts that only exist in the
 * markup — the checkbox per row, the search row, and the fact that choosing a
 * guest does not close the dropdown — which this repo has no DOM test runner to
 * exercise directly.
 */

const GUESTS = [
  { _id: 'c1', fullName: 'Shubham Suryavanshi', phoneNumber: '+918530808862' },
  { _id: 'c2', fullName: 'Aditya Shankar Kshirsagar', phoneNumber: '+919112472833' },
  { _id: 'c3', fullName: 'Riya Patil', phoneNumber: '+919812345678' },
];

test('selecting guests', async (t) => {
  await t.test('a second guest joins the first instead of replacing it', () => {
    const first = toggleGuest([], 'c1');
    assert.deepEqual(first, ['c1']);
    const second = toggleGuest(first, 'c2');
    assert.deepEqual(second.sort(), ['c1', 'c2']);
  });

  await t.test('ten guests can be selected', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `g${i}`);
    const selected = ids.reduce<string[]>((acc, id) => toggleGuest(acc, id), []);
    assert.equal(selected.length, 10);
  });

  await t.test('choosing a selected guest deselects that one only', () => {
    const selected = toggleGuest(toggleGuest(toggleGuest([], 'c1'), 'c2'), 'c3');
    const after = toggleGuest(selected, 'c2');
    assert.deepEqual(after.sort(), ['c1', 'c3']);
  });

  await t.test('the same guest can never appear twice', () => {
    const selected = toggleGuest(toggleGuest(['c1'], 'c1'), 'c1');
    assert.deepEqual(selected, ['c1']);
    assert.equal(new Set(selected).size, selected.length);
  });

  await t.test('Select All selects every listed guest', () => {
    assert.deepEqual(selectAllGuests([], GUESTS).sort(), ['c1', 'c2', 'c3']);
  });

  await t.test('Select All keeps guests the search is currently hiding', () => {
    const visible = filterGuests(GUESTS, 'riya');
    assert.deepEqual(visible.map((g) => g._id), ['c3']);
    assert.deepEqual(selectAllGuests(['c1'], visible).sort(), ['c1', 'c3']);
  });

  await t.test('Select All twice is not two copies', () => {
    const once = selectAllGuests([], GUESTS);
    assert.deepEqual(selectAllGuests(once, GUESTS).sort(), once.sort());
  });

  await t.test('searching does not change the selection', () => {
    const selected = selectAllGuests([], GUESTS);
    filterGuests(GUESTS, 'nothing matches this');
    assert.equal(selected.length, 3);
  });
});

test('GuestMultiSelect markup', () => {
  const source = fs.readFileSync('frontend/src/components/ui/GuestMultiSelect.tsx', 'utf-8');

  assert.ok(source.includes('type="checkbox"'), 'each guest row must carry a checkbox');
  assert.ok(source.includes('Search guests...'), 'the dropdown must have a search input');
  assert.ok(source.includes('Select All') && source.includes('Clear All'), 'Select All / Clear All must be present');
  assert.ok(source.includes('guestSelectionLabel(value.length)'), 'the trigger must show the count, not the names');

  // Choosing a guest must not close the list: the toggle handler only reports
  // the new selection upward.
  const toggleLine = source.split('\n').find((line) => line.includes('const toggle ='));
  assert.ok(toggleLine, 'toggle handler not found');
  assert.ok(!toggleLine!.includes('setIsOpen'), 'toggling a guest must not close the dropdown');

  // Closing happens on an outside click and on Escape.
  assert.ok(source.includes('handleClickOutside'), 'clicking outside must close the dropdown');
  assert.ok(source.includes("event.key === 'Escape'"), 'Escape must close the dropdown');

  // Accessibility: a labelled group of real checkboxes, each named by the
  // <label> that wraps it. role="option" on that label would suppress its
  // labelling semantics and leave every checkbox nameless.
  assert.ok(source.includes('role="group"'), 'the guest list must be a labelled group');
  assert.ok(!source.includes('role="option"'), 'a wrapping <label> must not also be an option');
  assert.ok(source.includes('aria-expanded={isOpen}'), 'the trigger must expose its expanded state');
  assert.ok(source.includes("aria-label=\"Search guests\""), 'the search input must be labelled');
  assert.ok(source.includes('aria-label="Guests"'), 'the group must be labelled');
});

test('Composer sends every selected guest through the backend', () => {
  const source = fs.readFileSync('frontend/src/pages/Campaigns/Composer.tsx', 'utf-8');

  assert.ok(source.includes('contactIds: selectedContactIds'), 'the send must post the selected guest ids');
  assert.ok(source.includes("api.post('/whatsapp/event-template'"), 'sending must go through the EventReach backend');
  assert.ok(!source.includes('graph.facebook.com'), 'the frontend must never call Meta directly');

  // Changing the event clears the guests before the new list is loaded.
  const effect = source.slice(source.indexOf('const fetchContacts'));
  assert.ok(
    source.includes('setSelectedContactIds([]);'),
    'changing the event must clear the previous selection'
  );
  assert.ok(effect.includes('/contacts/event/'), 'guests are loaded for the selected event');
});
