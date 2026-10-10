/**
 * The Access Report's filters, laid out exactly like the Event Report's: a
 * "Filter By" choice (UserName, Status, Date), one search box and the dates.
 * The chosen filter is applied by the server with the event and the dates;
 * the table and both downloads are the same filtered records; an event's
 * "Access Report" link opens the report on that event.
 *
 * Run: npx tsx --test frontend/src/utils/accessReportFilters.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  filterReportRows,
  filtersDiffer,
  matchesStatusWord,
  reportFilterParams,
  reportEventParam,
  reportRunReducer,
  initialReportRun,
  type ReportFilters,
} from './reportSearch.ts';
import { buildMetaRows, buildReportFileName } from './reportExport.ts';
import { getAccessStatus, accessStatusOf } from './accessStatus.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const reports = read('frontend/src/pages/Reports.tsx');
const bar = read('frontend/src/components/ui/ReportFilterBar.tsx');
const eventDetail = read('frontend/src/pages/Events/EventDetail.tsx');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

const DAY = 24 * 3600 * 1000;
const future = new Date(Date.now() + 30 * DAY).toISOString();
const past = new Date(Date.now() - 30 * DAY).toISOString();

/** The Access Report's accessors, as Reports.tsx declares them (checked below). */
const ACCESS = {
  text: (r: any) => `${r.name ?? ''} ${r.email ?? ''}`,
  status: (r: any) => accessStatusOf(r),
  statusMatches: matchesStatusWord,
  date: (r: any) => r.accessGrantedOn || r.createdAt,
};

const RECORDS = [
  { _id: 'u1', name: 'Kavya Kite', email: 'kavya@x.test', accessGrantedOn: '2026-10-06T06:00:00.000Z', accessExpiryDate: future },
  { _id: 'u2', name: 'Kunal Kite', email: 'kunal@x.test', accessGrantedOn: '2026-10-12T06:00:00.000Z', accessExpiryDate: future },
  { _id: 'u3', name: 'Kabir Kite', email: 'kabir@x.test', accessGrantedOn: '2026-10-08T06:00:00.000Z', accessExpiryDate: past },
  { _id: 'u4', name: 'Keya Kite', email: 'keya@x.test', accessGrantedOn: '2026-10-07T06:00:00.000Z', accessStartDate: future },
  { _id: 'u5', name: 'Kiara Kite', email: 'kiara@x.test', accessGrantedOn: '2026-10-09T06:00:00.000Z', isAccessCancelled: true },
  { _id: 'u6', name: 'Krish Kite', email: 'krish@x.test', status: 'Rejected', createdAt: '2026-10-10T06:00:00.000Z' },
];

const filters = (over: Partial<ReportFilters> = {}): ReportFilters => ({
  mode: 'UserName', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '', ...over,
});
const namesFor = (f: ReportFilters) => filterReportRows(RECORDS, ACCESS, f, f.mode === 'Date').map((r) => r.name);

// ─── the filter bar ──────────────────────────────────────────────────────────

test('the Access filter bar is the Event Report\'s: Filter By, one search box, the dates', async (t) => {
  await t.test('UserName, Status and Date to choose from', () => {
    const block = between(reports, "key: 'access'", "key: 'contact'");
    assert.ok(block.includes("{ key: 'UserName', label: 'UserName', type: 'text' },"));
    assert.ok(block.includes("{ key: 'Status', label: 'Status', type: 'text' },"));
    assert.ok(block.includes("{ key: 'Date', label: 'Date', type: 'date' },"));
    assert.ok(block.includes('statusMatches: matchesStatusWord,'));
    assert.equal(block.includes('statusChoices'), false, 'no Status dropdown');
  });

  await t.test('the same bar component, with no Status dropdown in it', () => {
    assert.equal(bar.includes('statusOptions'), false);
    assert.equal(bar.includes('report-status'), false);
    assert.equal(reports.includes('statusOptions='), false);
    assert.ok(bar.includes('<legend className={LABEL}>Filter By</legend>'));
  });

  await t.test('the Date choice shows no text it would ignore', () => {
    assert.ok(bar.includes("value={isDateMode ? '' : searchValue}"));
    assert.ok(bar.includes('disabled={isDateMode}'));
  });

  await t.test('the Event Report keeps its own choices', () => {
    const block = between(reports, "key: 'event'", "key: 'access'");
    assert.ok(block.includes("{ key: 'EventName', label: 'Name / ID', type: 'text' },"));
    assert.ok(block.includes("{ key: 'EventID', label: 'Event ID', type: 'text' },"));
    assert.equal(block.includes('statusMatches'), false);
  });
});

