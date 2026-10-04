/**
 * The Event Report's own Excel and PDF, carrying the Delivery Log of every
 * event the generated report lists.
 *
 * The writers run for real: workbooks are written and read back, PDFs are
 * parsed back to text. The batch endpoint is a fake that behaves as the server
 * does (it returns only the messages of the ids it is sent, labelled with
 * their event), so the request count is measured, not assumed. The page
 * wiring is asserted from source at the end.
 *
 * Run: npx tsx --test frontend/src/utils/eventReportExport.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'node:module';
import {
  fetchReportDeliveryRows,
  groupDeliveryByEvent,
  buildEventReportWorkbook,
  buildEventReportPdf,
  buildReportDeliveryMeta,
  reportEventLabel,
  EVENT_REPORT_DELIVERY_COLUMNS,
  NO_EVENT_MESSAGES,
  REPORT_EVENTS_PER_REQUEST,
  REPORT_MESSAGES_PER_REQUEST,
  type ReportDeliveryRow,
} from './eventReportExport.ts';
import { buildReportWorkbook, buildReportPdf, type ReportColumn } from './reportExport.ts';
import { filterReportRows } from './reportSearch.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const reportsSource = read('frontend/src/pages/Reports.tsx');

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The Event Report's nine columns, as Reports.tsx declares them (checked against the source below). */
const EVENT_COLUMNS: ReportColumn<any>[] = [
  { header: 'Event ID', value: (r) => r.eventId || '-', width: 14 },
  { header: 'Event Name', value: (r) => r.eventName || '', width: 28 },
  { header: 'Event Type', value: (r) => r.eventType || '-', width: 18 },
  { header: 'Organizer', value: (r) => r.organizerName || '-', width: 22 },
  { header: 'Mobile', value: (r) => r.organizerMobile || '-', width: 16 },
  { header: 'Date', value: (r) => r.eventDate?.slice(0, 10) || '-', width: 14 },
  { header: 'Time', value: (r) => r.eventTime || '-', width: 12 },
  { header: 'Venue', value: (r) => r.eventVenue || '-', width: 26 },
  { header: 'Status', value: (r) => r.eventStatus || 'Upcoming', width: 14 },
];

/** The Event Report's filter accessors, as Reports.tsx declares them (checked below). */
const EVENT_ACCESSORS = {
  text: (row: any) => `${row.eventId ?? ''} ${row.eventName ?? ''}`,
  status: (row: any) => row.eventStatus || 'Upcoming',
  date: (row: any) => row.eventDate,
};

const makeEvent = (n: number, name: string, date: string) => ({
  _id: `obj${n}`,
  eventId: `EVT-00000${n}`,
  eventName: name,
  eventType: 'Party',
  organizerName: 'Organiser',
  organizerMobile: '9112472833',
  eventDate: `${date}T00:00:00.000Z`,
  eventTime: '18:30',
  eventVenue: 'Hall',
  eventStatus: 'Upcoming',
});

const A = makeEvent(1, 'Alpha Gala', '2026-10-01');
const B = makeEvent(2, 'Beta Expo', '2026-10-02');
const C = makeEvent(3, 'Gamma Quiet', '2026-10-03');
const D = makeEvent(4, 'Delta Later', '2026-10-20');

