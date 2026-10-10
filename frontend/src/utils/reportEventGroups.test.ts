/**
 * The Access and Contact Reports, one row per event, with a View per event.
 *
 * The grouping runs for real over the records a fake endpoint returns (it
 * answers as the server does: the event scope and the dates applied, access
 * records labelled with accessEventIds), filtered by the generated filters
 * exactly as the page filters them. The View is the event alone: every record
 * of it, whatever the report's filters. The page wiring is asserted from source.
 *
 * Run: npx tsx --test frontend/src/utils/reportEventGroups.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  groupRecordsByEvent,
  countUnlinkedRecords,
  accessRecordEventIds,
  contactRecordEventIds,
} from './reportEventGroups.ts';
import { filterReportRows, filtersDiffer, reportRunReducer, initialReportRun, type ReportFilters } from './reportSearch.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const reports = read('frontend/src/pages/Reports.tsx');
const view = read('frontend/src/components/ui/ReportEventView.tsx');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

// ─── fixtures ────────────────────────────────────────────────────────────────

const COLLEGE = { _id: 'evtC', eventId: 'EVT-000021', eventName: 'College Event', eventStatus: 'Upcoming' };
const BETA = { _id: 'evtB', eventId: 'EVT-000022', eventName: 'Beta Conference', eventStatus: 'Upcoming' };
const QUIET = { _id: 'evtQ', eventId: 'EVT-000023', eventName: 'Quiet Gathering', eventStatus: 'Upcoming' };
/** The events list, newest first - the order the Event Report lists them in. */
const EVENTS = [QUIET, BETA, COLLEGE];

const ACCESS_DB = [
  { _id: 'u1', name: 'Rahul', email: 'rahul@x.com', status: 'Active', accessEventIds: ['evtC'], accessGrantedOn: '2026-10-01T06:00:00.000Z', accessExpiryDate: '2027-01-01' },
  { _id: 'u2', name: 'Priya', email: 'priya@x.com', status: 'Active', accessEventIds: ['evtC'], accessGrantedOn: '2026-10-02T06:00:00.000Z', accessExpiryDate: '2027-01-01' },
  { _id: 'a1', name: 'Admin Kiran', email: 'kiran@x.com', status: 'Active', accessEventIds: ['evtC', 'evtB'], accessGrantedOn: '2026-10-03T06:00:00.000Z', accessExpiryDate: '2027-01-01' },
  { _id: 'u3', name: 'Bina', email: 'bina@x.com', status: 'Active', accessEventIds: ['evtB'], accessGrantedOn: '2026-10-10T06:00:00.000Z', accessExpiryDate: '2027-01-01' },
  { _id: 'u4', name: 'Lonely', email: 'lonely@x.com', status: 'Active', accessEventIds: [], accessGrantedOn: '2026-10-02T06:00:00.000Z', accessExpiryDate: '2027-01-01' },
];
const CONTACT_DB = [
  { _id: 'c1', fullName: 'College Guest One', email: 'c1@x.com', phoneNumber: '+91900001', status: 'Valid', eventId: 'evtC', createdAt: '2026-10-01T06:00:00.000Z' },
  { _id: 'c2', fullName: 'College Guest Two', email: 'c2@x.com', phoneNumber: '+91900002', status: 'Invalid', eventId: 'evtC', createdAt: '2026-10-02T06:00:00.000Z' },
  { _id: 'c3', fullName: 'Beta Guest', email: 'b1@x.com', phoneNumber: '+91900003', status: 'Valid', eventId: 'evtB', createdAt: '2026-10-10T06:00:00.000Z' },
];

/**
 * College records the report's filters leave out - granted / added in
 * November, and a status no search for "valid" would keep - which the event's
 * View must still show.
 */
