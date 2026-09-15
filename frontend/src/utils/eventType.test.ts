import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEventType } from './eventType';

test('formatEventType capitalises the stored value for display', async (t) => {
  await t.test('capitalises an all-lowercase value', () => {
    assert.equal(formatEventType('farewell'), 'Farewell');
    assert.equal(formatEventType('party'), 'Party');
    assert.equal(formatEventType('wedding'), 'Wedding');
    assert.equal(formatEventType('birthday'), 'Birthday');
  });

  await t.test('leaves an already-correct value alone', () => {
    assert.equal(formatEventType('Farewell'), 'Farewell');
  });

  await t.test('normalises inconsistent casing', () => {
    assert.equal(formatEventType('FAREWELL'), 'Farewell');
    assert.equal(formatEventType('fArEwElL'), 'Farewell');
  });

  await t.test('trims surrounding whitespace', () => {
    assert.equal(formatEventType('  farewell  '), 'Farewell');
  });

  await t.test('capitalises only the first word', () => {
    assert.equal(formatEventType('birthday party'), 'Birthday party');
  });

  await t.test('is idempotent, so it can double as a comparison key', () => {
    const once = formatEventType('FAREWELL');
    assert.equal(formatEventType(once), once);
  });

  await t.test('collapses values that differ only in casing or padding', () => {
    const variants = ['farewell', 'Farewell', 'FAREWELL', 'fArEwElL', ' farewell '];
    const unique = new Set(variants.map(formatEventType));
    assert.deepEqual([...unique], ['Farewell']);
  });

  await t.test('returns an empty string for a missing value', () => {
    assert.equal(formatEventType(undefined), '');
    assert.equal(formatEventType(null), '');
    assert.equal(formatEventType(''), '');
    assert.equal(formatEventType('   '), '');
  });

  await t.test('does not throw on a non-string value', () => {
    assert.equal(formatEventType(42 as unknown as string), '');
  });
});
