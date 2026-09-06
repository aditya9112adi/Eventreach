import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatTime, formatDateTime } from '../frontend/src/utils/datetime.ts';

/**
 * Registration/approval timestamps are stored as UTC instants server-side and
 * rendered in the viewer's local timezone through these helpers.
 */
describe('date/time formatting', () => {
  const instant = new Date('2026-09-05T14:00:00.000Z');

  test('formats a date as "05 Sep 2026" style', () => {
    assert.match(formatDate(instant), /^\d{2} [A-Z][a-z]{2} \d{4}$/);
  });

  test('formats a time as "07:30 PM" style', () => {
    assert.match(formatTime(instant), /^\d{2}:\d{2} (AM|PM)$/);
  });

  test('combines both for a datetime', () => {
    assert.equal(formatDateTime(instant), `${formatDate(instant)}, ${formatTime(instant)}`);
  });

  test('accepts ISO strings as well as Date objects', () => {
    assert.equal(formatDate(instant.toISOString()), formatDate(instant));
  });

  test('falls back cleanly for missing or invalid values', () => {
    assert.equal(formatDate(undefined), 'N/A');
    assert.equal(formatDate(null), 'N/A');
    assert.equal(formatTime('not-a-date'), 'N/A');
    assert.equal(formatDateTime(''), 'N/A');
    assert.equal(formatDate(undefined, '—'), '—');
  });
});