// ─── the chosen filter ───────────────────────────────────────────────────────

test('the chosen filter, with the dates, decides the records', async (t) => {
  await t.test('UserName: a name or email, anywhere in it', () => {
    assert.deepEqual(namesFor(filters({ searchValue: 'kavya' })), ['Kavya Kite']);
    assert.deepEqual(namesFor(filters({ searchValue: 'kunal@x' })), ['Kunal Kite'], 'by email');
  });

  await t.test('Status: from the start of a word, so "act" finds Active and nothing else', () => {
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'Active' })), ['Kavya Kite', 'Kunal Kite']);
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'act' })), ['Kavya Kite', 'Kunal Kite']);
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'expired' })), ['Kabir Kite']);
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'sched' })), ['Keya Kite']);
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'Cancelled' })), ['Kiara Kite']);
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'rejected' })), ['Krish Kite']);
  });

  await t.test('Date: the period alone - any text left in the box is ignored', () => {
    assert.deepEqual(namesFor(filters({ mode: 'Date', searchValue: 'kavya', startDate: '2026-10-06', endDate: '2026-10-07' })), ['Kavya Kite', 'Keya Kite']);
  });

  await t.test('UserName or Status, always within the dates', () => {
    assert.deepEqual(namesFor(filters({ searchValue: 'kite', startDate: '2026-10-01', endDate: '2026-10-07' })), ['Kavya Kite', 'Keya Kite']);
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'active', startDate: '2026-10-01', endDate: '2026-10-10' })), ['Kavya Kite']);
  });

  await t.test('nothing matches: no records', () => {
    assert.deepEqual(namesFor(filters({ searchValue: 'nobody' })), []);
    assert.deepEqual(namesFor(filters({ mode: 'Status', searchValue: 'sleeping' })), []);
  });
});

// ─── Search sends it ─────────────────────────────────────────────────────────

test('Search sends the chosen filter, with the event and the dates', async (t) => {
  await t.test('the parameter for each choice', () => {
    assert.deepEqual(reportFilterParams('access', filters({ searchValue: '  kavya ' })), { username: 'kavya' });
    assert.deepEqual(reportFilterParams('access', filters({ mode: 'Status', searchValue: 'act' })), { status: 'act' });
    assert.deepEqual(reportFilterParams('access', filters({ mode: 'Date', searchValue: 'ignored' })), {}, 'Date: the period alone');
    assert.deepEqual(reportFilterParams('access', filters()), {}, 'nothing empty is sent');
    assert.deepEqual(reportFilterParams('contact', filters({ mode: 'Name', searchValue: 'x' })), { name: 'x' });
    assert.deepEqual(reportFilterParams('event', filters({ searchValue: 'x' })), {}, 'the Event Report filters in the page');
    assert.deepEqual(reportEventParam('access', filters({ eventId: 'evtK' })), { eventId: 'evtK' });
  });

  await t.test('the request carries them, from the generated filters, for every role', () => {
    const load = between(reports, 'const loadReport = useCallback(', '/**\n   * Roles other than Super Admin');
    assert.ok(load.includes('...reportEventParam(key, filters),'));
    assert.ok(load.includes('...reportFilterParams(key, filters),'));
    assert.ok(load.includes('startDate: filters.startDate,') && load.includes('endDate: filters.endDate,'));
    assert.ok(reports.includes('void loadReport(activeReport, liveFilters);'), 'Search generates with the latest inputs');
  });

  await t.test('the generated filters, not later edits, are the report', () => {
    let run = initialReportRun('access');
    run = reportRunReducer(run, { type: 'start', reportKey: 'access', requestId: 1, filters: filters({ mode: 'Status', searchValue: 'active', eventId: 'evtK' }) });
    assert.equal(filtersDiffer(run.applied, filters({ mode: 'UserName', searchValue: 'active', eventId: 'evtK' })), true, 'a changed choice is a change');
    assert.equal(filtersDiffer(run.applied, filters({ mode: 'Status', searchValue: 'active', eventId: 'evtL' })), true);
    assert.ok(reports.includes('searchFirst || serverFiltered ? (hasResults ? run.applied : null) : liveFilters;'));
  });
});