const LONG_MESSAGE = Array.from({ length: 260 }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ');

/** Every message in the "database": A has 2, B has 3, C none, D (outside most reports) 2. */
const ALL_MESSAGES: ReportDeliveryRow[] = [
  // A: one campaign message, one template send.
  { _id: 'a1', eventId: A._id, contactName: 'Alpha Campaign Guest', phoneNumber: '+919000000101',
    messageText: 'Hi, see you at Alpha Gala!', status: 'Delivered',
    sentAt: '2026-10-01T10:00:00.000Z', deliveredAt: '2026-10-01T10:00:05.000Z' },
  { _id: 'a2', eventId: A._id, contactName: 'Alpha Template Guest', phoneNumber: '+919000000102',
    templateName: 'event_document', status: 'Sent', sentAt: '2026-10-01T11:00:00.000Z' },
  // B: two template sends (one read, one failed) and a campaign message.
  { _id: 'b1', eventId: B._id, contactName: 'Beta Reader', phoneNumber: '+919000000201',
    templateName: 'event_image', status: 'Delivered', sentAt: '2026-10-02T09:00:00.000Z',
    deliveredAt: '2026-10-02T09:00:10.000Z', readAt: '2026-10-02T09:05:00.000Z' },
  { _id: 'b2', eventId: B._id, contactName: 'Beta Failed', phoneNumber: '+919000000202',
    templateName: 'event_image', status: 'Failed', errorCode: 131047, errorReason: 'Re-engagement message',
    failedAt: '2026-10-02T09:01:00.000Z' },
  { _id: 'b3', eventId: B._id, contactName: 'Beta Campaign Guest', phoneNumber: '+919000000203',
    messageText: 'Beta Expo opens at ten.', status: 'Pending' },
  // D: messages for an event a filtered report does not list.
  { _id: 'd1', eventId: D._id, contactName: 'Delta Outsider', phoneNumber: '+919000000401', templateName: 'event_image', status: 'Sent' },
  { _id: 'd2', eventId: D._id, contactName: 'Delta Outsider Two', phoneNumber: '+919000000402', messageText: 'Delta!', status: 'Sent' },
];

const NAMES = {
  A: ['Alpha Campaign Guest', 'Alpha Template Guest'],
  B: ['Beta Reader', 'Beta Failed', 'Beta Campaign Guest'],
  D: ['Delta Outsider', 'Delta Outsider Two'],
};

/**
 * The batch endpoint as the server answers it: only the messages of the ids
 * sent, newest first, paged, with the total. Records every request.
 */
const fakeEndpoint = (messages: ReportDeliveryRow[] = ALL_MESSAGES) => {
  const calls: Array<{ eventIds: string[]; page: number; limit: number }> = [];
  const getPage = async (eventIds: string[], page: number, limit: number) => {
    calls.push({ eventIds: [...eventIds], page, limit });
    const wanted = new Set(eventIds);
    const matching = messages.filter((m) => wanted.has(String(m.eventId)));
    return { logs: matching.slice((page - 1) * limit, page * limit), total: matching.length };
  };
  return { getPage, calls };
};

/** What the page does: the report's rows' ids, one batch read. */
const deliveryFor = async (events: any[], messages: ReportDeliveryRow[] = ALL_MESSAGES) => {
  const endpoint = fakeEndpoint(messages);
  const rows = await fetchReportDeliveryRows(events.map((e) => String(e._id)), endpoint.getPage);
  return { rows, calls: endpoint.calls };
};

const META = { searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31' };

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

/** The Delivery Log sheet's data rows (below its header row), as [Event ID, Event Name, Contact, ...]. */
const deliveryRowsOf = (sheet: any): string[][] => {
  const rows = textOf(sheet);
  const header = rows.findIndex((r) => r[0] === 'Event ID' && r[2] === 'Contact');
  assert.ok(header >= 0, 'the Delivery Log sheet has its header row');
  const data: string[][] = [];
  for (const row of rows.slice(header + 1)) {
    if (!row[0] || row[0].startsWith('Note ::')) break;
    data.push(row);
  }
  return data;
};

const metaOf = (sheet: any): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const row of textOf(sheet)) {
    if (row[0] === 'Event ID') break;
    if (row.length >= 2 && row[0]) out[row[0]] = row[1];
  }
  return out;
};

const pdfText = async (doc: any): Promise<{ text: string; pages: number }> => {
  const require = createRequire(import.meta.url);
  const pdfParse = require(require.resolve('pdf-parse', { paths: ['./backend', '.'] }));
  const parsed = await pdfParse(Buffer.from(doc.output('arraybuffer')));
  return { text: parsed.text, pages: parsed.numpages };
};

/**
 * The PDF text from one event's heading up to the next heading (or the end),
 * with line breaks read as spaces: a name or message wraps inside its cell.
 */
const sectionOf = (text: string, event: any): string => {
  const start = text.indexOf(`Event: ${reportEventLabel(event)}`);
  assert.ok(start >= 0, `the PDF has a heading for ${event.eventId}`);
  const next = text.indexOf('Event: EVT-', start + 1);
  return text.slice(start, next < 0 ? undefined : next).replace(/\s+/g, ' ');
};