const LATE_ACCESS = { _id: 'u9', name: 'Late Lalit', email: 'lalit@x.com', status: 'Expired', accessEventIds: ['evtC'], accessGrantedOn: '2026-11-05T06:00:00.000Z', accessExpiryDate: '2026-11-06' };
const LATE_CONTACT = { _id: 'c9', fullName: 'College Late Guest', email: 'late@x.com', phoneNumber: '+91900009', status: 'Invalid', eventId: 'evtC', createdAt: '2026-11-05T06:00:00.000Z' };

const ACCESS = { text: (r: any) => `${r.name} ${r.email}`, status: (r: any) => r.status, date: (r: any) => r.accessGrantedOn };
const CONTACT = { text: (r: any) => `${r.fullName} ${r.phoneNumber} ${r.email}`, status: (r: any) => r.status, date: (r: any) => r.createdAt };

/** No dates means no range, as the real endpoints treat a request without them. */
const inRange = (iso: string, f: Partial<ReportFilters>) =>
  (!f.startDate || iso.slice(0, 10) >= f.startDate) && (!f.endDate || iso.slice(0, 10) <= f.endDate);

/** The two endpoints as the server answers them. */
const server = {
  access: (f: Partial<ReportFilters>) =>
    [...ACCESS_DB, LATE_ACCESS].filter((r) => (!f.eventId || r.accessEventIds.includes(f.eventId)) && inRange(r.accessGrantedOn, f))
      .map((r) => (f.eventId ? { ...r, accessEventIds: [f.eventId] } : r)),
  contact: (f: Partial<ReportFilters>) =>
    [...CONTACT_DB, LATE_CONTACT].filter((r) => (!f.eventId || r.eventId === f.eventId) && inRange(r.createdAt, f)),
};

const filters = (over: Partial<ReportFilters> = {}): ReportFilters => ({
  mode: 'Name', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '', ...over,
});

/** Generate the report as the page does and group it into event rows. */
const generate = (key: 'access' | 'contact', applied: ReportFilters) => {
  const records = filterReportRows(server[key](applied), key === 'access' ? ACCESS : CONTACT, applied, applied.mode === 'Date');
  const idsOf = key === 'access' ? accessRecordEventIds : contactRecordEventIds;
  return { records, rows: groupRecordsByEvent(records, idsOf, EVENTS), unlinked: countUnlinkedRecords(records, idsOf) };
};

const ids = (rows: any[]) => rows.map((r) => r.eventId);

// ─── grouping ────────────────────────────────────────────────────────────────

test('grouping records into event rows', async (t) => {
  await t.test('one event produces one row, with its own fields and count', () => {
    const rows = groupRecordsByEvent(CONTACT_DB.slice(0, 2), contactRecordEventIds, EVENTS);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._id, 'evtC');
    assert.equal(rows[0].eventName, 'College Event');
    assert.equal(rows[0].recordCount, 2);
  });

  await t.test('several events produce one row each, in the events list\'s order', () => {
    const rows = groupRecordsByEvent(CONTACT_DB, contactRecordEventIds, EVENTS);
    assert.deepEqual(ids(rows), ['EVT-000022', 'EVT-000021']);
    assert.deepEqual(rows.map((r) => r.recordCount), [1, 2]);
  });

  await t.test('an access record reaching two events counts under both', () => {
    const rows = groupRecordsByEvent(ACCESS_DB, accessRecordEventIds, EVENTS);
    assert.deepEqual(rows.map((r) => [r.eventId, r.recordCount]), [['EVT-000022', 2], ['EVT-000021', 3]]);
  });

  await t.test('an event with no matching records gets no row', () => {
    const rows = groupRecordsByEvent(ACCESS_DB, accessRecordEventIds, EVENTS);
    assert.equal(rows.some((r) => r._id === 'evtQ'), false);
  });

  await t.test('no records: no rows', () => {
    assert.deepEqual(groupRecordsByEvent([], contactRecordEventIds, EVENTS), []);
  });

  await t.test('an event the list does not hold yet still gets its row', () => {
    const rows = groupRecordsByEvent([{ eventId: 'evtNew' }], contactRecordEventIds, EVENTS);
    assert.deepEqual(rows.map((r) => [r._id, r.eventName, r.recordCount]), [['evtNew', '-', 1]]);
    assert.equal(groupRecordsByEvent([{ eventId: 'evtNew' }], contactRecordEventIds, [])[0].eventName, 'Loading...');
  });

  await t.test('records linked to no event are counted, so the page can say so', () => {
    assert.equal(countUnlinkedRecords(ACCESS_DB, accessRecordEventIds), 1);
    assert.equal(countUnlinkedRecords(CONTACT_DB, contactRecordEventIds), 0);
  });
});

