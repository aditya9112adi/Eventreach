/**
 * The Contact Report's Name, Status and Date filters decide which event rows
 * it lists - all three together, as on the Access Report.
 *
 * The bugs: the filter bar offered Name, Status and Date as one choice, so
 * Name and Status could never combine, choosing Date (to set the required
 * period) switched the name search off while still showing it, and Status was
 * a "contains" search in which "Valid" also matched "Invalid". Now the name is
 * the search box, Status is a dropdown matched exactly, the period always
 * applies, and the server applies all of them (see
 * tests/accessContactReports.integration.test.ts).
 *
 * Run: npx tsx --test frontend/src/utils/contactReportFilters.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  filterReportRows,
  matchesStatusWord,
  filtersDiffer,
  reportFilterParams,
  reportRunReducer,
  initialReportRun,
  type ReportFilters,
} from './reportSearch.ts';
import { groupRecordsByEvent, contactRecordEventIds } from './reportEventGroups.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const reports = read('frontend/src/pages/Reports.tsx');
const view = read('frontend/src/components/ui/ReportEventView.tsx');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

const value = (x: unknown, fallback = '') => (x === null || x === undefined || x === '' ? fallback : String(x));

/** The Contact Report's accessors, as Reports.tsx declares them (checked below). */
const CONTACT = {
  text: (row: any) => `${value(row.fullName)} ${value(row.phoneNumber)} ${value(row.email)}`,
  status: (row: any) => value(row.status, '-'),
  date: (row: any) => row.createdAt,
};

const COLLEGE = { _id: 'evtC', eventId: 'EVT-000021', eventName: 'College Event' };
const BETA = { _id: 'evtB', eventId: 'EVT-000022', eventName: 'Beta Conference' };
const GALA = { _id: 'evtG', eventId: 'EVT-000001', eventName: 'In Range Gala' };
const EVENTS = [GALA, BETA, COLLEGE];

/** The contacts the server returns for the report's period (its dates already applied). */
const CONTACTS = [
  { _id: 'c1', fullName: 'College Guest One', phoneNumber: '+919700000001', email: 'one@verify.test', status: 'Valid', eventId: 'evtC', createdAt: '2026-10-03T06:00:00.000Z' },
  { _id: 'c2', fullName: 'College Guest Two', phoneNumber: '+919700000002', email: 'two@verify.test', status: 'Invalid', eventId: 'evtC', createdAt: '2026-10-03T06:00:00.000Z' },
  { _id: 'c3', fullName: 'Beta Guest', phoneNumber: '+919700000003', email: 'beta@verify.test', status: 'Valid', eventId: 'evtB', createdAt: '2026-10-03T06:00:00.000Z' },
  { _id: 'c4', fullName: 'Beta Guest Two', phoneNumber: '+919700000004', email: 'beta2@verify.test', status: 'Duplicate', eventId: 'evtB', createdAt: '2026-10-03T06:00:00.000Z' },
  { _id: 'c5', fullName: 'Gala Invalid Guest', phoneNumber: '+919700000005', email: 'gala@verify.test', status: 'Invalid', eventId: 'evtG', createdAt: '2026-10-20T06:00:00.000Z' },
];

const filters = (over: Partial<ReportFilters> = {}): ReportFilters => ({
  mode: 'Name', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '', status: '', ...over,
});

/** The rows the Contact Report lists for these generated filters. */
const rowsFor = (applied: ReportFilters) => {
  const records = filterReportRows(CONTACTS, CONTACT, applied, false);
  return {
    records: records.map((r) => r.fullName),
    rows: groupRecordsByEvent(records, contactRecordEventIds, EVENTS).map((r) => `${r.eventId} | ${r.recordCount}`),
  };
};

// ─── the Contact Report's filter bar ─────────────────────────────────────────

