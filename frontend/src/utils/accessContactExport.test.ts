/**
 * The Access and Contact Reports' Excel and PDF, scoped to the event (and
 * dates) the report was generated with.
 *
 * The event scope itself is enforced by the server (see
 * tests/accessContactReports.integration.test.ts); here a fake endpoint that
 * behaves the same way stands in for it, and the real writers produce the
 * files, which are read back. The page wiring is asserted from source.
 *
 * Run: npx tsx --test frontend/src/utils/accessContactExport.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'node:module';
import { buildReportWorkbook, buildReportPdf, buildMetaRows, type ReportColumn } from './reportExport.ts';
import {
  filterReportRows,
  filtersDiffer,
  reportEventParam,
  reportRunReducer,
  initialReportRun,
  EVENT_SCOPED_REPORTS,
  type ReportFilters,
  type ReportKey,
} from './reportSearch.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const reports = read('frontend/src/pages/Reports.tsx');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

// ─── the two reports' real definitions (checked against Reports.tsx below) ───

const v = (x: unknown, fallback = '') => (x === null || x === undefined || x === '' ? fallback : String(x));

const ACCESS_COLUMNS: ReportColumn<any>[] = [
  { header: 'Name', value: (r) => v(r.name, '-'), width: 24 },
  { header: 'Email', value: (r) => v(r.email, '-'), width: 30 },
  { header: 'Role', value: (r) => v(r.role || r.type, '-'), width: 14 },
  { header: 'Access Through', value: (r) => v(r.accessVia, '-'), width: 30 },
  { header: 'Status', value: (r) => v(r.status, '-'), width: 14 },
  { header: 'Assigned Event', value: (r) => v(r.assignedEventName, '-'), width: 26 },
  { header: 'Access Granted On', value: (r) => v(r.accessGrantedOn, '-'), width: 24 },
  { header: 'Access Start', value: (r) => v(r.accessStartDate, '-'), width: 24 },
  { header: 'Access Expiry', value: (r) => v(r.accessExpiryDate, '-'), width: 24 },
];
const ACCESS = { text: (r: any) => `${v(r.name)} ${v(r.email)}`, status: (r: any) => v(r.status, '-'), date: (r: any) => r.accessGrantedOn || r.createdAt };

const CONTACT_COLUMNS: ReportColumn<any>[] = [
  { header: 'Full Name', value: (r) => v(r.fullName, '-'), width: 26 },
  { header: 'Phone', value: (r) => v(r.phoneNumber, '-'), width: 18 },
  { header: 'Email', value: (r) => v(r.email, '-'), width: 30 },
  { header: 'Event', value: (r) => v(r.eventName, '-'), width: 26 },
  { header: 'Source', value: (r) => v(r.source, '-'), width: 16 },
  { header: 'Status', value: (r) => v(r.status, '-'), width: 14 },
  { header: 'Added On', value: (r) => v(r.createdAt, '-'), width: 24 },
];
const CONTACT = { text: (r: any) => `${v(r.fullName)} ${v(r.phoneNumber)} ${v(r.email)}`, status: (r: any) => v(r.status, '-'), date: (r: any) => r.createdAt };

// ─── fixtures and a server stand-in ──────────────────────────────────────────

const A = { _id: 'evtA', eventId: 'EVT-000001', eventName: 'Annual Tech Fest' };
const B = { _id: 'evtB', eventId: 'EVT-000002', eventName: 'Beta Conference' };

const ACCESS_DB = [
  { _id: 'u1', name: 'Rahul', email: 'rahul@gmail.com', role: 'User', status: 'Active', assignedEventId: A._id, assignedEventName: A.eventName, accessGrantedOn: '2026-10-01T06:00:00.000Z' },
  { _id: 'u2', name: 'Priya', email: 'priya@gmail.com', role: 'User', status: 'Active', assignedEventId: A._id, assignedEventName: A.eventName, accessGrantedOn: '2026-10-02T06:00:00.000Z' },
  { _id: 'u3', name: 'Amit', email: 'amit@gmail.com', role: 'User', status: 'Active', assignedEventId: A._id, assignedEventName: A.eventName, accessGrantedOn: '2026-10-10T06:00:00.000Z' },
  { _id: 'u4', name: 'Bina', email: 'bina@gmail.com', role: 'User', status: 'Active', assignedEventId: B._id, assignedEventName: B.eventName, accessGrantedOn: '2026-10-02T06:00:00.000Z' },
  { _id: 'u5', name: 'Bobby', email: 'bobby@gmail.com', role: 'User', status: 'Active', assignedEventId: B._id, assignedEventName: B.eventName, accessGrantedOn: '2026-10-03T06:00:00.000Z' },
];
const CONTACT_DB = [
  { _id: 'c1', fullName: 'Contact A1', phoneNumber: '+919000000001', email: 'a1@x.com', eventId: A._id, eventName: A.eventName, source: 'Manual', status: 'Valid', createdAt: '2026-10-01T06:00:00.000Z' },
  { _id: 'c2', fullName: 'Contact A2', phoneNumber: '+919000000002', email: 'a2@x.com', eventId: A._id, eventName: A.eventName, source: 'Manual', status: 'Valid', createdAt: '2026-10-02T06:00:00.000Z' },
  { _id: 'c3', fullName: 'Contact A3', phoneNumber: '+919000000003', email: 'a3@x.com', eventId: A._id, eventName: A.eventName, source: 'Excel', status: 'Valid', createdAt: '2026-10-10T06:00:00.000Z' },
  { _id: 'c4', fullName: 'Contact B1', phoneNumber: '+919000000004', email: 'b1@x.com', eventId: B._id, eventName: B.eventName, source: 'Manual', status: 'Valid', createdAt: '2026-10-02T06:00:00.000Z' },
  { _id: 'c5', fullName: 'Contact B2', phoneNumber: '+919000000005', email: 'b2@x.com', eventId: B._id, eventName: B.eventName, source: 'Manual', status: 'Valid', createdAt: '2026-10-03T06:00:00.000Z' },
];

const inRange = (iso: string, start: string, end: string) =>
  iso.slice(0, 10) >= start && iso.slice(0, 10) <= end;

/** What the two endpoints answer: the event (if any) and the period, applied server side. */
const fakeServer = (key: ReportKey, params: { startDate: string; endDate: string; eventId?: string }) => {
  const db: any[] = key === 'access' ? ACCESS_DB : CONTACT_DB;
  const linked = (r: any) => (key === 'access' ? r.assignedEventId : r.eventId);
  const date = (r: any) => (key === 'access' ? r.accessGrantedOn : r.createdAt);
  return db.filter((r) => (!params.eventId || linked(r) === params.eventId) && inRange(date(r), params.startDate, params.endDate));
};