// ─── Access Report ───────────────────────────────────────────────────────────

test('Access Report event rows follow the generated filters', async (t) => {
  await t.test('a selected event shows that event\'s row only', () => {
    const { rows } = generate('access', filters({ eventId: 'evtC' }));
    assert.deepEqual(ids(rows), ['EVT-000021']);
    assert.equal(rows[0].recordCount, 3);
  });

  await t.test('All events shows one row per matching event', () => {
    assert.deepEqual(ids(generate('access', filters()).rows), ['EVT-000022', 'EVT-000021']);
  });

  await t.test('a username search keeps only the events of the matching people', () => {
    assert.deepEqual(ids(generate('access', filters({ searchValue: 'bina' })).rows), ['EVT-000022']);
    assert.deepEqual(ids(generate('access', filters({ searchValue: 'rahul' })).rows), ['EVT-000021']);
  });

  await t.test('a status search does the same', () => {
    assert.deepEqual(ids(generate('access', filters({ mode: 'Status', searchValue: 'expired' })).rows), []);
    assert.equal(generate('access', filters({ mode: 'Status', searchValue: 'active' })).rows.length, 2);
  });

  await t.test('dates decide which events appear', () => {
    // Bina (Beta only) was granted on 10 Oct; Kiran still reaches Beta on 3 Oct.
    const early = generate('access', filters({ startDate: '2026-10-01', endDate: '2026-10-02' }));
    assert.deepEqual(ids(early.rows), ['EVT-000021']);
    assert.equal(early.unlinked, 1, 'Lonely matched but reaches no event');
  });

  await t.test('no matching records: no rows, the empty report', () => {
    const { rows, records } = generate('access', filters({ searchValue: 'nobody' }));
    assert.equal(records.length, 0);
    assert.equal(rows.length, 0);
  });
});

// ─── Contact Report ──────────────────────────────────────────────────────────

test('Contact Report event rows follow the generated filters', async (t) => {
  await t.test('a selected event shows that event\'s row only', () => {
    const { rows } = generate('contact', filters({ eventId: 'evtC' }));
    assert.deepEqual(ids(rows), ['EVT-000021']);
    assert.equal(rows[0].recordCount, 2);
  });

  await t.test('All events shows one row per matching event', () => {
    assert.deepEqual(ids(generate('contact', filters()).rows), ['EVT-000022', 'EVT-000021']);
  });

  await t.test('a name search keeps only the events of the matching contacts', () => {
    assert.deepEqual(ids(generate('contact', filters({ searchValue: 'beta' })).rows), ['EVT-000022']);
  });

  await t.test('a status search does the same', () => {
    const { rows } = generate('contact', filters({ mode: 'Status', searchValue: 'invalid' }));
    assert.deepEqual(ids(rows), ['EVT-000021']);
    assert.equal(rows[0].recordCount, 1);
  });

  await t.test('dates decide which events appear', () => {
    assert.deepEqual(ids(generate('contact', filters({ startDate: '2026-10-05', endDate: '2026-10-31' })).rows), ['EVT-000022']);
  });

  await t.test('no matching contacts: no rows, the empty report', () => {
    assert.equal(generate('contact', filters({ eventId: 'evtQ' })).rows.length, 0);
  });
});

// ─── generated filters ───────────────────────────────────────────────────────

