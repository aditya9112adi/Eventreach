import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatTime, formatDateTime, formatChatTime } from '../frontend/src/utils/datetime.ts';

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

/**
 * The WhatsApp message preview stamps its bubble with this. It used to be the
 * hardcoded string "12:00 PM"; these pin the real behaviour.
 */
describe('formatChatTime (message preview bubble)', () => {
  /** Builds a Date at a given LOCAL wall-clock time, whatever the test machine's timezone. */
  const localAt = (hours: number, minutes: number) => new Date(2026, 8, 14, hours, minutes, 0, 0);

  test('renders 12-hour time with AM/PM and no leading zero on the hour', () => {
    assert.equal(formatChatTime(localAt(15, 27)), '3:27 PM');
    assert.equal(formatChatTime(localAt(9, 5)), '9:05 AM');
  });

  test('keeps the leading zero on minutes', () => {
    assert.equal(formatChatTime(localAt(13, 0)), '1:00 PM');
  });

  test('handles both noon and midnight as 12, not 0', () => {
    assert.equal(formatChatTime(localAt(12, 30)), '12:30 PM');
    assert.equal(formatChatTime(localAt(0, 30)), '12:30 AM');
  });

  test('defaults to the current time, in the local timezone', () => {
    const now = new Date();
    assert.equal(formatChatTime(), formatChatTime(now));
    assert.match(formatChatTime(), /^\d{1,2}:\d{2} (AM|PM)$/);
  });

  test('is never the old hardcoded placeholder unless it genuinely is noon', () => {
    // Guards against a regression back to a constant: the value must track
    // the input rather than being fixed.
    const values = new Set([
      formatChatTime(localAt(8, 15)),
      formatChatTime(localAt(16, 45)),
      formatChatTime(localAt(23, 59)),
    ]);
    assert.equal(values.size, 3, 'each distinct instant must render distinctly');
    assert.ok(!values.has('12:00 PM'));
  });

  test('falls back to an empty string for an invalid value, not a fake time', () => {
    assert.equal(formatChatTime('not-a-date'), '');
    assert.equal(formatChatTime('not-a-date', '—'), '—');
  });
});