const buildBoth = async (events: any[], messages: ReportDeliveryRow[] = ALL_MESSAGES) => {
  const { rows, calls } = await deliveryFor(events, messages);
  const workbook = await reopen(await buildEventReportWorkbook('Event Report', EVENT_COLUMNS, events, rows, META));
  const pdf = await pdfText(await buildEventReportPdf('Event Report', EVENT_COLUMNS, events, rows, META));
  return { workbook, pdf, rows, calls };
};

// ─── the batch read ──────────────────────────────────────────────────────────

test('the report\'s messages are read in one batch, never per event or per recipient', async (t) => {
  await t.test('three events, five messages: exactly one request, carrying all three ids', async () => {
    const { rows, calls } = await deliveryFor([A, B, C]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].eventIds, [A._id, B._id, C._id]);
    assert.equal(rows.length, 5);
  });

  await t.test('the request count does not grow with the number of events (no N+1)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => makeEvent(100 + i, `Event ${i}`, '2026-10-05'));
    const messages = many.flatMap((e, i) =>
      Array.from({ length: 3 }, (_, j) => ({ _id: `m${i}-${j}`, eventId: e._id, contactName: `G${i}-${j}` }))
    );
    const one = await deliveryFor([many[0]], messages);
    const sixty = await deliveryFor(many, messages);
    assert.equal(one.calls.length, 1);
    assert.equal(sixty.calls.length, 1, '60 events and 180 messages are still one request');
    assert.equal(sixty.rows.length, 180);
  });

  await t.test('nor with the number of recipients, until a page is full', async () => {
    const messages = Array.from({ length: 2500 }, (_, i) => ({ _id: `x${i}`, eventId: A._id, contactName: `G${i}` }));
    const { rows, calls } = await deliveryFor([A], messages);
    assert.equal(rows.length, 2500);
    assert.equal(calls.length, Math.ceil(2500 / REPORT_MESSAGES_PER_REQUEST), 'one request per 1000 messages');
    assert.ok(calls.every((c) => c.limit === REPORT_MESSAGES_PER_REQUEST));
  });

  await t.test('a report of more events than one request may name is sent in chunks of ids', async () => {
    const many = Array.from({ length: REPORT_EVENTS_PER_REQUEST + 5 }, (_, i) => ({ _id: `e${i}` }));
    const { calls } = await deliveryFor(many, []);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].eventIds.length, REPORT_EVENTS_PER_REQUEST);
    assert.equal(calls[1].eventIds.length, 5);
  });

  await t.test('an event listed twice is asked for once', async () => {
    const { calls } = await deliveryFor([A, A, B]);
    assert.deepEqual(calls[0].eventIds, [A._id, B._id]);
  });
});

test('messages are placed under their own event only', async (t) => {
  await t.test('A has 2, B has 3, C has none, in the report\'s order', () => {
    const groups = groupDeliveryByEvent([A, B, C], ALL_MESSAGES);
    assert.deepEqual(groups.map((g) => g.event.eventId), ['EVT-000001', 'EVT-000002', 'EVT-000003']);
    assert.deepEqual(groups.map((g) => g.logs.length), [2, 3, 0]);
  });

  await t.test('no A message is under B, and no B message is under A', () => {
    const [ga, gb] = groupDeliveryByEvent([A, B], ALL_MESSAGES);
    assert.ok(ga.logs.every((l) => l.eventId === A._id));
    assert.ok(gb.logs.every((l) => l.eventId === B._id));
  });

  await t.test('a row for an event the report does not list is dropped, not misplaced', () => {
    const groups = groupDeliveryByEvent([A], ALL_MESSAGES);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].logs.map((l) => l._id), ['a1', 'a2']);
  });
});

// ─── Excel ───────────────────────────────────────────────────────────────────