test('the rows and View keep the generated filters when the picker moves', async (t) => {
  await t.test('a report generated for College stays College', () => {
    let run = initialReportRun('access');
    run = reportRunReducer(run, { type: 'start', reportKey: 'access', requestId: 1, filters: filters({ eventId: 'evtC' }) });
    run = reportRunReducer(run, { type: 'success', requestId: 1, rows: server.access(filters({ eventId: 'evtC' })) });
    const live = filters({ eventId: 'evtB' });
    assert.equal(run.applied!.eventId, 'evtC');
    assert.equal(filtersDiffer(run.applied, live), true);
    const rows = groupRecordsByEvent(filterReportRows(run.rows, ACCESS, run.applied!, false), accessRecordEventIds, EVENTS);
    assert.deepEqual(ids(rows), ['EVT-000021'], 'grouped from the generated report, not the live picker');
  });

  await t.test('the rows come from filteredRows - built from the generated filters', () => {
    assert.ok(reports.includes('() => (eventIdsOf ? groupRecordsByEvent(filteredRows, eventIdsOf, events) : []),'));
    assert.ok(reports.includes('searchFirst || serverFiltered ? (hasResults ? run.applied : null) : liveFilters;'));
  });

  await t.test('View opens the clicked row\'s event; only a searched report hands it its filters', () => {
    const branch = between(reports, '<ReportEventView', '/>');
    assert.ok(branch.includes('eventId={scopedViewEventId}'));
    assert.ok(branch.includes('matchParams={viewMatchParams}'));
    for (const inherited of ['filters=', 'reportFilters', 'liveFilters', 'reportEventId', 'accessors=', 'isDateMode=']) {
      assert.equal(branch.includes(inherited), false, `View is not given ${inherited}`);
    }
    // The match parameters come from the generated filters, and only when the
    // report was searched by a name/username or a status.
    const match = between(reports, 'const viewMatchParams = useMemo(() => {', '}, [reportFilters, serverFiltered, activeReport]);');
    assert.ok(match.includes('if (!reportFilters || !serverFiltered) return undefined;'));
    assert.ok(match.includes('if (Object.keys(reportFilterParams(activeReport, reportFilters)).length === 0) return undefined;'));
    assert.ok(match.includes('...reportFilterParams(activeReport, reportFilters),'));
  });
});

// ─── View ────────────────────────────────────────────────────────────────────

