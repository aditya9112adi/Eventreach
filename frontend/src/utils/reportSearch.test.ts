import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterReportRows,
  validateReportDateRange,
  filtersDiffer,
  withinRange,
  initialReportRun,
  reportRunReducer,
  hasResultsFor,
  selectingResetsReport,
  parseReportType,
  type ReportFilters,
  type ReportRunState,
} from './reportSearch';
import { getPaginatedData, getSerialNumber } from './pagination';
import { reportDayStart, reportDayEnd } from '@eventreach/shared';

const NO_FILTER: ReportFilters = { mode: 'EventName', searchValue: '', startDate: '', endDate: '' };

const accessors = {
  text: (r: any) => `${r.eventId} ${r.eventName}`,
  status: (r: any) => r.eventStatus,
  date: (r: any) => r.eventDate,
};

const ROWS = [
  { _id: '1', eventId: 'EVT-000001', eventName: 'Anniversary', eventStatus: 'Upcoming', eventDate: '2026-10-10' },
  { _id: '2', eventId: 'EVT-000006', eventName: 'Valentines', eventStatus: 'Upcoming', eventDate: '2026-10-02' },
  { _id: '3', eventId: 'EVT-000003', eventName: 'Farewell', eventStatus: 'Completed', eventDate: '2026-08-15' },
];

// ── filtering ────────────────────────────────────────────────────────────────

test('filterReportRows applies the report filters', async (t) => {
  await t.test('an empty text filter returns every row (an explicit "all" search)', () => {
    assert.equal(filterReportRows(ROWS, accessors, NO_FILTER, false).length, 3);
  });

  await t.test('Name / ID matches the name, case-insensitively', () => {
    const out = filterReportRows(ROWS, accessors, { ...NO_FILTER, searchValue: 'valen' }, false);
    assert.deepEqual(out.map((r) => r._id), ['2']);
  });

  await t.test('the text filter also matches the Event ID', () => {
    const out = filterReportRows(ROWS, accessors, { ...NO_FILTER, mode: 'EventID', searchValue: 'evt-000006' }, false);
    assert.deepEqual(out.map((r) => r._id), ['2']);
  });

  await t.test('Status matches the status, not the name', () => {
    const out = filterReportRows(ROWS, accessors, { ...NO_FILTER, mode: 'Status', searchValue: 'completed' }, false);
    assert.deepEqual(out.map((r) => r._id), ['3']);
  });

  await t.test('surrounding whitespace in the search value is ignored', () => {
    const out = filterReportRows(ROWS, accessors, { ...NO_FILTER, searchValue: '  farewell ' }, false);
    assert.deepEqual(out.map((r) => r._id), ['3']);
  });

  await t.test('Date mode filters on the date range and ignores the text box', () => {
    const f = { mode: 'Date', searchValue: 'ignored', startDate: '2026-10-01', endDate: '2026-10-31' };
    assert.deepEqual(filterReportRows(ROWS, accessors, f, true).map((r) => r._id).sort(), ['1', '2']);
  });

  await t.test('a range is inclusive of both end days', () => {
    const f = { mode: 'Date', searchValue: '', startDate: '2026-10-02', endDate: '2026-10-10' };
    assert.deepEqual(filterReportRows(ROWS, accessors, f, true).map((r) => r._id).sort(), ['1', '2']);
  });

  await t.test('no matches gives an empty result, not the full list', () => {
    assert.equal(filterReportRows(ROWS, accessors, { ...NO_FILTER, searchValue: 'zzz' }, false).length, 0);
  });
});

test('withinRange', async (t) => {
  await t.test('open-ended ranges', () => {
    assert.equal(withinRange('2026-10-10', '2026-10-01', ''), true);
    assert.equal(withinRange('2026-09-10', '2026-10-01', ''), false);
    assert.equal(withinRange('2026-10-10', '', '2026-10-09'), false);
  });
  await t.test('a row with no date never matches a range', () => {
    assert.equal(withinRange(undefined, '2026-10-01', ''), false);
    assert.equal(withinRange('not a date', '2026-10-01', ''), false);
  });
});

test('filtersDiffer detects edits made after generating a report', () => {
  assert.equal(filtersDiffer(null, NO_FILTER), true, 'nothing generated yet');
  assert.equal(filtersDiffer(NO_FILTER, { ...NO_FILTER }), false);
  assert.equal(filtersDiffer(NO_FILTER, { ...NO_FILTER, searchValue: 'x' }), true);
  assert.equal(filtersDiffer(NO_FILTER, { ...NO_FILTER, mode: 'Status' }), true);
  assert.equal(filtersDiffer(NO_FILTER, { ...NO_FILTER, endDate: '2026-10-01' }), true);
});