const filters = (over: Partial<ReportFilters> = {}): ReportFilters => ({
  mode: 'Name', searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '', ...over,
});

/**
 * Generate -> review -> export, as the page does it: the request carries the
 * generated filters' event and dates, the table filters the answer by the same
 * filters, and the download is written from those rows and those filters.
 */
const generateAndExport = async (key: 'access' | 'contact', applied: ReportFilters) => {
  const params = { startDate: applied.startDate, endDate: applied.endDate, ...reportEventParam(key, applied) };
  const rows = fakeServer(key, params);
  const shown = filterReportRows(rows, key === 'access' ? ACCESS : CONTACT, applied, applied.mode === 'Date');
  const columns = key === 'access' ? ACCESS_COLUMNS : CONTACT_COLUMNS;
  const title = key === 'access' ? 'Access Report' : 'Contact Report';
  const meta = {
    searchValue: applied.searchValue, startDate: applied.startDate, endDate: applied.endDate,
    event: applied.eventId ? [A, B].map((e) => (e._id === applied.eventId ? `${e.eventId} | ${e.eventName}` : '')).join('') : 'All Events',
  };
  const workbook = await reopen(await buildReportWorkbook(title, columns, shown, meta));
  const pdf = await pdfText(await buildReportPdf(title, columns, shown, meta));
  return { params, shown, sheet: workbook.worksheets[0], pdf };
};