test('Excel: the Event Report sheet, then the Delivery Log sheet', async (t) => {
  const { workbook } = await buildBoth([A, B, C]);
  const [report, log] = workbook.worksheets;

  await t.test('two sheets, named Event Report and Delivery Log, in that order', () => {
    assert.deepEqual(workbook.worksheets.map((s: any) => s.name), ['Event Report', 'Delivery Log']);
  });

  await t.test('the Event Report sheet is exactly the sheet the report has always written', async () => {
    const before = await reopen(await buildReportWorkbook('Event Report', EVENT_COLUMNS, [A, B, C], META));
    assert.deepEqual(textOf(report), textOf(before.worksheets[0]));
    assert.ok(textOf(report).some((r) => r.join('|') === EVENT_COLUMNS.map((c) => c.header).join('|')),
      'with its nine event columns');
  });

  await t.test('the Delivery Log sheet has the twelve required columns, in order', () => {
    const expected = ['Event ID', 'Event Name', 'Contact', 'Phone', 'Template', 'Message', 'Status',
      'Accepted', 'Delivered', 'Read', 'Failed', 'Details'];
    assert.deepEqual(EVENT_REPORT_DELIVERY_COLUMNS.map((c) => c.header), expected);
    assert.ok(textOf(log).some((r) => r.join('|') === expected.join('|')));
  });

  await t.test('A has 2 rows, B has 3, C has none', () => {
    const rows = deliveryRowsOf(log);
    const count = (id: string) => rows.filter((r) => r[0] === id).length;
    assert.equal(rows.length, 5);
    assert.equal(count('EVT-000001'), 2);
    assert.equal(count('EVT-000002'), 3);
    assert.equal(count('EVT-000003'), 0);
  });

  await t.test('each recipient is on its own event\'s rows, never another\'s', () => {
    const rows = deliveryRowsOf(log);
    for (const row of rows) {
      const owner = NAMES.A.includes(row[2]) ? ['EVT-000001', 'Alpha Gala'] : ['EVT-000002', 'Beta Expo'];
      assert.deepEqual(row.slice(0, 2), owner, `${row[2]} is under ${owner[0]}`);
    }
    assert.deepEqual(rows.filter((r) => r[0] === 'EVT-000001').map((r) => r[2]).sort(), [...NAMES.A].sort());
    assert.deepEqual(rows.filter((r) => r[0] === 'EVT-000002').map((r) => r[2]).sort(), [...NAMES.B].sort());
  });

  await t.test('C\'s empty state is stated, without inventing a row for it', () => {
    const meta = metaOf(log);
    assert.equal(meta['Events'], '3');
    assert.equal(meta['Messages'], '5');
    assert.equal(meta['No Messages'], 'EVT-000003 — Gamma Quiet');
  });

  await t.test('every event of the report is accounted for on the Delivery Log sheet', () => {
    const rows = deliveryRowsOf(log);
    const meta = metaOf(log);
    for (const event of [A, B, C]) {
      assert.ok(rows.some((r) => r[0] === event.eventId) || meta['No Messages'].includes(event.eventId),
        `${event.eventId} is either in the rows or named as having none`);
    }
  });

  await t.test('the Delivery Log states the report\'s own filters', () => {
    const meta = metaOf(log);
    assert.equal(meta['Start Date'], '2026-10-01');
    assert.equal(meta['End Date'], '2026-10-31');
    assert.equal(meta['Search Value'], '-');
  });

  await t.test('a campaign message shows its text; a template send its template and a dash', () => {
    const rows = deliveryRowsOf(log);
    const by = (name: string) => rows.find((r) => r[2] === name)!;
    assert.equal(by('Alpha Campaign Guest')[5], 'Hi, see you at Alpha Gala!');
    assert.equal(by('Alpha Campaign Guest')[4], '-');
    assert.equal(by('Alpha Template Guest')[4], 'event_document');
    assert.equal(by('Alpha Template Guest')[5], '—');
  });

  await t.test('statuses and details are worded as the Delivery Log words them', () => {
    const rows = deliveryRowsOf(log);
    const by = (name: string) => rows.find((r) => r[2] === name)!;
    assert.equal(by('Beta Reader')[6], 'Read');
    assert.equal(by('Beta Failed')[6], 'Failed');
    assert.equal(by('Beta Failed')[11], '[131047] Re-engagement message');
    assert.equal(by('Beta Campaign Guest')[6], 'Waiting to be processed');
    assert.notEqual(by('Beta Failed')[10], '—', 'the failure time is filled');
  });

  await t.test('the filter row covers the header and the data only', () => {
    const rows = textOf(log);
    const header = rows.findIndex((r) => r[0] === 'Event ID' && r[2] === 'Contact') + 1;
    assert.equal(log.autoFilter, `A${header}:L${header + 5}`);
  });
});