// ── run state ────────────────────────────────────────────────────────────────

const start = (s: ReportRunState, reportKey: any, requestId: number, filters = NO_FILTER) =>
  reportRunReducer(s, { type: 'start', reportKey, requestId, filters });

test('report run lifecycle', async (t) => {
  await t.test('initial state has no results and no applied filters', () => {
    const s = initialReportRun('event');
    assert.equal(s.status, 'idle');
    assert.equal(s.applied, null);
    assert.equal(hasResultsFor(s, 'event'), false, 'nothing is shown before a search');
  });

  await t.test('search -> loading -> results, with the filters captured', () => {
    const f = { ...NO_FILTER, searchValue: 'EVT-000006' };
    let s = start(initialReportRun('event'), 'event', 1, f);
    assert.equal(s.status, 'loading');
    assert.equal(hasResultsFor(s, 'event'), false);
    assert.deepEqual(s.applied, f);

    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS });
    assert.equal(s.status, 'success');
    assert.equal(s.rows.length, 3);
    assert.deepEqual(s.applied, f, 'download uses the filters the report was generated with');
    assert.equal(hasResultsFor(s, 'event'), true);
  });

  await t.test('a successful search with zero rows is a success, not an error', () => {
    let s = start(initialReportRun('contact'), 'contact', 1);
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: [] });
    assert.equal(s.status, 'success');
    assert.equal(s.rows.length, 0);
  });

  await t.test('a failed search records the server error and no rows', () => {
    let s = start(initialReportRun('access'), 'access', 1);
    s = reportRunReducer(s, { type: 'failure', requestId: 1, error: 'Forbidden: Insufficient permissions' });
    assert.equal(s.status, 'error');
    assert.equal(s.error, 'Forbidden: Insufficient permissions');
    assert.equal(hasResultsFor(s, 'access'), false);
  });

  await t.test('a new search clears the previous rows while loading', () => {
    let s = start(initialReportRun('event'), 'event', 1);
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS });
    s = start(s, 'event', 2, { ...NO_FILTER, searchValue: 'x' });
    assert.equal(s.rows.length, 0);
    assert.equal(s.status, 'loading');
  });
});

test('stale responses are ignored', async (t) => {
  await t.test('an older search cannot overwrite a newer one', () => {
    let s = start(initialReportRun('event'), 'event', 1);
    s = start(s, 'event', 2);
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS }); // late reply to #1
    assert.equal(s.status, 'loading', 'still waiting for #2');
    s = reportRunReducer(s, { type: 'success', requestId: 2, rows: [ROWS[0]] });
    assert.equal(s.rows.length, 1);
  });

  await t.test('switching tabs mid-request: the old report never appears under the new tab', () => {
    let s = start(initialReportRun('event'), 'event', 1);
    s = reportRunReducer(s, { type: 'reset', reportKey: 'contact', requestId: 2 }); // user switched tab
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS }); // event rows arrive late
    assert.equal(s.reportKey, 'contact');
    assert.equal(s.status, 'idle');
    assert.equal(s.rows.length, 0);
    assert.equal(hasResultsFor(s, 'contact'), false);
    assert.equal(hasResultsFor(s, 'event'), false);
  });

  await t.test('a late failure after Clear is ignored too', () => {
    let s = start(initialReportRun('access'), 'access', 1);
    s = reportRunReducer(s, { type: 'reset', reportKey: 'access', requestId: 2 });
    s = reportRunReducer(s, { type: 'failure', requestId: 1, error: 'boom' });
    assert.equal(s.status, 'idle');
    assert.equal(s.error, null);
  });

  await t.test('a duplicate success for an already-finished request changes nothing', () => {
    let s = start(initialReportRun('event'), 'event', 1);
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS });
    const again = reportRunReducer(s, { type: 'success', requestId: 1, rows: [] });
    assert.equal(again.rows.length, 3);
  });
});

test('tab switching and Clear', async (t) => {
  await t.test('results for one report are never reported for another', () => {
    let s = start(initialReportRun('event'), 'event', 1);
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS });
    assert.equal(hasResultsFor(s, 'event'), true);
    assert.equal(hasResultsFor(s, 'contact'), false, 'event rows must not show on the contact tab');
  });

  await t.test('switching tabs returns to the initial "no report" state', () => {
    let s = start(initialReportRun('event'), 'event', 1);
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS });
    s = reportRunReducer(s, { type: 'reset', reportKey: 'access', requestId: 2 });
    assert.equal(s.status, 'idle');
    assert.equal(s.applied, null);
    assert.equal(s.rows.length, 0);
  });

  await t.test('Clear removes generated results and does not start a new search', () => {
    let s = start(initialReportRun('contact'), 'contact', 1);
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS });
    s = reportRunReducer(s, { type: 'reset', reportKey: 'contact', requestId: 2 });
    assert.equal(s.status, 'idle', 'idle, not loading');
    assert.equal(hasResultsFor(s, 'contact'), false);
  });
});