test('the Contact filter bar: a Name box and a Status dropdown, no single choice', async (t) => {
  const contactBlock = between(reports, "key: 'contact'", 'const Reports = () =>');

  await t.test('one text field (the name) and the three contact statuses', () => {
    assert.ok(contactBlock.includes("options: [{ key: 'Name', label: 'Name', type: 'text' }],"));
    assert.ok(contactBlock.includes('statusChoices: CONTACT_STATUSES,'));
    assert.ok(reports.includes("const CONTACT_STATUSES = ['Valid', 'Invalid', 'Duplicate'] as const;"));
    assert.equal(contactBlock.includes("key: 'Date'"), false, 'no Date choice to switch the name search off');
    assert.equal(contactBlock.includes("key: 'Status'"), false, 'Status is the dropdown, not a choice of the search box');
  });

  await t.test('the fixture mirrors the real Contact definition', () => {
    assert.ok(contactBlock.includes('text: (row) => `${value(row.fullName)} ${value(row.phoneNumber)} ${value(row.email)}`'));
    assert.ok(contactBlock.includes("status: (row) => value(row.status, '-'),"));
    assert.ok(contactBlock.includes('date: (row) => row.createdAt,'));
  });

  await t.test('Search sends the name and the status to the server', () => {
    assert.deepEqual(reportFilterParams('contact', filters({ searchValue: '  beta ', status: 'Valid' })), { name: 'beta', status: 'Valid' });
    assert.deepEqual(reportFilterParams('contact', filters()), {}, 'empty filters are not sent');
    assert.deepEqual(reportFilterParams('access', filters({ searchValue: 'x' })), { username: 'x' }, 'the Access Report sends a username');
    assert.deepEqual(reportFilterParams('event', filters({ searchValue: 'x', status: 'Valid' })), {}, 'the Event Report sends neither');
  });
});

// ─── the filters ─────────────────────────────────────────────────────────────

test('Contact Name filter lists only the events of matching contacts', async (t) => {
  await t.test('one contact\'s name: only that contact\'s event', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'College Guest One' })), { records: ['College Guest One'], rows: ['EVT-000021 | 1'] });
  });

  await t.test('a name shared by contacts of two events: both events, with their own counts', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'guest two' })).rows, ['EVT-000022 | 1', 'EVT-000021 | 1']);
  });

  await t.test('the name searches name, phone and email - as it always has', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: '+919700000003' })).rows, ['EVT-000022 | 1']);
    assert.deepEqual(rowsFor(filters({ searchValue: 'beta2@verify' })).rows, ['EVT-000022 | 1']);
  });

  await t.test('no matching name: no rows', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'nobody' })).rows, []);
  });
});

test('Contact Status filter lists only the events of matching contacts', async (t) => {
  await t.test('Valid keeps valid contacts only - never the invalid ones', () => {
    const { records, rows } = rowsFor(filters({ status: 'Valid' }));
    assert.deepEqual(records, ['College Guest One', 'Beta Guest']);
    assert.deepEqual(rows, ['EVT-000022 | 1', 'EVT-000021 | 1']);
  });

  await t.test('Invalid keeps invalid contacts only', () => {
    assert.deepEqual(rowsFor(filters({ status: 'Invalid' })).rows, ['EVT-000001 | 1', 'EVT-000021 | 1']);
  });

  await t.test('Duplicate keeps duplicates only', () => {
    assert.deepEqual(rowsFor(filters({ status: 'Duplicate' })).rows, ['EVT-000022 | 1']);
  });
});

test('Contact Date filter keeps working', () => {
  assert.deepEqual(rowsFor(filters({ startDate: '2026-10-01', endDate: '2026-10-10' })).rows, ['EVT-000022 | 2', 'EVT-000021 | 2']);
  assert.deepEqual(rowsFor(filters({ startDate: '2026-10-15', endDate: '2026-10-31' })).rows, ['EVT-000001 | 1']);
});