const reopen = async (workbook: any) => {
  const buffer = await workbook.xlsx.writeBuffer();
  const imported: any = await import('exceljs');
  const ExcelJS = imported.default ?? imported;
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buffer);
  return back;
};

const textOf = (sheet: any): string[][] => {
  const out: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row: any) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell: any) => cells.push(String(cell.value ?? '')));
    out.push(cells);
  });
  return out;
};

/** The data rows under the header row whose first heading is `first`. */
const dataRows = (sheet: any, first: string) => {
  const rows = textOf(sheet);
  const h = rows.findIndex((r) => r[0] === first);
  const out: string[][] = [];
  for (const r of rows.slice(h + 1)) {
    if (!r[0] || r[0].startsWith('Note ::')) break;
    out.push(r);
  }
  return out;
};

const metaOf = (sheet: any) => Object.fromEntries(textOf(sheet).filter((r) => r.length === 2 && r[0]).map((r) => [r[0], r[1]]));

const pdfText = async (doc: any): Promise<{ text: string; pages: number }> => {
  const require = createRequire(import.meta.url);
  const pdfParse = require(require.resolve('pdf-parse', { paths: ['./backend', '.'] }));
  const parsed = await pdfParse(Buffer.from(doc.output('arraybuffer')));
  return { text: parsed.text.replace(/\s+/g, ' '), pages: parsed.numpages };
};

// ─── the request carries the generated event ────────────────────────────────

test('the event filter goes to the server, for the Access and Contact Reports only', () => {
  assert.deepEqual([...EVENT_SCOPED_REPORTS], ['access', 'contact']);
  assert.deepEqual(reportEventParam('access', filters({ eventId: A._id })), { eventId: A._id });
  assert.deepEqual(reportEventParam('contact', filters({ eventId: A._id })), { eventId: A._id });
  assert.deepEqual(reportEventParam('event', filters({ eventId: A._id })), {}, 'the Event Report never sends one');
  assert.deepEqual(reportEventParam('access', filters({ eventId: '' })), {}, 'no event: no parameter, every record');
  assert.deepEqual(reportEventParam('contact', { mode: 'Name', searchValue: '', startDate: '', endDate: '' }), {});
});

test('a changed event counts as changed filters; an empty one equals none', () => {
  assert.equal(filtersDiffer(filters({ eventId: A._id }), filters({ eventId: B._id })), true);
  assert.equal(filtersDiffer(filters({ eventId: A._id }), filters({ eventId: '' })), true);
  const { eventId: _omitted, ...withoutEvent } = filters();
  assert.equal(filtersDiffer(withoutEvent, filters({ eventId: '' })), false);
});