test('View opens the event\'s details and only its records', async (t) => {
  await t.test('the row\'s View opens that row\'s event', () => {
    assert.ok(reports.includes('onClick={() => setScopedViewEventId(row._id)}'));
    // No generated report is needed: an event's Access Report link opens its View directly.
    assert.ok(reports.includes(') : eventScoped && scopedViewEventId ? ('));
  });

  await t.test('without a search, and under "Show all records", the request is the event id only', () => {
    assert.ok(view.includes('const params = showingMatches ? { ...JSON.parse(matchKey), eventId } : { eventId };'));
    assert.ok(view.includes('const showingMatches = Boolean(matchParams) && !showAll;'));
    assert.ok(view.includes("{showAll ? 'Show only matching records' : 'Show all records'}"));
    assert.equal(/startDate|endDate|searchValue/.test(view), false, 'the View names no report filter itself');
    const branch = between(reports, '<ReportEventView', '/>');
    assert.ok(branch.includes('endpoint={definition.endpoint}'), 'the existing, server-scoped endpoint');
    assert.ok(branch.includes('columns={definition.columns}'), 'the report\'s own columns');
  });

  await t.test('every record the endpoint returns is shown; nothing is filtered out', () => {
    assert.equal(view.includes('filterReportRows'), false);
    assert.ok(view.includes('const shown = useMemo(() => (decorate ? rows.map(decorate) : rows), [rows, decorate]);'));
  });

  await t.test('Access: records outside the report\'s dates, name and status are in the event\'s View under Show all records', () => {
    // The report: College, October, people named "rahul" with status Active.
    const applied = filters({ eventId: 'evtC', searchValue: 'rahul' });
    const { rows, records } = generate('access', applied);
    assert.deepEqual(ids(rows), ['EVT-000021'], 'the filters decided the row');
    assert.deepEqual(records.map((r: any) => r.name), ['Rahul']);
    // The View: the event alone.
    const viewed = server.access({ eventId: 'evtC' });
    assert.deepEqual(viewed.map((r) => r.name).sort(), ['Admin Kiran', 'Late Lalit', 'Priya', 'Rahul']);
    assert.ok(viewed.some((r) => r.name === 'Late Lalit'), 'granted in November and Expired, still shown');
    assert.equal(viewed.some((r) => r.name === 'Bina'), false, 'no one from another event');
  });

  await t.test('Contact: records outside the report\'s dates, name and status are in the event\'s View under Show all records', () => {
    const applied = filters({ mode: 'Status', searchValue: 'valid', startDate: '2026-10-01', endDate: '2026-10-01' });
    const { rows } = generate('contact', applied);
    assert.deepEqual(ids(rows), ['EVT-000021'], 'only College Guest One matched, so only College is listed');
    const viewed = server.contact({ eventId: 'evtC' });
    assert.deepEqual(viewed.map((r) => r.fullName).sort(), ['College Guest One', 'College Guest Two', 'College Late Guest']);
    assert.equal(viewed.some((r) => r.fullName === 'Beta Guest'), false);
  });

  await t.test('a refused event shows the server\'s refusal, and no records', () => {
    assert.ok(view.includes("setError(err?.response?.data?.error || 'Could not load this event. Please try again.');"));
    assert.ok(view.includes('setRows([]);'));
    assert.ok(view.includes("status === 'error' ? ("));
  });

  await t.test('it shows the event\'s details as the Event Report words them, then the section', () => {
    assert.ok(reports.includes('REPORTS.event.columns.map((column) => [column.header, String(column.value(scopedViewEvent))]'));
    assert.ok(view.includes('Event Details'));
    assert.ok(reports.includes("detailsTitle: 'Access Details'"));
    assert.ok(reports.includes("detailsTitle: 'Contact Details'"));
  });

  await t.test('Back returns to the event rows, and a new search or tab closes the View', () => {
    assert.ok(reports.includes("onBack={() => setScopedViewEventId('')}"));
    for (const fn of ['const runSearch', 'const switchReport', 'const clearFilters']) {
      const body = reports.slice(reports.indexOf(fn), reports.indexOf(fn) + 1800);
      assert.ok(body.includes("setScopedViewEventId('');"), fn);
    }
  });
});

// ─── regression ──────────────────────────────────────────────────────────────

test('the Event Report and the downloads are unchanged', async (t) => {
  await t.test('only Access and Contact are grouped; the Event Report keeps its own rows and columns', () => {
    assert.ok(reports.includes('const eventIdsOf = eventScoped ? definition.eventIds : undefined;'));
    assert.ok(reports.includes('const tableRows: any[] = eventIdsOf ? eventRows : filteredRows;'));
    assert.ok(reports.includes(': definition.columns;'));
    const eventBlock = between(reports, "key: 'event'", "key: 'access'");
    assert.equal(eventBlock.includes('eventIds:'), false, 'the Event Report has no grouping');
  });

  await t.test('its View still opens its own drill-down', () => {
    assert.ok(reports.includes("{activeReport === 'event' && (\n                        <td className=\"py-4 text-right\">"));
    assert.ok(reports.includes('onClick={() => setSelectedEventId(row._id)}'));
    assert.ok(reports.includes("{activeReport === 'event' && selectedEventId ? ("));
  });

  await t.test('the downloads are still written record by record from filteredRows', () => {
    const exportFn = between(reports, 'const runExport = useCallback(', 'const viewedEvent');
    assert.ok(exportFn.includes('await exportToExcel(name, definition.label, definition.columns, filteredRows, meta);'));
    assert.ok(exportFn.includes('await exportToPdf(name, definition.label, definition.columns, filteredRows, meta);'));
    assert.equal(exportFn.includes('eventRows'), false);
    assert.equal(exportFn.includes('tableRows'), false);
  });
});