test('Excel: one event, and events with and without messages', async (t) => {
  await t.test('one event with messages', async () => {
    const { workbook } = await buildBoth([B]);
    const rows = deliveryRowsOf(workbook.worksheets[1]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r[0] === 'EVT-000002'));
    assert.equal(metaOf(workbook.worksheets[1])['No Messages'], 'None');
  });

  await t.test('one event with no messages: an empty table, and it says so', async () => {
    const { workbook } = await buildBoth([C]);
    assert.deepEqual(workbook.worksheets.map((s: any) => s.name), ['Event Report', 'Delivery Log']);
    assert.equal(deliveryRowsOf(workbook.worksheets[1]).length, 0);
    const meta = metaOf(workbook.worksheets[1]);
    assert.equal(meta['Messages'], '0');
    assert.equal(meta['No Messages'], 'EVT-000003 — Gamma Quiet');
  });

  await t.test('several events, all with messages', async () => {
    const { workbook } = await buildBoth([A, B]);
    const rows = deliveryRowsOf(workbook.worksheets[1]);
    assert.deepEqual([...new Set(rows.map((r) => r[0]))], ['EVT-000001', 'EVT-000002']);
    assert.equal(rows.length, 5);
  });

  await t.test('campaign-only, template-only and mixed events side by side', async () => {
    const campaignOnly = makeEvent(5, 'Campaign Only', '2026-10-05');
    const templateOnly = makeEvent(6, 'Template Only', '2026-10-06');
    const messages: ReportDeliveryRow[] = [
      { _id: 'c1', eventId: campaignOnly._id, contactName: 'Camp One', messageText: 'Camp text', status: 'Sent' },
      { _id: 't1', eventId: templateOnly._id, contactName: 'Temp One', templateName: 'event_image', status: 'Sent' },
      ...ALL_MESSAGES.filter((m) => m.eventId === A._id),
    ];
    const { workbook } = await buildBoth([campaignOnly, templateOnly, A], messages);
    const rows = deliveryRowsOf(workbook.worksheets[1]);
    assert.deepEqual(rows.find((r) => r[2] === 'Camp One')!.slice(0, 2), ['EVT-000005', 'Campaign Only']);
    assert.equal(rows.find((r) => r[2] === 'Camp One')![5], 'Camp text');
    assert.deepEqual(rows.find((r) => r[2] === 'Temp One')!.slice(0, 2), ['EVT-000006', 'Template Only']);
    assert.equal(rows.find((r) => r[2] === 'Temp One')![4], 'event_image');
    assert.equal(rows.filter((r) => r[0] === 'EVT-000001').length, 2, 'the mixed event keeps both kinds');
  });

  await t.test('a long message is kept whole in its cell', async () => {
    const messages: ReportDeliveryRow[] = [{ _id: 'l1', eventId: A._id, contactName: 'Long', messageText: LONG_MESSAGE, status: 'Sent' }];
    const { workbook } = await buildBoth([A], messages);
    assert.equal(deliveryRowsOf(workbook.worksheets[1])[0][5], LONG_MESSAGE);
  });
});

// ─── PDF ─────────────────────────────────────────────────────────────────────