test('generated results paginate with correct serial numbers', () => {
  const many = Array.from({ length: 95 }, (_, i) => ({ ...ROWS[0], _id: String(i) }));
  const matched = filterReportRows(many, accessors, NO_FILTER, false);
  const page3 = getPaginatedData(matched, 3, 40);
  assert.equal(page3.length, 15);
  assert.equal(getSerialNumber(3, 40, 0), 81);
  assert.equal(getSerialNumber(3, 40, page3.length - 1), 95);
});

test('report type selection', async (t) => {
  await t.test('nothing is chosen when Reports first opens, so the first choice starts fresh', () => {
    assert.equal(selectingResetsReport({ chosen: false, reportKey: 'event' }, 'event'), true);
    assert.equal(selectingResetsReport({ chosen: false, reportKey: 'event' }, 'access'), true);
  });

  await t.test('switching to a different report type starts it from its filter-only state', () => {
    assert.equal(selectingResetsReport({ chosen: true, reportKey: 'event' }, 'contact'), true);
    assert.equal(selectingResetsReport({ chosen: true, reportKey: 'contact' }, 'access'), true);
    assert.equal(selectingResetsReport({ chosen: true, reportKey: 'access' }, 'event'), true);
  });

  await t.test('choosing the already-selected type keeps its generated report', () => {
    for (const key of ['event', 'access', 'contact'] as const) {
      assert.equal(selectingResetsReport({ chosen: true, reportKey: key }, key), false);
    }
  });

  await t.test('switching away and back does not resurrect the old results', () => {
    let s = reportRunReducer(initialReportRun('event'), { type: 'start', reportKey: 'event', requestId: 1, filters: NO_FILTER });
    s = reportRunReducer(s, { type: 'success', requestId: 1, rows: ROWS });
    s = reportRunReducer(s, { type: 'reset', reportKey: 'contact', requestId: 2 }); // event -> contact
    s = reportRunReducer(s, { type: 'reset', reportKey: 'event', requestId: 3 }); // contact -> event
    assert.equal(hasResultsFor(s, 'event'), false, 'back on event, but a new search is required');
    assert.equal(s.rows.length, 0);
  });
});

test('parseReportType reads the sidebar ?type= parameter', async (t) => {
  await t.test('recognises the three report types', () => {
    assert.equal(parseReportType('event', true), 'event');
    assert.equal(parseReportType('access', true), 'access');
    assert.equal(parseReportType('contact', true), 'contact');
  });

  await t.test('no parameter means no report type chosen', () => {
    assert.equal(parseReportType(null, true), null);
    assert.equal(parseReportType('', true), null);
  });

  await t.test('an unknown or differently-cased value is not a report type', () => {
    for (const v of ['events', 'EVENT', 'Access', 'report', 'undefined', '<script>']) {
      assert.equal(parseReportType(v, true), null, v);
    }
  });

  await t.test('the Access Report is refused for roles that cannot see it', () => {
    assert.equal(parseReportType('access', false), null);
    assert.equal(parseReportType('event', false), 'event');
    assert.equal(parseReportType('contact', false), 'contact');
  });
});


/**
 * Start Date and End Date are required for every report.
 *
 * A report that does not state the period it covers cannot be checked by
 * whoever receives it, and an absent date used to be printed in its own header
 * as "-". The rules live in one place so all four reports enforce the same
 * ones.
 */
test('the required date range', async (t) => {
  await t.test('neither date given names both', () => {
    assert.equal(validateReportDateRange('', ''), 'Start Date and End Date are required.');
  });

  await t.test('a missing Start Date is identified on its own', () => {
    assert.equal(validateReportDateRange('', '2026-10-02'), 'Start Date is required.');
  });

  await t.test('a missing End Date is identified on its own', () => {
    assert.equal(validateReportDateRange('2026-10-01', ''), 'End Date is required.');
  });

  await t.test('whitespace is not a date', () => {
    assert.equal(validateReportDateRange('   ', '   '), 'Start Date and End Date are required.');
  });

  await t.test('an end before the start is refused', () => {
    assert.equal(
      validateReportDateRange('2026-10-05', '2026-10-01'),
      'End Date cannot be earlier than Start Date.'
    );
  });

  await t.test('a single-day range is allowed', () => {
    assert.equal(validateReportDateRange('2026-10-01', '2026-10-01'), null);
  });

  await t.test('a valid range passes', () => {
    assert.equal(validateReportDateRange('2026-10-01', '2026-10-02'), null);
  });
});

