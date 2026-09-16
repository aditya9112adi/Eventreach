import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterReportRows,
  filtersDiffer,
  withinRange,
  initialReportRun,
  reportRunReducer,
  hasResultsFor,
  selectingResetsReport,
  type ReportFilters,
  type ReportRunState,
} from './reportSearch';
import { getPaginatedData, getSerialNumber } from './pagination';

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
