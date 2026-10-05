/**
 * The Contact Report's Name, Status and Date filters decide which event rows
 * it lists.
 *
 * The bug: Status was matched with "contains", and "Valid" is part of
 * "Invalid", so a search for Valid contacts kept the invalid ones too - the
 * Status filter looked as if it did nothing. The Contact Report now matches a
 * status from the start of a word; the Event and Access Reports, whose
 * statuses do not contain one another, keep the plain match.
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

// ─── the matcher ─────────────────────────────────────────────────────────────

test('a status is matched from the start of a word', () => {
  assert.equal(matchesStatusWord('Valid', 'valid'), true);
  assert.equal(matchesStatusWord('Invalid', 'valid'), false, 'the bug: "valid" must not match Invalid');
  assert.equal(matchesStatusWord('Invalid', 'invalid'), true);
  assert.equal(matchesStatusWord('Invalid', 'inv'), true, 'typing the start still works');
  assert.equal(matchesStatusWord('Duplicate', 'dup'), true);
  assert.equal(matchesStatusWord('Valid', 'VALID'), true, 'case-insensitive');
  assert.equal(matchesStatusWord('Not Started', 'started'), true, 'any word of the status');
  assert.equal(matchesStatusWord('Valid', ''), true);
});

// ─── Contact Report filters ──────────────────────────────────────────────────

test('Contact Name filter lists only the events of matching contacts', async (t) => {
  await t.test('one contact\'s name: only that contact\'s event', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'College Guest One' })), {
      records: ['College Guest One'], rows: ['EVT-000021 | 1'],
    });
  });

  await t.test('a name shared by contacts of two events: both events, with their own counts', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'guest two' })).rows, ['EVT-000022 | 1', 'EVT-000021 | 1']);
  });

  await t.test('the Name filter searches name, phone and email - as it always has', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: '+919700000003' })).rows, ['EVT-000022 | 1']);
    assert.deepEqual(rowsFor(filters({ searchValue: 'beta2@verify' })).rows, ['EVT-000022 | 1']);
  });

  await t.test('no matching name: no rows', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'nobody' })).rows, []);
  });
});

test('Contact Status filter lists only the events of matching contacts', async (t) => {
  await t.test('Valid keeps valid contacts only - not the invalid ones', () => {
    const { records, rows } = rowsFor(filters({ mode: 'Status', searchValue: 'Valid' }));
    assert.deepEqual(records, ['College Guest One', 'Beta Guest']);
    assert.deepEqual(rows, ['EVT-000022 | 1', 'EVT-000021 | 1']);
    assert.equal(rows.some((r) => r.startsWith('EVT-000001')), false, 'the Gala has only an invalid contact');
  });

  await t.test('Invalid keeps invalid contacts only', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'Invalid' })).rows, ['EVT-000001 | 1', 'EVT-000021 | 1']);
  });

  await t.test('Duplicate keeps duplicates only', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'duplicate' })).rows, ['EVT-000022 | 1']);
  });

  await t.test('the start of a status still works', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'inv' })).records, ['College Guest Two', 'Gala Invalid Guest']);
  });
});

test('Contact Date filter keeps working', async (t) => {
  await t.test('the period decides which events appear', () => {
    assert.deepEqual(rowsFor(filters({ startDate: '2026-10-01', endDate: '2026-10-10' })).rows, ['EVT-000022 | 2', 'EVT-000021 | 2']);
    assert.deepEqual(rowsFor(filters({ startDate: '2026-10-15', endDate: '2026-10-31' })).rows, ['EVT-000001 | 1']);
  });

  await t.test('the Date mode applies the period and no text search, as before', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Date', searchValue: 'ignored', startDate: '2026-10-01', endDate: '2026-10-31' })).rows,
      ['EVT-000001 | 1', 'EVT-000022 | 2', 'EVT-000021 | 2']);
  });
});

test('filters combine: the period with a Name or a Status', async (t) => {
  // The filter bar takes one text filter at a time (Name or Status), always
  // together with the required period.
  await t.test('Name + Date', () => {
    assert.deepEqual(rowsFor(filters({ searchValue: 'guest', startDate: '2026-10-15', endDate: '2026-10-31' })).rows, ['EVT-000001 | 1']);
    assert.deepEqual(rowsFor(filters({ searchValue: 'gala', startDate: '2026-10-01', endDate: '2026-10-10' })).rows, []);
  });

  await t.test('Status + Date', () => {
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'Invalid', startDate: '2026-10-01', endDate: '2026-10-10' })).rows, ['EVT-000021 | 1']);
    assert.deepEqual(rowsFor(filters({ mode: 'Status', searchValue: 'Valid', startDate: '2026-10-15', endDate: '2026-10-31' })).rows, []);
  });

  await t.test('Status + Date + the selected event (the server keeps only that event\'s contacts)', () => {
    const scoped = CONTACTS.filter((c) => c.eventId === 'evtC');
    const applied = filters({ mode: 'Status', searchValue: 'Valid', eventId: 'evtC' });
    const rows = groupRecordsByEvent(filterReportRows(scoped, CONTACT, applied, false), contactRecordEventIds, EVENTS);
    assert.deepEqual(rows.map((r) => `${r.eventId} | ${r.recordCount}`), ['EVT-000021 | 1']);
  });
});

test('the generated filters, not the live inputs, decide the rows', () => {
  let run = initialReportRun('contact');
  const applied = filters({ mode: 'Status', searchValue: 'Valid' });
  run = reportRunReducer(run, { type: 'start', reportKey: 'contact', requestId: 1, filters: applied });
  run = reportRunReducer(run, { type: 'success', requestId: 1, rows: CONTACTS });
  const live = filters({ mode: 'Name', searchValue: 'gala', eventId: 'evtB' });
  assert.equal(filtersDiffer(run.applied, live), true);
  const rows = groupRecordsByEvent(filterReportRows(run.rows, CONTACT, run.applied!, false), contactRecordEventIds, EVENTS);
  assert.deepEqual(rows.map((r) => r.eventId), ['EVT-000022', 'EVT-000021'], 'still the generated Status = Valid report');
  assert.ok(reports.includes('const reportFilters: ReportFilters | null = searchFirst ? (hasResults ? run.applied : null) : liveFilters;'));
  assert.ok(reports.includes('filterReportRows(decoratedRows, definition, reportFilters, reportOption.type === \'date\')'));
});

test('the page uses this matcher for the Contact Report only', async (t) => {
  await t.test('the fixture mirrors the real Contact definition', () => {
    const contactBlock = between(reports, "key: 'contact'", 'const Reports = () =>');
    assert.ok(contactBlock.includes('text: (row) => `${value(row.fullName)} ${value(row.phoneNumber)} ${value(row.email)}`'));
    assert.ok(contactBlock.includes("status: (row) => value(row.status, '-'),"));
    assert.ok(contactBlock.includes('statusMatches: matchesStatusWord,'));
    assert.ok(contactBlock.includes('date: (row) => row.createdAt,'));
  });

  await t.test('the Event and Access Reports keep the plain "contains" match', () => {
    assert.equal(between(reports, "key: 'event'", "key: 'access'").includes('statusMatches'), false);
    assert.equal(between(reports, "key: 'access'", "key: 'contact'").includes('statusMatches'), false);
    const plain = { text: (r: any) => r.name, status: (r: any) => r.status, date: (r: any) => r.date };
    const events = [{ name: 'a', status: 'Completed', date: '2026-10-05' }, { name: 'b', status: 'Upcoming', date: '2026-10-05' }];
    assert.deepEqual(filterReportRows(events, plain, filters({ mode: 'Status', searchValue: 'plete' }), false).map((r) => r.status), ['Completed'],
      'a mid-word search still matches, exactly as before');
  });

  await t.test('the downloads are written from the same filtered records', () => {
    const exportFn = between(reports, 'const runExport = useCallback(', 'const viewedEvent');
    assert.ok(exportFn.includes('await exportToExcel(name, definition.label, definition.columns, filteredRows, meta);'));
    assert.ok(exportFn.includes('await exportToPdf(name, definition.label, definition.columns, filteredRows, meta);'));
  });
});

test('View is unchanged: the event alone, every contact of it', () => {
  assert.ok(view.includes('.get(endpoint, { params: { eventId } })'));
  assert.equal(/startDate|endDate|searchValue|filterReportRows/.test(view), false);
  const branch = between(reports, '<ReportEventView', '/>');
  assert.equal(/filters=|reportFilters|statusMatches/.test(branch), false);
});

test('the Event Report is unchanged', () => {
  assert.ok(reports.includes('onClick={() => setSelectedEventId(row._id)}'));
  assert.ok(reports.includes("{activeReport === 'event' && selectedEventId ? ("));
  assert.ok(reports.includes(': definition.columns;'));
});