// ─── the downloads ───────────────────────────────────────────────────────────

test('the downloads are the displayed records, named for the event', async (t) => {
  await t.test('Excel and PDF are written from the table\'s own filtered records', () => {
    const exportFn = between(reports, 'const runExport = useCallback(', 'const viewedEvent');
    assert.ok(exportFn.includes('await exportToExcel(name, definition.label, definition.columns, filteredRows, meta);'));
    assert.ok(exportFn.includes('await exportToPdf(name, definition.label, definition.columns, filteredRows, meta);'));
    assert.ok(reports.includes('const exportFilters = reportFilters ?? liveFilters;'), 'the generated filters');
  });

  await t.test('they state the search and the event, as the Event Report states its search', () => {
    assert.deepEqual(buildMetaRows({ searchValue: 'kite', startDate: '2026-10-01', endDate: '2026-10-31', event: 'EVT-000006 | Kite Festival' }), [
      ['Search Value', 'kite'], ['Start Date', '2026-10-01'], ['End Date', '2026-10-31'], ['Event', 'EVT-000006 | Kite Festival'],
    ]);
  });

  await t.test('the file name says the report, the event (or All Events) and the date', () => {
    assert.ok(reports.includes('if (!EVENT_SCOPED_REPORTS.includes(activeReport)) return reportOption.key;'));
    assert.ok(reports.includes('const name = buildReportFileName(definition.fileName, downloadLabel(exportFilters));'));
    const when = new Date('2026-10-09T06:00:00.000Z');
    assert.equal(buildReportFileName('AccessReport', 'EVT-000006', when), 'AccessReport_EVT000006_09102026');
    assert.equal(buildReportFileName('AccessReport', 'AllEvents', when), 'AccessReport_AllEvents_09102026');
  });
});

// ─── a status fixed at generation ────────────────────────────────────────────

test('the status a report was generated with is the one it keeps', async (t) => {
  await t.test('the server\'s accessStatus is used, even after the window has since closed', () => {
    const generatedActive = { name: 'Kavya Kite', accessStatus: 'Active', accessExpiryDate: past };
    assert.equal(getAccessStatus(generatedActive), 'Expired', 'recalculating now would say Expired');
    assert.equal(accessStatusOf(generatedActive), 'Active', 'the report keeps what it was generated with');
  });

  await t.test('a record without a valid snapshot is derived as before', () => {
    assert.equal(accessStatusOf({ accessExpiryDate: past }), 'Expired');
    assert.equal(accessStatusOf({ accessStatus: 'Sleeping', isAccessCancelled: true }), 'Cancelled');
  });

  await t.test('the table, the Status search and the downloads all read the snapshot', () => {
    const block = between(reports, "key: 'access'", "key: 'contact'");
    assert.ok(block.includes('status: (row) => accessStatusOf(row),'));
    assert.ok(block.includes("{ header: 'Status', value: (r) => accessStatusOf(r), width: 14 },"));
    assert.equal(block.includes('getAccessStatus('), false);
    const rows = [
      { name: 'Generated Active', accessStatus: 'Active', accessExpiryDate: past, accessGrantedOn: '2026-10-06T06:00:00.000Z' },
      { name: 'Generated Expired', accessStatus: 'Expired', accessExpiryDate: future, accessGrantedOn: '2026-10-06T06:00:00.000Z' },
    ];
    assert.deepEqual(filterReportRows(rows, ACCESS, filters({ mode: 'Status', searchValue: 'active' }), false).map((r) => r.name), ['Generated Active']);
  });
});

