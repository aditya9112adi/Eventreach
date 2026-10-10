/**
 * The Contact Report's filters, laid out exactly like the Event Report's: a
 * "Filter By" choice (Name, Status, Date), one search box and the dates. The
 * chosen filter decides which event rows it lists, and the server applies it
 * (see tests/accessContactReports.integration.test.ts).
 *
 * Status is matched from the start of a word, so "valid" finds Valid and never
 * Invalid; the Date choice searches by the period alone.
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
  statusMatches: matchesStatusWord,
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
  mode: 'Name', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '', ...over,
});

/** The rows the Contact Report lists for these generated filters. */
const rowsFor = (applied: ReportFilters) => {
  const records = filterReportRows(CONTACTS, CONTACT, applied, applied.mode === 'Date');
  return {
    records: records.map((r) => r.fullName),
    rows: groupRecordsByEvent(records, contactRecordEventIds, EVENTS).map((r) => `${r.eventId} | ${r.recordCount}`),
  };
};

// ─── the filter bar ──────────────────────────────────────────────────────────

test('the Contact filter bar is the Event Report\'s: Filter By, one search box, the dates', async (t) => {
  const contactBlock = between(reports, "key: 'contact'", 'const Reports = () =>');

  await t.test('Name, Status and Date to choose from', () => {
    assert.ok(contactBlock.includes("{ key: 'Name', label: 'Name', type: 'text' },"));
    assert.ok(contactBlock.includes("{ key: 'Status', label: 'Status', type: 'text' },"));
    assert.ok(contactBlock.includes("{ key: 'Date', label: 'Date', type: 'date' },"));
    assert.equal(contactBlock.includes('statusChoices'), false, 'no Status dropdown');
  });

  await t.test('the fixture mirrors the real Contact definition', () => {
    assert.ok(contactBlock.includes('text: (row) => `${value(row.fullName)} ${value(row.phoneNumber)} ${value(row.email)}`'));
    assert.ok(contactBlock.includes("status: (row) => value(row.status, '-'),"));
    assert.ok(contactBlock.includes('statusMatches: matchesStatusWord,'));
    assert.ok(contactBlock.includes('date: (row) => row.createdAt,'));
  });

  await t.test('Search sends the chosen filter to the server', () => {
    assert.deepEqual(reportFilterParams('contact', filters({ searchValue: '  beta ' })), { name: 'beta' });
    assert.deepEqual(reportFilterParams('contact', filters({ mode: 'Status', searchValue: 'valid' })), { status: 'valid' });
    assert.deepEqual(reportFilterParams('contact', filters({ mode: 'Date', searchValue: 'ignored' })), {}, 'Date: the period alone');
    assert.deepEqual(reportFilterParams('contact', filters()), {}, 'nothing empty is sent');
  });
});

// ─── the filters ─────────────────────────────────────────────────────────────

test('Name lists only the events of matching contacts', async (t) => {
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

test('Status lists only the events of matching contacts', async (t) => {
  await t.test('"valid" keeps valid contacts only - never the invalid ones', () => {
    const { records, rows } = rowsFor(filters({ mode: 'Status', searchValue: 'valid' }));
    assert.deepEqual(records, ['College Guest One', 'Beta Guest']);
    assert.deepEqual(rows, ['EVT-000022 | 1', 'EVT-000021 | 1']);
  });

  await t.test('Invalid and Duplicate, and the start of a status', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'Invalid' })).rows, ['EVT-000001 | 1', 'EVT-000021 | 1']);
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'dup' })).rows, ['EVT-000022 | 1']);
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'inv' })).records, ['College Guest Two', 'Gala Invalid Guest']);
  });
});

test('Date searches by the period alone, and the period applies to every choice', async (t) => {
  await t.test('the period decides which events appear', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Date', startDate: '2026-10-01', endDate: '2026-10-10' })).rows, ['EVT-000022 | 2', 'EVT-000021 | 2']);
    assert.deepEqual(rowsFor(filters({ mode: 'Date', startDate: '2026-10-15', endDate: '2026-10-31' })).rows, ['EVT-000001 | 1']);
  });

  await t.test('text left in the box is ignored by the Date choice', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Date', searchValue: 'beta' })).rows, ['EVT-000001 | 1', 'EVT-000022 | 2', 'EVT-000021 | 2']);
  });

  await t.test('Name or Status within the dates', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'guest', startDate: '2026-10-15', endDate: '2026-10-31' })).rows, ['EVT-000001 | 1']);
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'invalid', startDate: '2026-10-01', endDate: '2026-10-10' })).rows, ['EVT-000021 | 1']);
  });
});

test('the generated filters, not the live inputs, decide the rows', () => {
  let run = initialReportRun('contact');
  const applied = filters({ mode: 'Status', searchValue: 'valid' });
  run = reportRunReducer(run, { type: 'start', reportKey: 'contact', requestId: 1, filters: applied });
  run = reportRunReducer(run, { type: 'success', requestId: 1, rows: CONTACTS });
  const live = filters({ searchValue: 'gala', eventId: 'evtB' });
  assert.equal(filtersDiffer(run.applied, live), true);
  const rows = groupRecordsByEvent(filterReportRows(run.rows, CONTACT, run.applied!, false), contactRecordEventIds, EVENTS);
  assert.deepEqual(rows.map((r) => r.eventId), ['EVT-000022', 'EVT-000021'], 'still the generated Status "valid" report');
  assert.ok(reports.includes('searchFirst || serverFiltered ? (hasResults ? run.applied : null) : liveFilters;'));
  assert.ok(reports.includes("filterReportRows(decoratedRows, definition, reportFilters, reportOption.type === 'date')"));
});

test('the downloads are the displayed records, named for the event', () => {
  const exportFn = between(reports, 'const runExport = useCallback(', 'const viewedEvent');
  assert.ok(exportFn.includes('await exportToExcel(name, definition.label, definition.columns, filteredRows, meta);'));
  assert.ok(exportFn.includes('await exportToPdf(name, definition.label, definition.columns, filteredRows, meta);'));
  assert.ok(reports.includes('if (!EVENT_SCOPED_REPORTS.includes(activeReport)) return reportOption.key;'));
});

test('View opens on the matching contacts when searched, with every contact a click away', () => {
  assert.ok(view.includes('const params = showingMatches ? { ...JSON.parse(matchKey), eventId } : { eventId };'));
  assert.ok(view.includes("{showAll ? 'Show only matching records' : 'Show all records'}"));
  assert.ok(reports.includes('matchParams={viewMatchParams}'));
});

test('the Event Report is unchanged', () => {
  assert.ok(reports.includes('onClick={() => setSelectedEventId(row._id)}'));
  assert.ok(reports.includes("{activeReport === 'event' && selectedEventId ? ("));
  assert.ok(reports.includes(': definition.columns;'));
  assert.equal(between(reports, "key: 'event'", "key: 'access'").includes('statusMatches'), false);
});