test('PDF: the Event Report, then a Delivery Log grouped by event', async (t) => {
  const { pdf } = await buildBoth([A, B, C]);
  const { text } = pdf;

  await t.test('the Event Report comes first, unchanged, then the Delivery Log section', async () => {
    const plain = (await pdfText(await buildReportPdf('Event Report', EVENT_COLUMNS, [A, B, C], META))).text;
    const logAt = text.indexOf('Delivery Log');
    assert.ok(text.indexOf('Event Report') < logAt, 'Event Report before the Delivery Log');
    assert.equal(text.slice(0, logAt).trim(), plain.trim(), 'the report part is the report as it always printed');
  });

  await t.test('every event of the report has its heading, in the report\'s order', () => {
    const at = [A, B, C].map((e) => text.indexOf(`Event: ${reportEventLabel(e)}`));
    assert.ok(at.every((i) => i > text.indexOf('Delivery Log')), 'all inside the Delivery Log section');
    assert.deepEqual([...at].sort((x, y) => x - y), at, 'A, then B, then C');
    assert.ok(text.includes('Event: EVT-000001 — Alpha Gala (2 messages)'));
    assert.ok(text.includes('Event: EVT-000002 — Beta Expo (3 messages)'));
    assert.ok(text.includes('Event: EVT-000003 — Gamma Quiet (0 messages)'));
  });

  await t.test('A\'s section holds A\'s 2 recipients and none of B\'s', () => {
    const section = sectionOf(text, A);
    for (const name of NAMES.A) assert.ok(section.includes(name), `${name} under A`);
    for (const name of NAMES.B) assert.equal(section.includes(name), false, `${name} not under A`);
  });

  await t.test('B\'s section holds B\'s 3 recipients and none of A\'s', () => {
    const section = sectionOf(text, B);
    for (const name of NAMES.B) assert.ok(section.includes(name), `${name} under B`);
    for (const name of NAMES.A) assert.equal(section.includes(name), false, `${name} not under B`);
  });

  await t.test('C\'s section says it has no messages, and holds no table', () => {
    const section = sectionOf(text, C);
    assert.ok(section.includes(NO_EVENT_MESSAGES));
    assert.equal(section.includes('Contact'), false);
  });

  await t.test('template and campaign content both appear', () => {
    assert.ok(sectionOf(text, A).includes('Hi, see you at Alpha Gala!'));
    assert.ok(sectionOf(text, A).includes('event_document'));
    assert.ok(sectionOf(text, B).includes('Re-engagement message'));
  });

  await t.test('no event outside the report appears', () => {
    for (const name of NAMES.D) assert.equal(text.includes(name), false);
    assert.equal(text.includes('EVT-000004'), false);
  });

  await t.test('the scope lines name the event with no messages', () => {
    assert.ok(text.includes('No MessagesEVT-000003 — Gamma Quiet'));
  });
});

test('PDF: long logs wrap and run onto further pages, nothing cut', async (t) => {
  await t.test('a long message wraps across lines with every word kept', async () => {
    const messages: ReportDeliveryRow[] = [{ _id: 'l1', eventId: A._id, contactName: 'Long', messageText: LONG_MESSAGE, status: 'Sent' }];
    const { pdf } = await buildBoth([A, B], messages);
    const joined = pdf.text.replace(/\s+/g, ' ');
    for (let i = 0; i < 260; i++) assert.ok(joined.includes(`word${String(i).padStart(3, '0')}`), `word${i} kept`);
    // Wrapped: the first and last words are not on the same printed line.
    const firstLine = pdf.text.split('\n').find((l) => l.includes('word000'))!;
    assert.equal(firstLine.includes('word259'), false);
  });

  await t.test('many messages across several events run onto several pages, all kept', async () => {
    const events = [A, B, C];
    const messages: ReportDeliveryRow[] = events.flatMap((e, k) =>
      Array.from({ length: 40 }, (_, i) => ({ _id: `${k}-${i}`, eventId: e._id, contactName: `Guest${k}x${i}`, status: 'Sent' }))
    );
    const { pdf } = await buildBoth(events, messages);
    assert.ok(pdf.pages >= 4, `expected several pages, got ${pdf.pages}`);
    for (const [k, e] of events.entries()) {
      const section = sectionOf(pdf.text, e);
      for (let i = 0; i < 40; i++) assert.ok(section.includes(`Guest${k}x${i}`), `Guest${k}x${i} under ${e.eventId}`);
    }
  });

  await t.test('one event with no messages still prints the report and the empty state', async () => {
    const { pdf } = await buildBoth([C]);
    assert.ok(pdf.text.includes('Delivery Log'));
    assert.ok(sectionOf(pdf.text, C).includes(NO_EVENT_MESSAGES));
  });
});

// ─── the generated report decides the events ─────────────────────────────────