test('the downloads name the event as a fourth filter line; other reports keep three', () => {
  assert.deepEqual(buildMetaRows({ searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', event: 'EVT-000001 | Annual Tech Fest' }), [
    ['Search Value', '-'], ['Start Date', '2026-10-01'], ['End Date', '2026-10-31'], ['Event', 'EVT-000001 | Annual Tech Fest'],
  ]);
  assert.deepEqual(buildMetaRows({ startDate: '2026-10-01', endDate: '2026-10-31' }), [
    ['Search Value', '-'], ['Start Date', '2026-10-01'], ['End Date', '2026-10-31'],
  ], 'without an event the Event Report header is unchanged');
});

// ─── Access Report ───────────────────────────────────────────────────────────

test('Access Report exports', async (t) => {
  await t.test('Event A: the Excel holds only Event A\'s access records, all three', async () => {
    const { params, sheet } = await generateAndExport('access', filters({ eventId: A._id }));
    assert.equal(params.eventId, A._id);
    const rows = dataRows(sheet, 'Name');
    assert.deepEqual(rows.map((r) => r[0]).sort(), ['Amit', 'Priya', 'Rahul']);
    // Assigned Event is the sixth column, after Name, Email, Role, Access Through and Status.
    assert.ok(rows.every((r) => r[5] === 'Annual Tech Fest'), 'every row is assigned to Event A');
    assert.equal(metaOf(sheet)['Event'], 'EVT-000001 | Annual Tech Fest');
  });

  await t.test('Event A: the PDF holds only Event A\'s access records', async () => {
    const { pdf } = await generateAndExport('access', filters({ eventId: A._id }));
    for (const name of ['Rahul', 'Priya', 'Amit']) assert.ok(pdf.text.includes(name), name);
    for (const name of ['Bina', 'Bobby', 'Beta Conference']) assert.equal(pdf.text.includes(name), false, name);
    assert.ok(pdf.text.includes('EventEVT-000001 | Annual Tech Fest'));
  });

  await t.test('Event B: none of Event A\'s records', async () => {
    const { sheet, pdf } = await generateAndExport('access', filters({ eventId: B._id }));
    assert.deepEqual(dataRows(sheet, 'Name').map((r) => r[0]).sort(), ['Bina', 'Bobby']);
    for (const name of ['Rahul', 'Priya', 'Amit']) assert.equal(pdf.text.includes(name), false);
  });

  await t.test('no event: every record in the period, and it says All Events', async () => {
    const { params, sheet } = await generateAndExport('access', filters());
    assert.equal('eventId' in params, false);
    assert.equal(dataRows(sheet, 'Name').length, 5);
    assert.equal(metaOf(sheet)['Event'], 'All Events');
  });

  await t.test('event and dates together', async () => {
    const { sheet } = await generateAndExport('access', filters({ eventId: A._id, startDate: '2026-10-01', endDate: '2026-10-02' }));
    assert.deepEqual(dataRows(sheet, 'Name').map((r) => r[0]).sort(), ['Priya', 'Rahul']);
  });

  await t.test('dates alone', async () => {
    const { sheet } = await generateAndExport('access', filters({ startDate: '2026-10-02', endDate: '2026-10-03' }));
    assert.deepEqual(dataRows(sheet, 'Name').map((r) => r[0]).sort(), ['Bina', 'Bobby', 'Priya']);
  });

  await t.test('the existing Access Report columns, unchanged', async () => {
    const { sheet } = await generateAndExport('access', filters({ eventId: A._id }));
    assert.ok(textOf(sheet).some((r) => r.join('|') === ACCESS_COLUMNS.map((c) => c.header).join('|')));
  });
});

// ─── Contact Report ──────────────────────────────────────────────────────────

test('Contact Report exports', async (t) => {
  await t.test('Event A: the Excel holds all of Event A\'s contacts, and only them', async () => {
    const { params, sheet } = await generateAndExport('contact', filters({ eventId: A._id }));
    assert.equal(params.eventId, A._id);
    const rows = dataRows(sheet, 'Full Name');
    assert.deepEqual(rows.map((r) => r[0]).sort(), ['Contact A1', 'Contact A2', 'Contact A3']);
    assert.ok(rows.every((r) => r[3] === 'Annual Tech Fest'));
    assert.equal(metaOf(sheet)['Event'], 'EVT-000001 | Annual Tech Fest');
  });

  await t.test('Event A: the PDF holds only Event A\'s contacts', async () => {
    const { pdf } = await generateAndExport('contact', filters({ eventId: A._id }));
    for (const name of ['Contact A1', 'Contact A2', 'Contact A3']) assert.ok(pdf.text.includes(name), name);
    for (const name of ['Contact B1', 'Contact B2', 'Beta Conference']) assert.equal(pdf.text.includes(name), false, name);
  });

  await t.test('Event B: none of Event A\'s contacts', async () => {
    const { sheet } = await generateAndExport('contact', filters({ eventId: B._id }));
    assert.deepEqual(dataRows(sheet, 'Full Name').map((r) => r[0]).sort(), ['Contact B1', 'Contact B2']);
  });

  await t.test('no event: every contact in the period', async () => {
    const { sheet } = await generateAndExport('contact', filters());
    assert.equal(dataRows(sheet, 'Full Name').length, 5);
    assert.equal(metaOf(sheet)['Event'], 'All Events');
  });

  await t.test('event and dates together', async () => {
    const { sheet } = await generateAndExport('contact', filters({ eventId: A._id, startDate: '2026-10-01', endDate: '2026-10-02' }));
    assert.deepEqual(dataRows(sheet, 'Full Name').map((r) => r[0]).sort(), ['Contact A1', 'Contact A2']);
  });

  await t.test('the existing Contact Report columns, unchanged', async () => {
    const { sheet } = await generateAndExport('contact', filters({ eventId: A._id }));
    assert.ok(textOf(sheet).some((r) => r.join('|') === CONTACT_COLUMNS.map((c) => c.header).join('|')));
  });
});

test('many records: all exported, the PDF runs over pages with its headings repeated', async (t) => {
  const many = Array.from({ length: 140 }, (_, i) => ({
    _id: `m${i}`, fullName: `Guest ${String(i).padStart(3, '0')}`, phoneNumber: `+91900${String(i).padStart(7, '0')}`,
    email: `guest${i}@example.com`, eventName: 'Annual Tech Fest', source: 'Excel', status: 'Valid', createdAt: '2026-10-05',
  }));
  const meta = { startDate: '2026-10-01', endDate: '2026-10-31', event: 'EVT-000001 | Annual Tech Fest' };

  await t.test('Excel: every one of the 140 rows', async () => {
    const sheet = (await reopen(await buildReportWorkbook('Contact Report', CONTACT_COLUMNS, many, meta))).worksheets[0];
    assert.equal(dataRows(sheet, 'Full Name').length, 140);
  });

  await t.test('PDF: several pages, every guest present, the header on each page', async () => {
    const { text, pages } = await pdfText(await buildReportPdf('Contact Report', CONTACT_COLUMNS, many, meta));
    assert.ok(pages >= 3, `expected several pages, got ${pages}`);
    for (let i = 0; i < 140; i++) assert.ok(text.includes(`Guest ${String(i).padStart(3, '0')}`), `Guest ${i}`);
    assert.ok((text.match(/Full Name/g) || []).length >= pages, 'the headings repeat on every page');
  });

  await t.test('long text wraps rather than being cut', async () => {
    const long = [{ ...many[0], email: `${'verylongaddress'.repeat(8)}@example.com` }];
    const { text } = await pdfText(await buildReportPdf('Contact Report', CONTACT_COLUMNS, long, meta));
    assert.ok(text.replace(/ /g, '').includes(`${'verylongaddress'.repeat(8)}@example.com`));
  });
});

test('an event with no records: nothing to download, and a file would say so honestly', async (t) => {
  await t.test('the generated report is empty, so the buttons stay disabled', async () => {
    const C = { _id: 'evtC' };
    const { shown, sheet } = await generateAndExport('contact', filters({ eventId: C._id }));
    assert.equal(shown.length, 0);
    assert.equal(dataRows(sheet, 'Full Name').length, 0);
    // Downloads live in each event's View, which offers them only when it shows records.
    const view = read('frontend/src/components/ui/ReportEventView.tsx');
    assert.ok(view.includes("const canExport = status === 'success' && shown.length > 0 && exporting === null;"));
    assert.ok(view.includes("if (exporting || status !== 'success' || shown.length === 0) return;"));
  });
});

// ─── generated filters, not live ones ────────────────────────────────────────

test('the download follows the generated report, not the picker as it is now', async (t) => {
  await t.test('a report generated for Event A stays Event A after the picker moves to B', () => {
    let run = initialReportRun('contact');
    run = reportRunReducer(run, { type: 'start', reportKey: 'contact', requestId: 1, filters: filters({ eventId: A._id }) });
    run = reportRunReducer(run, { type: 'success', requestId: 1, rows: CONTACT_DB.filter((c) => c.eventId === A._id) });
    const live = filters({ eventId: B._id });
    assert.equal(run.applied!.eventId, A._id, 'the generated filters keep Event A');
    assert.equal(filtersDiffer(run.applied, live), true, 'and the page shows the filters have changed');
  });

  await t.test('the report has no downloads of its own; each event\'s View has them, from what it shows', () => {
    assert.ok(reports.includes('searchFirst || serverFiltered ? (hasResults ? run.applied : null) : liveFilters;'));
    assert.equal(reports.includes('const runExport'), false, 'no report-wide download');
    assert.equal(reports.includes('exportFilters'), false);
    assert.ok(reports.includes('fileName={definition.fileName}'), 'the View names its file for its report');
    const view = read('frontend/src/components/ui/ReportEventView.tsx');
    assert.ok(view.includes('rows: shown,'), 'the records the View shows');
    assert.ok(view.includes('match: showingMatches ? (JSON.parse(matchKey) as Record<string, string>) : null,'),
      'and the report\'s search when it shows the matching ones');
  });
});

// ─── the page wiring ─────────────────────────────────────────────────────────

test('Reports.tsx wiring', async (t) => {
  await t.test('the fixtures mirror the real Access and Contact definitions', () => {
    const accessBlock = between(reports, "key: 'access'", "key: 'contact'");
    const contactBlock = between(reports, "key: 'contact'", 'const Reports = () =>');
    assert.deepEqual([...accessBlock.matchAll(/header: '([^']+)'/g)].map((m) => m[1]), ACCESS_COLUMNS.map((c) => c.header));
    assert.deepEqual([...contactBlock.matchAll(/header: '([^']+)'/g)].map((m) => m[1]), CONTACT_COLUMNS.map((c) => c.header));
    assert.ok(accessBlock.includes('date: (row) => row.accessGrantedOn || row.createdAt'));
    assert.ok(contactBlock.includes('date: (row) => row.createdAt'));
  });

  await t.test('an event reaches the report request only when the filters name one - no picker sets one', () => {
    const load = between(reports, 'const loadReport = useCallback(', 'useEffect(() => {');
    assert.ok(load.includes('...reportEventParam(key, filters)'));
    assert.ok(reports.includes('    [mode, searchValue, startDate, endDate]\n  );'), 'the live filters carry no event');
  });

  await t.test('no report tab has a "Select Event Name" picker, nor a hidden event filter behind one', () => {
    assert.equal(reports.includes('Select Event Name'), false);
    assert.equal(reports.includes('<EventSearch'), false);
    assert.equal(reports.includes("import { EventSearch }"), false);
    assert.equal(reports.includes('reportEventId'), false);
  });

  await t.test("events are still opened from the report's own rows", () => {
    assert.ok(reports.includes("onClick={() => openEventFromReport('event', row._id)}"));
    assert.ok(reports.includes("onClick={() => openEventFromReport('scoped', row._id)}"));
    assert.ok(reports.includes("const open = target === 'event' ? setSelectedEventId : setScopedViewEventId;"));
  });

  await t.test('roles that filter live regenerate from the server when the dates or the search change', () => {
    assert.ok(reports.includes('}, [hasReportAccess, searchFirst, activeReport, loadReport, startDate, endDate, liveFilterQuery]);'));
  });
});

// ─── the events list still backs the Access/Contact event rows ──────────────

test('the Access and Contact Reports still have every event to show their rows by', async (t) => {
  const loader = between(reports, 'const loadEventsForSelectors = useCallback(', "/** Fetches a report's rows as one run. */");

  await t.test('the list is fetched as soon as the Access or Contact tab is shown', () => {
    assert.ok(reports.includes('if (searchFirst && showReport && eventScoped) loadEventsForSelectors();'));
    assert.ok(reports.includes('}, [searchFirst, showReport, eventScoped, loadEventsForSelectors]);'));
  });

  await t.test('it is the complete authorized events list, retried after a failure', () => {
    assert.ok(loader.includes("api.get('/events')"), 'the plain /events list, no report range');
    assert.ok(loader.includes('.then((res) => setEvents(res.data))'));
    assert.ok(loader.includes('eventsRequested.current = false; // allow a retry on the next search'));
    assert.ok(reports.includes('groupRecordsByEvent(filteredRows, eventIdsOf, events)'), 'which the event rows are built from');
  });
});
