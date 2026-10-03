/**
 * The report date range, as the three report endpoints read it.
 *
 * The rule the whole module turns on: a range is OPTIONAL, because /events,
 * /contacts and /admin/users/access-records are the ordinary list endpoints the
 * dashboard, the event list, the composer and the import screen all call. A
 * range that IS given has to make sense, and is refused with 400 otherwise.
 *
 * Run: npx tsx --test backend/tests/reportDateRange.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReportDateRange,
  dateRangeFilter,
  withinReportRange,
  ReportDateRangeError,
} from '../src/utils/reportDateRange';

const thrown = (fn: () => unknown): ReportDateRangeError => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ReportDateRangeError, `expected a ReportDateRangeError, got ${error}`);
    return error as ReportDateRangeError;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, it returned normally' });
};

test('a range the caller can be trusted with', async (t) => {
  await t.test('no dates is not an error — the shared listings still work', () => {
    const none = parseReportDateRange({});
    assert.equal(none.start, undefined);
    assert.equal(none.end, undefined);

    const blank = parseReportDateRange({ startDate: '', endDate: '   ' });
    assert.equal(blank.start, undefined, 'an empty string is no date, not a bad one');
    assert.equal(blank.end, undefined);

    // No clause at all is what leaves the shared listing untouched.
    assert.deepEqual(dateRangeFilter('eventDate', none), {});
  });

  await t.test('the start is the very beginning of its day', () => {
    const { start } = parseReportDateRange({ startDate: '2026-10-01', endDate: '2026-10-09' });
    // Midnight IST, which is the calendar day the app writes and reads.
    assert.equal(start?.toISOString(), '2026-09-30T18:30:00.000Z');
  });

  await t.test('the end is the very end of its day, so it is inclusive', () => {
    const { end } = parseReportDateRange({ startDate: '2026-10-01', endDate: '2026-10-02' });
    assert.equal(end?.toISOString(), '2026-10-02T18:29:59.999Z');
  });

  await t.test('half a range is a report request missing its other half', () => {
    // No dates is an ordinary listing; one date can only be a report.
    assert.equal(thrown(() => parseReportDateRange({ startDate: '2026-10-01' })).field, 'endDate');
    assert.equal(thrown(() => parseReportDateRange({ startDate: '2026-10-01' })).message, 'End Date is required.');
    assert.equal(thrown(() => parseReportDateRange({ endDate: '2026-10-02' })).field, 'startDate');
    assert.equal(thrown(() => parseReportDateRange({ endDate: '2026-10-02' })).message, 'Start Date is required.');
  });

  await t.test('a single-day range still spans that whole day', () => {
    const range = parseReportDateRange({ startDate: '2026-10-01', endDate: '2026-10-01' });
    assert.equal(range.start?.toISOString(), '2026-09-30T18:30:00.000Z');
    assert.equal(range.end?.toISOString(), '2026-10-01T18:29:59.999Z');
    assert.equal(
      range.end!.getTime() - range.start!.getTime(),
      24 * 60 * 60 * 1000 - 1,
      'one whole day, to the millisecond'
    );
  });

  await t.test('an end before the start is refused', () => {
    const error = thrown(() => parseReportDateRange({ startDate: '2026-10-05', endDate: '2026-10-01' }));
    assert.equal(error.message, 'End Date cannot be earlier than Start Date.');
    assert.equal(error.field, 'endDate');
  });

  await t.test('a date that is not a date is refused, naming which one', () => {
    assert.equal(thrown(() => parseReportDateRange({ startDate: 'yesterday' })).field, 'startDate');
    assert.equal(thrown(() => parseReportDateRange({ endDate: '2026-13-45' })).field, 'endDate');
    assert.match(thrown(() => parseReportDateRange({ startDate: 'x' })).message, /Start Date/);
  });
});

test('the clause each report filters with', async (t) => {
  const range = parseReportDateRange({ startDate: '2026-10-01', endDate: '2026-10-02' });

  await t.test('names the field the caller asked for', () => {
    // The three reports do not share a date: events filter on eventDate,
    // contacts on createdAt, access records on accessGrantedOn.
    assert.deepEqual(Object.keys(dateRangeFilter('eventDate', range)), ['eventDate']);
    assert.deepEqual(Object.keys(dateRangeFilter('createdAt', range)), ['createdAt']);
  });

  await t.test('is inclusive at both ends', () => {
    const clause: any = dateRangeFilter('eventDate', range);
    assert.equal(clause.eventDate.$gte.toISOString(), '2026-09-30T18:30:00.000Z');
    assert.equal(clause.eventDate.$lte.toISOString(), '2026-10-02T18:29:59.999Z');
  });

  await t.test('a report always bounds both ends', () => {
    // Half a range never reaches here: it is refused while being parsed.
    const clause: any = dateRangeFilter('createdAt', range);
    assert.deepEqual(Object.keys(clause.createdAt).sort(), ['$gte', '$lte']);
  });
});

test('the in-memory test the access report uses', async (t) => {
  const range = parseReportDateRange({ startDate: '2026-10-01', endDate: '2026-10-02' });

  await t.test('keeps a record inside the range', () => {
    assert.equal(withinReportRange('2026-10-01T06:00:00.000Z', range), true);
    assert.equal(withinReportRange('2026-10-02T06:00:00.000Z', range), true, 'the last day counts');
  });

  await t.test('a record at the very first instant of the first day is in', () => {
    assert.equal(withinReportRange('2026-09-30T18:30:00.000Z', range), true);
  });

  await t.test('a record at the very last instant of the last day is in', () => {
    assert.equal(withinReportRange('2026-10-02T18:29:59.999Z', range), true);
  });

  await t.test('a record one millisecond either side is out', () => {
    assert.equal(withinReportRange('2026-09-30T18:29:59.999Z', range), false);
    assert.equal(withinReportRange('2026-10-02T18:30:00.000Z', range), false);
  });

  await t.test('drops one well outside it', () => {
    assert.equal(withinReportRange('2026-09-29T06:00:00.000Z', range), false);
    assert.equal(withinReportRange('2026-10-04T06:00:00.000Z', range), false);
  });

  await t.test('an event stored at UTC midnight of a chosen day is still inside', () => {
    // eventDate is written as UTC midnight of the calendar day the user picked,
    // which falls at 05:30 on that same day in report time.
    assert.equal(withinReportRange('2026-10-01T00:00:00.000Z', range), true);
    assert.equal(withinReportRange('2026-10-02T00:00:00.000Z', range), true);
    assert.equal(withinReportRange('2026-10-03T00:00:00.000Z', range), false, 'the day after is out');
  });

  await t.test('a record with no date cannot satisfy a range', () => {
    assert.equal(withinReportRange(undefined, range), false);
    assert.equal(withinReportRange('', range), false);
    assert.equal(withinReportRange('not a date', range), false);
  });

  await t.test('but with no range asked for, everything passes', () => {
    assert.equal(withinReportRange(undefined, {}), true);
    assert.equal(withinReportRange('anything', {}), true);
  });
});