test('the range applies whichever filter is selected', async (t) => {
  const accessors = {
    text: (r: any) => String(r.name),
    status: (r: any) => String(r.status),
    date: (r: any) => r.when,
  };
  const rows = [
    { name: 'College Party', status: 'Upcoming', when: '2026-10-01T10:00:00.000Z' },
    { name: 'College Reunion', status: 'Upcoming', when: '2026-11-20T10:00:00.000Z' },
  ];

  await t.test('a text search no longer returns rows outside the dates', () => {
    // This is the case that used to leak: in a name search the range was
    // ignored, so the report printed dates it had not filtered on.
    const kept = filterReportRows(
      rows,
      accessors,
      { mode: 'EventName', searchValue: 'College', startDate: '2026-10-01', endDate: '2026-10-02' },
      false
    );
    assert.deepEqual(kept.map((r: any) => r.name), ['College Party']);
  });

  await t.test('a Status search is bounded by the range too', () => {
    const kept = filterReportRows(
      rows,
      accessors,
      { mode: 'Status', searchValue: 'Upcoming', startDate: '2026-10-01', endDate: '2026-10-02' },
      false
    );
    assert.equal(kept.length, 1);
  });

  await t.test('the date mode is unchanged', () => {
    const kept = filterReportRows(
      rows,
      accessors,
      { mode: 'Date', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-02' },
      true
    );
    assert.deepEqual(kept.map((r: any) => r.name), ['College Party']);
  });

  await t.test('with no range set every row is still returned', () => {
    const kept = filterReportRows(
      rows,
      accessors,
      { mode: 'EventName', searchValue: '', startDate: '', endDate: '' },
      false
    );
    assert.equal(kept.length, 2, 'a dateless call behaves as it always did');
  });
});


/**
 * Calendar-day boundaries, and the page agreeing with the API about them.
 *
 * Both sides resolve a Start/End Date through the shared report-day helpers,
 * so the same two dates have to include the same records wherever the question
 * is asked. These cases pin the edges in UTC instants, which is what the
 * database actually stores.
 */
test('report date boundaries', async (t) => {
  const accessors = {
    text: (r: any) => String(r.name),
    status: () => '',
    date: (r: any) => r.when,
  };
  const inRange = (when: string, startDate: string, endDate: string) =>
    filterReportRows(
      [{ name: 'row', when }],
      accessors,
      { mode: 'Date', searchValue: '', startDate, endDate },
      true
    ).length === 1;

  await t.test('a record at the very first instant of the range is included', () => {
    // 2026-10-01 00:00 IST.
    assert.equal(inRange('2026-09-30T18:30:00.000Z', '2026-10-01', '2026-10-02'), true);
  });

  await t.test('a record at the very last instant of the range is included', () => {
    // 2026-10-02 23:59:59.999 IST.
    assert.equal(inRange('2026-10-02T18:29:59.999Z', '2026-10-01', '2026-10-02'), true);
  });

  await t.test('a record one millisecond outside either edge is excluded', () => {
    assert.equal(inRange('2026-09-30T18:29:59.999Z', '2026-10-01', '2026-10-02'), false);
    assert.equal(inRange('2026-10-02T18:30:00.000Z', '2026-10-01', '2026-10-02'), false);
  });

  await t.test('an event stored at UTC midnight falls on the day it was picked', () => {
    // eventDate is written as UTC midnight of the chosen calendar day.
    assert.equal(inRange('2026-10-01T00:00:00.000Z', '2026-10-01', '2026-10-01'), true);
    assert.equal(inRange('2026-10-02T00:00:00.000Z', '2026-10-01', '2026-10-01'), false);
  });

  await t.test('a late-evening record stays on its own calendar day', () => {
    // 23:00 IST on 2 Oct is 17:30Z the same day — it must not fall into 3 Oct,
    // which is what a UTC-based reading of the range did.
    assert.equal(inRange('2026-10-02T17:30:00.000Z', '2026-10-01', '2026-10-02'), true);
    assert.equal(inRange('2026-10-02T17:30:00.000Z', '2026-10-03', '2026-10-03'), false);
  });

  await t.test('the page and the API bound the same range identically', () => {
    // The shared helpers are the single definition both sides call, so this is
    // the contract rather than two implementations that happen to agree.
    assert.equal(reportDayStart('2026-10-01').toISOString(), '2026-09-30T18:30:00.000Z');
    assert.equal(reportDayEnd('2026-10-02').toISOString(), '2026-10-02T18:29:59.999Z');
  });
});