// ─── roles without a Search button ───────────────────────────────────────────

test('every role gets the same server filtering, without a request per keystroke', async (t) => {
  await t.test('roles without a Search button reload when the search rests, or the choice changes', () => {
    const debounce = between(reports, 'const [debouncedSearch, setDebouncedSearch] = useState', 'const loadReport = useCallback(');
    assert.ok(debounce.includes('if (searchFirst || !serverFiltered) return;'), 'Super Admins keep their Search button');
    assert.ok(debounce.includes('setTimeout(() => setDebouncedSearch(searchValue.trim()), 400)'), 'a pause, not every keystroke');
    assert.ok(debounce.includes('return () => clearTimeout(timer);'));
    assert.ok(debounce.includes('`${debouncedSearch}\\u0000${mode}`'));
    assert.ok(reports.includes('}, [hasReportAccess, searchFirst, activeReport, loadReport, startDate, endDate, reportEventId, liveFilterQuery]);'));
  });

  await t.test('only the Access and Contact Reports reload; the Event Report filters in the page', () => {
    assert.ok(reports.includes('const serverFiltered = EVENT_SCOPED_REPORTS.includes(activeReport);'));
  });
});

// ─── View ────────────────────────────────────────────────────────────────────

test('View opens on the matching records of a searched report', () => {
  const match = between(reports, 'const viewMatchParams = useMemo(() => {', '}, [reportFilters, serverFiltered, activeReport]);');
  assert.ok(match.includes('if (Object.keys(reportFilterParams(activeReport, reportFilters)).length === 0) return undefined;'),
    'a UserName or Status search; the Date choice alone shows every record');
  assert.ok(match.includes('...reportFilterParams(activeReport, reportFilters),'));
});

// ─── opening the report on an event ──────────────────────────────────────────

test('an event\'s "Access Report" link opens the report on that event', async (t) => {
  await t.test('the Event Report View offers it, and keeps its own View', () => {
    const link = between(reports, "{activeReport === 'event' && selectedEventId && canViewAccessReport && (", "{activeReport === 'event' && selectedEventId ? (");
    assert.ok(link.includes('navigate(`/reports?type=access&eventId=${selectedEventId}`)'), 'by the event\'s id');
    assert.ok(reports.includes('onClick={() => setSelectedEventId(row._id)}'), 'the Event Report View is unchanged');
  });

  await t.test('the Event Details page offers it to the roles that can open it', () => {
    assert.ok(eventDetail.includes("const canViewAccessReport = user?.role === 'SuperAdmin' || user?.role === 'Admin';"));
    assert.ok(eventDetail.includes('navigate(`/reports?type=access&eventId=${event._id}`)'));
  });

  await t.test('the report takes a well-formed id from the link, selects it and opens its View', () => {
    assert.ok(reports.includes("const requestedEventId = /^[a-f0-9]{24}$/i.test(rawRequestedEventId) ? rawRequestedEventId : '';"));
    const open = between(reports, 'const openRequestedEvent = (key: ReportKey) => {', '};');
    assert.ok(open.includes('setReportEventId(requestedEventId);'));
    assert.ok(open.includes('setScopedViewEventId(requestedEventId);'));
    assert.ok(reports.includes(') : eventScoped && scopedViewEventId ? ('));
  });

  await t.test('for every role', () => {
    assert.equal((reports.match(/openRequestedEvent\(requestedType\);/g) || []).length, 2);
    assert.ok(reports.includes('if (searchFirst || !requestedType) return;'));
  });
});
