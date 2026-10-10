/**
 * The Access Report's filters: event, username, status and dates apply
 * together; Search sends them to the server; the table and both downloads are
 * the same filtered records; an event's "Access Report" link opens the report
 * on that event.
 *
 * The bug: the filter bar offered UserName, Status and Date as one choice.
 * Username and Status shared the search box, so they could never combine,
 * and choosing Date (to set the required period) switched the username search
 * off while still showing it.
 *
 * Run: npx tsx --test frontend/src/utils/accessReportFilters.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  filterReportRows,
  filtersDiffer,
  reportFilterParams,
  reportEventParam,
  reportRunReducer,
  initialReportRun,
  type ReportFilters,
} from './reportSearch.ts';
import { buildMetaRows, buildReportFileName } from './reportExport.ts';
import { getAccessStatus, ACCESS_STATUSES } from './accessStatus.ts';

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
  status: (r: any) => getAccessStatus(r),
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
  mode: 'UserName', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '', status: '', ...over,
});
const namesFor = (f: ReportFilters) => filterReportRows(RECORDS, ACCESS, f, false).map((r) => r.name);

// ─── the filters combine ─────────────────────────────────────────────────────

test('username, status and dates apply together on the page as well', async (t) => {
  await t.test('username only', () => {
    assert.deepEqual(namesFor(filters({ searchValue: 'kavya' })), ['Kavya Kite']);
    assert.deepEqual(namesFor(filters({ searchValue: 'kunal@x' })), ['Kunal Kite'], 'by email');
  });

  await t.test('status only: exactly the chosen status', () => {
    assert.deepEqual(namesFor(filters({ status: 'Active' })), ['Kavya Kite', 'Kunal Kite']);
    assert.deepEqual(namesFor(filters({ status: 'Expired' })), ['Kabir Kite']);
    assert.deepEqual(namesFor(filters({ status: 'Scheduled' })), ['Keya Kite']);
    assert.deepEqual(namesFor(filters({ status: 'Cancelled' })), ['Kiara Kite']);
    assert.deepEqual(namesFor(filters({ status: 'Rejected' })), ['Krish Kite']);
  });

  await t.test('dates only', () => {
    assert.deepEqual(namesFor(filters({ startDate: '2026-10-06', endDate: '2026-10-07' })), ['Kavya Kite', 'Keya Kite']);
  });

  await t.test('username + status + dates together', () => {
    assert.deepEqual(namesFor(filters({ searchValue: 'kite', status: 'Active', startDate: '2026-10-01', endDate: '2026-10-10' })), ['Kavya Kite']);
  });

  await t.test('nothing matches: no records', () => {
    assert.deepEqual(namesFor(filters({ searchValue: 'kite', status: 'Rejected', startDate: '2026-10-01', endDate: '2026-10-05' })), []);
  });

  await t.test('applying the page filters to the server\'s filtered rows changes nothing', () => {
    const server = RECORDS.filter((r) => r.name.toLowerCase().includes('kite') && getAccessStatus(r) === 'Active');
    assert.deepEqual(filterReportRows(server, ACCESS, filters({ searchValue: 'kite', status: 'Active' }), false), server.filter((r) => r.accessGrantedOn <= '2026-10-31'));
  });
});

// ─── Search sends them ───────────────────────────────────────────────────────

test('Search sends the event, username and status with the dates', async (t) => {
  await t.test('the Access Report\'s parameters', () => {
    assert.deepEqual(reportFilterParams('access', filters({ searchValue: '  kavya ', status: 'Active' })), { username: 'kavya', status: 'Active' });
    assert.deepEqual(reportFilterParams('access', filters()), {}, 'empty filters are not sent');
    assert.deepEqual(reportFilterParams('contact', filters({ searchValue: 'x', status: 'Valid' })), { name: 'x', status: 'Valid' }, 'the Contact Report sends a name');
    assert.deepEqual(reportFilterParams('event', filters({ searchValue: 'x' })), {});
    assert.deepEqual(reportEventParam('access', filters({ eventId: 'evtK' })), { eventId: 'evtK' });
  });

  await t.test('the request carries them on Search, from the generated filters', () => {
    const load = between(reports, 'const loadReport = useCallback(', '/**\n   * Roles other than Super Admin');
    assert.ok(load.includes('...reportEventParam(key, filters),'));
    assert.ok(load.includes('...reportFilterParams(key, filters),'), 'for every role, within its own scope');
    assert.equal(load.includes('searchFirst ? reportFilterParams'), false);
    assert.ok(load.includes('startDate: filters.startDate,') && load.includes('endDate: filters.endDate,'));
    assert.ok(reports.includes('void loadReport(activeReport, liveFilters);'), 'Search generates with the latest inputs');
  });

  await t.test('a changed status counts as changed filters', () => {
    assert.equal(filtersDiffer(filters({ status: 'Active' }), filters({ status: 'Expired' })), true);
    assert.equal(filtersDiffer(filters({ status: '' }), { mode: 'UserName', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '' }), false);
  });

  await t.test('the generated filters, not later edits, are the report', () => {
    let run = initialReportRun('access');
    run = reportRunReducer(run, { type: 'start', reportKey: 'access', requestId: 1, filters: filters({ status: 'Active', eventId: 'evtK' }) });
    assert.equal(filtersDiffer(run.applied, filters({ status: 'Expired', eventId: 'evtL' })), true);
    assert.equal(run.applied!.status, 'Active');
  });
});

// ─── the filter bar ──────────────────────────────────────────────────────────

test('the Access filter bar: a username box and a Status dropdown, no single choice', async (t) => {
  await t.test('the Access Report has one text field and the five statuses', () => {
    const block = between(reports, "key: 'access'", "key: 'contact'");
    assert.ok(block.includes("options: [{ key: 'UserName', label: 'UserName', type: 'text' }],"));
    assert.ok(block.includes('statusChoices: ACCESS_STATUSES,'));
    assert.deepEqual([...ACCESS_STATUSES], ['Active', 'Scheduled', 'Expired', 'Cancelled', 'Rejected']);
  });

  await t.test('the bar shows the Status dropdown with "All Statuses", and no radio for a single field', () => {
    assert.ok(bar.includes('{options.length > 1 && ('));
    assert.ok(bar.includes('<option value="">All Statuses</option>'));
    assert.ok(bar.includes('onChange={(e) => onStatusChange?.(e.target.value)}'));
    assert.ok(reports.includes('statusOptions={definition.statusChoices}'));
    assert.ok(reports.includes('onStatusChange={setStatusChoice}'));
  });

  await t.test('the Event Report keeps its filter choices; the Contact Report works like Access', () => {
    assert.equal(between(reports, "key: 'event'", "key: 'access'").includes('statusChoices'), false);
    const contact = between(reports, "key: 'contact'", 'const Reports = () =>');
    assert.ok(contact.includes('statusChoices: CONTACT_STATUSES,'));
    assert.equal(contact.includes("key: 'Date'"), false);
  });

  await t.test('Clear and switching report reset the status with the other filters', () => {
    assert.ok(between(reports, 'const clearFilters', 'const switchReportRef').includes("setStatusChoice('');"));
    assert.ok(between(reports, 'const switchReport', 'const clearFilters').includes("setStatusChoice('');"));
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

  await t.test('they state the status filter and the event', () => {
    const exportFn = between(reports, 'const runExport = useCallback(', 'const viewedEvent');
    assert.ok(exportFn.includes("...(definition.statusChoices ? { status: exportFilters.status || 'All Statuses' } : {}),"));
    assert.deepEqual(buildMetaRows({ searchValue: 'kite', startDate: '2026-10-01', endDate: '2026-10-31', status: 'Active', event: 'EVT-000006 | Kite Festival' }), [
      ['Search Value', 'kite'], ['Start Date', '2026-10-01'], ['End Date', '2026-10-31'], ['Status', 'Active'], ['Event', 'EVT-000006 | Kite Festival'],
    ]);
    assert.deepEqual(buildMetaRows({ startDate: '2026-10-01', endDate: '2026-10-31' }).length, 3, 'other reports unchanged');
  });

  await t.test('the file name says Access Report, the event (or All Events) and the date', () => {
    assert.ok(reports.includes("return filters?.eventId ? evt?.eventId || 'Event' : 'AllEvents';"));
    assert.ok(reports.includes('const name = buildReportFileName(definition.fileName, downloadLabel(exportFilters));'));
    const when = new Date('2026-10-09T06:00:00.000Z');
    assert.equal(buildReportFileName('AccessReport', 'EVT-000006', when), 'AccessReport_EVT000006_09102026');
    assert.equal(buildReportFileName('AccessReport', 'AllEvents', when), 'AccessReport_AllEvents_09102026');
  });
});

// ─── opening the report on an event ──────────────────────────────────────────

test('an event\'s "Access Report" link opens the report on that event', async (t) => {
  await t.test('the Event Report View offers it, and keeps its own View', () => {
    const link = between(reports, "{activeReport === 'event' && selectedEventId && canViewAccessReport && (", '{activeReport === \'event\' && selectedEventId ? (');
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
    assert.ok(open.includes('setReportEventId(requestedEventId);'), 'selected in "Select Event Name"');
    assert.ok(open.includes('setScopedViewEventId(requestedEventId);'), 'its access records shown');
    assert.ok(reports.includes(') : eventScoped && scopedViewEventId ? ('), 'the View needs no generated report');
  });

  await t.test('for every role: the Super Admin\'s and the live-filtering roles\' paths both open it', () => {
    const effects = reports.match(/openRequestedEvent\(requestedType\);/g) || [];
    assert.equal(effects.length, 2);
    assert.ok(reports.includes('if (searchFirst || !requestedType) return;'));
  });
});

// ─── one filtering path for every role, and a status fixed at generation ────

test('the status a report was generated with is the one it keeps', async (t) => {
  const { accessStatusOf } = await import('./accessStatus.ts');

  await t.test('the server\'s accessStatus is used, even after the window has since closed', () => {
    const generatedActive = { name: 'Kavya Kite', accessStatus: 'Active', accessExpiryDate: past };
    assert.equal(getAccessStatus(generatedActive), 'Expired', 'recalculating now would say Expired');
    assert.equal(accessStatusOf(generatedActive), 'Active', 'the report keeps what it was generated with');
  });

  await t.test('a record without a valid snapshot is derived as before', () => {
    assert.equal(accessStatusOf({ accessExpiryDate: past }), 'Expired');
    assert.equal(accessStatusOf({ accessStatus: 'Sleeping', isAccessCancelled: true }), 'Cancelled');
  });

  await t.test('the table, the Status filter and the downloads all read the snapshot', () => {
    const block = between(reports, "key: 'access'", "key: 'contact'");
    assert.ok(block.includes('status: (row) => accessStatusOf(row),'), 'the filter and the badge');
    assert.ok(block.includes("{ header: 'Status', value: (r) => accessStatusOf(r), width: 14 },"), 'the table and both downloads');
    assert.equal(block.includes('getAccessStatus('), false, 'nothing in the report recalculates it');
  });

  await t.test('filtering a generated report by status uses the snapshot', () => {
    const SNAPSHOT = { ...ACCESS, status: (r: any) => accessStatusOf(r) };
    const rows = [
      { name: 'Generated Active', accessStatus: 'Active', accessExpiryDate: past, accessGrantedOn: '2026-10-06T06:00:00.000Z' },
      { name: 'Generated Expired', accessStatus: 'Expired', accessExpiryDate: future, accessGrantedOn: '2026-10-06T06:00:00.000Z' },
    ];
    assert.deepEqual(filterReportRows(rows, SNAPSHOT, filters({ status: 'Active' }), false).map((r) => r.name), ['Generated Active']);
  });
});

test('every role gets the same server-side filtering, without a request per keystroke', async (t) => {
  await t.test('the Access Report is the last request\'s answer and filters, for every role', () => {
    assert.ok(reports.includes('searchFirst || serverFiltered ? (hasResults ? run.applied : null) : liveFilters;'));
  });

  await t.test('roles without a Search button reload when the username rests, or the status changes', () => {
    const debounce = between(reports, 'const [debouncedSearch, setDebouncedSearch] = useState', 'const loadReport = useCallback(');
    assert.ok(debounce.includes('if (searchFirst || !serverFiltered) return;'), 'Super Admins keep their Search button');
    assert.ok(debounce.includes('setTimeout(() => setDebouncedSearch(searchValue.trim()), 400)'), 'a pause, not every keystroke');
    assert.ok(debounce.includes('return () => clearTimeout(timer);'), 'each keystroke restarts the wait');
    assert.ok(debounce.includes('`${debouncedSearch}\\u0000${statusChoice}`'));
    assert.ok(reports.includes('}, [hasReportAccess, searchFirst, activeReport, loadReport, startDate, endDate, reportEventId, liveFilterQuery]);'));
  });

  await t.test('the Access and Contact Reports reload; the Event Report keeps filtering live in the page', () => {
    assert.ok(reports.includes('const serverFiltered = Boolean(definition.statusChoices);'));
    assert.ok(reports.includes('const liveFilterQuery = !searchFirst && serverFiltered ?'));
  });
});