test('Name, Status and dates combine', async (t) => {
  await t.test('Name + Status', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'guest', status: 'Invalid' })).records, ['College Guest Two', 'Gala Invalid Guest']);
    assert.deepEqual(rowsFor(filters({ searchValue: 'beta', status: 'Valid' })).records, ['Beta Guest']);
  });

  await t.test('Name + Status + dates', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'guest', status: 'Invalid', startDate: '2026-10-01', endDate: '2026-10-10' })).rows, ['EVT-000021 | 1']);
    assert.deepEqual(rowsFor(filters({ searchValue: 'gala', status: 'Invalid', startDate: '2026-10-01', endDate: '2026-10-10' })).rows, []);
  });

  await t.test('Name + Status + dates + the selected event (the server keeps only that event\'s contacts)', () => {
    const scoped = CONTACTS.filter((c) => c.eventId === 'evtC');
    const applied = filters({ searchValue: 'college', status: 'Valid', eventId: 'evtC' });
    const rows = groupRecordsByEvent(filterReportRows(scoped, CONTACT, applied, false), contactRecordEventIds, EVENTS);
    assert.deepEqual(rows.map((r) => `${r.eventId} | ${r.recordCount}`), ['EVT-000021 | 1']);
  });
});

test('the generated filters, not the live inputs, decide the rows', () => {
  let run = initialReportRun('contact');
  const applied = filters({ status: 'Valid' });
  run = reportRunReducer(run, { type: 'start', reportKey: 'contact', requestId: 1, filters: applied });
  run = reportRunReducer(run, { type: 'success', requestId: 1, rows: CONTACTS });
  const live = filters({ searchValue: 'gala', status: 'Invalid', eventId: 'evtB' });
  assert.equal(filtersDiffer(run.applied, live), true);
  const rows = groupRecordsByEvent(filterReportRows(run.rows, CONTACT, run.applied!, false), contactRecordEventIds, EVENTS);
  assert.deepEqual(rows.map((r) => r.eventId), ['EVT-000022', 'EVT-000021'], 'still the generated Status = Valid report');
  assert.ok(reports.includes('searchFirst || serverFiltered ? (hasResults ? run.applied : null) : liveFilters;'));
  assert.ok(reports.includes("filterReportRows(decoratedRows, definition, reportFilters, reportOption.type === 'date')"));
});

test('the downloads are the displayed records, and say what they were filtered by', () => {
  const exportFn = between(reports, 'const runExport = useCallback(', 'const viewedEvent');
  assert.ok(exportFn.includes('await exportToExcel(name, definition.label, definition.columns, filteredRows, meta);'));
  assert.ok(exportFn.includes('await exportToPdf(name, definition.label, definition.columns, filteredRows, meta);'));
  assert.ok(exportFn.includes("...(definition.statusChoices ? { status: exportFilters.status || 'All Statuses' } : {}),"));
  assert.ok(reports.includes('if (!REPORTS[activeReport].statusChoices) return reportOption.key;'), 'named for the event, like Access');
});

test('View opens on the matching contacts when searched, with every contact a click away', () => {
  assert.ok(view.includes('const params = showingMatches ? { ...JSON.parse(matchKey), eventId } : { eventId };'));
  assert.ok(view.includes("{showAll ? 'Show only matching records' : 'Show all records'}"));
  assert.ok(reports.includes('matchParams={viewMatchParams}'));
});

test('the word-start status matcher stays available, unused by these reports', () => {
  // Kept as a utility; the Contact Report's Status is now an exact dropdown.
  assert.equal(matchesStatusWord('Invalid', 'valid'), false);
  assert.equal(matchesStatusWord('Valid', 'val'), true);
  assert.equal(between(reports, "key: 'contact'", 'const Reports = () =>').includes('statusMatches'), false);
});

test('the Event Report is unchanged', () => {
  assert.ok(reports.includes('onClick={() => setSelectedEventId(row._id)}'));
  assert.ok(reports.includes("{activeReport === 'event' && selectedEventId ? ("));
  assert.ok(reports.includes(': definition.columns;'));
  assert.equal(between(reports, "key: 'event'", "key: 'access'").includes('statusChoices'), false);
});