test('the export follows the generated report\'s filters', async (t) => {
  const everything = [A, B, C, D];
  const filter = (searchValue: string, startDate: string, endDate: string, mode = 'EventName') =>
    filterReportRows(everything, EVENT_ACCESSORS, { mode, searchValue, startDate, endDate }, false);

  await t.test('a date range of 1-3 Oct lists A, B and C, and only their messages are read', async () => {
    const listed = filter('', '2026-10-01', '2026-10-03');
    assert.deepEqual(listed.map((e) => e.eventId), ['EVT-000001', 'EVT-000002', 'EVT-000003']);
    const { workbook, pdf, calls } = await buildBoth(listed);
    assert.deepEqual(calls[0].eventIds, [A._id, B._id, C._id], 'D is never asked for');
    const ids = new Set(deliveryRowsOf(workbook.worksheets[1]).map((r) => r[0]));
    assert.equal(ids.has('EVT-000004'), false);
    assert.equal(pdf.text.includes('Delta Outsider'), false);
  });

  await t.test('a search that narrows the report to one event exports that event\'s messages only', async () => {
    const listed = filter('EVT-000002', '2026-10-01', '2026-10-31');
    assert.deepEqual(listed.map((e) => e.eventId), ['EVT-000002']);
    const { workbook, pdf, calls } = await buildBoth(listed);
    assert.deepEqual(calls[0].eventIds, [B._id]);
    const rows = deliveryRowsOf(workbook.worksheets[1]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r[0] === 'EVT-000002'));
    for (const name of [...NAMES.A, ...NAMES.D]) assert.equal(pdf.text.includes(name), false);
  });

  await t.test('a search by name works the same way', async () => {
    const listed = filter('alpha', '2026-10-01', '2026-10-31');
    const { workbook } = await buildBoth(listed);
    assert.deepEqual(deliveryRowsOf(workbook.worksheets[1]).map((r) => r[2]).sort(), [...NAMES.A].sort());
  });

  await t.test('the Delivery Log restates the filters it was generated with', () => {
    const groups = groupDeliveryByEvent([B], ALL_MESSAGES);
    const meta = buildReportDeliveryMeta(groups, { searchValue: 'EVT-000002', startDate: '2026-10-01', endDate: '2026-10-31' });
    assert.deepEqual(meta.rows!.slice(0, 3), [
      ['Search Value', 'EVT-000002'], ['Start Date', '2026-10-01'], ['End Date', '2026-10-31'],
    ]);
  });
});

// ─── the page wiring ─────────────────────────────────────────────────────────

test('Reports.tsx: the Event Report buttons export the report\'s events and their log', async (t) => {
  const exportFn = reportsSource.slice(
    reportsSource.indexOf('const runExport = useCallback('),
    reportsSource.indexOf('const viewedEvent')
  );

  await t.test('the test fixtures mirror the real Event Report definition', () => {
    for (const column of EVENT_COLUMNS) assert.ok(reportsSource.includes(`header: '${column.header}'`));
    assert.ok(reportsSource.includes('text: (row) => `${value(row.eventId)} ${value(row.eventName)}`'));
    assert.ok(reportsSource.includes('date: (row) => row.eventDate,'));
  });

  await t.test('the event branch reads the log from the batch endpoint, once', () => {
    assert.ok(exportFn.includes("if (activeReport === 'event') {"));
    assert.equal((reportsSource.match(/\/reports\/events\/delivery-log/g) || []).length, 1);
    assert.ok(exportFn.includes("api.post('/reports/events/delivery-log', { eventIds, page, limit })"));
  });

  await t.test('the events are the generated report\'s rows - not the event View has open', () => {
    assert.ok(exportFn.includes('filteredRows.map((row: any) => String(row._id))'));
    assert.ok(exportFn.includes('await write(name, definition.label, definition.columns, filteredRows, deliveryRows, meta);'));
    assert.equal(exportFn.includes('selectedEventId'), false);
    assert.equal(exportFn.includes('viewedEvent'), false);
  });

  await t.test('the request is not made inside a loop over the events (no N+1)', () => {
    const call = exportFn.indexOf("api.post('/reports/events/delivery-log'");
    const before = exportFn.slice(0, call);
    assert.equal(/for \(|\.forEach\(|filteredRows\.map\(\s*async/.test(before.slice(before.indexOf("if (activeReport === 'event')"))), false);
    assert.ok(before.includes('fetchReportDeliveryRows('), 'only through the batch reader');
  });

  await t.test('the other reports export exactly as before', () => {
    assert.ok(exportFn.includes('await exportToExcel(name, definition.label, definition.columns, filteredRows, meta);'));
    assert.ok(exportFn.includes('await exportToPdf(name, definition.label, definition.columns, filteredRows, meta);'));
  });

  // Where the log is rendered (inside View only) is asserted in eventDeliveryLog.test.ts.
  await t.test('the View page keeps its own one-event export and its one log', () => {
    assert.ok(reportsSource.includes('<EventDeliveryExport'));
    assert.equal((reportsSource.match(/<EventDeliveryLog/g) || []).length, 1);
  });
});
