/**
 * The Delivery Log download from an event's View page.
 *
 * The writers are run for real: workbooks are written to a buffer and read
 * back, and PDFs are parsed back to text, so these assert what a downloaded
 * file actually contains. The page wiring, which needs a mounted React tree,
 * is asserted from source at the end.
 *
 * Run: npx tsx --test frontend/src/utils/eventDeliveryExport.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'node:module';
import {
  fetchAllDeliveryRows,
  buildEventDeliveryDetails,
  buildEventDeliveryWorkbook,
  buildEventDeliveryPdf,
  eventDeliveryFileName,
  EXPORT_PAGE_SIZE,
} from './eventDeliveryExport.ts';
import { EVENT_DELIVERY_EXPORT_COLUMNS, type DeliveryLogRow } from './deliveryLogReport.ts';
import { buildMetaRows } from './reportExport.ts';

// Normalised so the anchors below hold on a CRLF checkout as well as an LF one.
const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

/** What the View page hands in: the Event Report table's columns for one event. */
const EVENT: Array<[string, string]> = [
  ['Event ID', 'EVT-000007'],
  ['Event Name', 'College Party'],
  ['Event Type', 'Party'],
  ['Organizer', 'Akshat Singh'],
  ['Mobile', '9112472833'],
  ['Date', '31 Oct 2026'],
  ['Time', '10:00'],
  ['Venue', 'Ausa Maharashtra'],
  ['Status', 'Upcoming'],
];

const LONG_MESSAGE = Array.from({ length: 220 }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ');

/** A template send (no message text, a template name) and a campaign send (text, no template). */
const ROWS: DeliveryLogRow[] = [
  {
    _id: 't1',
    contactName: 'Aditya Shankar Kshirsagar',
    phoneNumber: '+919112472833',
    templateName: 'event_document',
    status: 'Delivered',
    sentAt: '2026-10-03T16:55:43.000Z',
    deliveredAt: '2026-10-03T16:55:53.000Z',
    readAt: '2026-10-03T16:56:10.000Z',
  },
  {
    _id: 'c1',
    contactId: { fullName: 'Shubham Suryavanshi', phoneNumber: '+918530808862' },
    phoneNumber: '+918530808862',
    messageText: 'Hi Shubham, see you at College Party!',
    status: 'Sent',
    sentAt: '2026-10-03T16:55:43.000Z',
  },
  {
    _id: 'f1',
    contactName: 'Swapnil Mudgade',
    phoneNumber: '+918766813161',
    templateName: 'event_image',
    status: 'Failed',
    errorCode: 131047,
    errorReason: 'Re-engagement message',
    failedAt: '2026-10-03T16:55:45.000Z',
  },
];

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

const pdfText = async (doc: any): Promise<{ text: string; pages: number }> => {
  const require = createRequire(import.meta.url);
  const pdfParse = require(require.resolve('pdf-parse', { paths: ['./backend', '.'] }));
  const parsed = await pdfParse(Buffer.from(doc.output('arraybuffer')));
  return { text: parsed.text, pages: parsed.numpages };
};

const WHEN = new Date('2026-10-04T06:30:00.000Z');

test('every message of the event is read, not just the page on screen', async (t) => {
  /** A fake endpoint over `count` rows, recording each request. */
  const endpoint = (count: number) => {
    const all = Array.from({ length: count }, (_, i) => ({ _id: `m${i}`, contactName: `Guest ${i}` }));
    const calls: Array<[number, number]> = [];
    const getPage = async (page: number, limit: number) => {
      calls.push([page, limit]);
      return { logs: all.slice((page - 1) * limit, page * limit), total: all.length };
    };
    return { getPage, calls };
  };

  await t.test('a small event is one request', async () => {
    const { getPage, calls } = endpoint(3);
    const rows = await fetchAllDeliveryRows(getPage);
    assert.equal(rows.length, 3);
    assert.deepEqual(calls, [[1, EXPORT_PAGE_SIZE]]);
  });

  await t.test('a large event is read page by page until all of it is held', async () => {
    const { getPage, calls } = endpoint(1203);
    const rows = await fetchAllDeliveryRows(getPage);
    assert.equal(rows.length, 1203, 'well past the 200 the table shows');
    assert.equal(calls.length, 3, 'one request per 500, never one per message');
    assert.equal(new Set(rows.map((r) => r._id)).size, 1203, 'no row twice');
  });

  await t.test('an event with no messages yields nothing, after one request', async () => {
    const { getPage, calls } = endpoint(0);
    assert.deepEqual(await fetchAllDeliveryRows(getPage), []);
    assert.equal(calls.length, 1);
  });

  await t.test('a total that shrinks mid-read cannot spin forever', async () => {
    let n = 0;
    const rows = await fetchAllDeliveryRows(async () => {
      n += 1;
      return { logs: n === 1 ? [{ _id: 'a' }] : [], total: 999 };
    });
    assert.equal(rows.length, 1);
    assert.equal(n, 2, 'it stopped at the first empty page');
  });

  await t.test('a row that moved onto the next page is counted once', async () => {
    const pages = [[{ _id: 'a' }, { _id: 'b' }], [{ _id: 'b' }, { _id: 'c' }]];
    const rows = await fetchAllDeliveryRows(async (page) => ({ logs: pages[page - 1] ?? [], total: 4 }), 2);
    assert.deepEqual(rows.map((r) => r._id), ['a', 'b', 'c']);
  });

  await t.test('and there is a hard ceiling on requests', async () => {
    let n = 0;
    await fetchAllDeliveryRows(async (page) => {
      n += 1;
      return { logs: [{ _id: `p${page}` }], total: Number.MAX_SAFE_INTEGER };
    }, 1, 5);
    assert.equal(n, 5);
  });
});

test('the event details the document carries', async (t) => {
  const details = buildEventDeliveryDetails(EVENT, ROWS, WHEN);

  await t.test('the event, worded as the Event Report table words it', () => {
    assert.deepEqual(details.slice(0, EVENT.length), EVENT);
  });

  await t.test('then how many messages it covers', () => {
    assert.deepEqual(details.find(([k]) => k === 'Messages'), ['Messages', '3']);
  });

  await t.test('and when it was made', () => {
    assert.ok(details.find(([k]) => k === 'Generated On')?.[1].includes('2026'));
  });

  await t.test('the file is named for the event', () => {
    assert.match(eventDeliveryFileName('EVT-000007', WHEN), /^DeliveryLog_EVT000007_\d{8}$/);
  });
});

test('Excel: the event on one sheet, its messages on the next', async (t) => {
  const book = await reopen(await buildEventDeliveryWorkbook(EVENT, ROWS, WHEN));
  const [detailsSheet, logSheet] = book.worksheets;
  const details = textOf(detailsSheet);
  const log = textOf(logSheet);
  const headerAt = log.findIndex((row) => row[0] === 'Contact');

  await t.test('two sheets, named for what they hold', () => {
    assert.equal(book.worksheets.length, 2);
    assert.equal(detailsSheet.name, 'Event Details');
    assert.equal(logSheet.name, 'Delivery Log');
  });

  await t.test('the first sheet carries every event field and the message count', () => {
    for (const [label, value] of EVENT) {
      assert.ok(details.some((row) => row[0] === label && row[1] === value), `${label} = ${value}`);
    }
    assert.ok(details.some((row) => row[0] === 'Messages' && row[1] === '3'));
  });

  await t.test('the second sheet has the log\'s columns plus what was sent', () => {
    assert.deepEqual(log[headerAt], [
      'Contact', 'Phone', 'Template', 'Message', 'Status', 'Accepted', 'Delivered', 'Read', 'Failed', 'Details',
    ]);
  });

  await t.test('every message is a row, and only the messages handed in', () => {
    const data = log.slice(headerAt + 1, headerAt + 1 + ROWS.length);
    assert.deepEqual(data.map((r) => r[0]), ['Aditya Shankar Kshirsagar', 'Shubham Suryavanshi', 'Swapnil Mudgade']);
    assert.equal(log[headerAt + 1 + ROWS.length]?.[0] ?? '', '', 'nothing after the last message but the notes');
  });

  await t.test('a template send names its template and has no invented text', () => {
    const row = log.find((r) => r[0] === 'Aditya Shankar Kshirsagar')!;
    assert.equal(row[2], 'event_document');
    assert.equal(row[3], '—', 'Meta renders a template; this system never had its words');
    assert.equal(row[4], 'Read');
    assert.equal(row[9], 'Opened by recipient');
  });

  await t.test('a campaign send carries the text it sent', () => {
    const row = log.find((r) => r[0] === 'Shubham Suryavanshi')!;
    assert.equal(row[2], '-');
    assert.equal(row[3], 'Hi Shubham, see you at College Party!');
    assert.equal(row[4], 'Accepted by WhatsApp');
    assert.equal(row[6], '—', 'a delivery that has not happened is a dash');
  });

  await t.test('a failure keeps its reason', () => {
    const row = log.find((r) => r[0] === 'Swapnil Mudgade')!;
    assert.equal(row[4], 'Failed');
    assert.equal(row[9], '[131047] Re-engagement message');
  });

  await t.test('the message sheet keeps the report conventions: filter, frozen headings', () => {
    assert.equal(String(logSheet.autoFilter), `A${headerAt + 1}:J${headerAt + 1 + ROWS.length}`);
    assert.equal(logSheet.views[0].state, 'frozen');
    assert.equal(logSheet.views[0].ySplit, headerAt + 1);
  });

  await t.test('it states its event in place of a search value and dates', () => {
    assert.ok(log.some((r) => r[0] === 'Event' && r[1] === 'EVT-000007 | College Party'));
    assert.equal(log.some((r) => r[0] === 'Search Value'), false);
  });

  await t.test('a long message is kept whole in its cell', async () => {
    const long = await reopen(await buildEventDeliveryWorkbook(EVENT, [{ ...ROWS[1], messageText: LONG_MESSAGE }], WHEN));
    assert.ok(textOf(long.worksheets[1]).some((r) => r[3] === LONG_MESSAGE));
  });
});

test('PDF: the event, then every message, nothing cut short', async (t) => {
  const { text } = await pdfText(await buildEventDeliveryPdf(EVENT, ROWS, WHEN));
  const flat = text.replace(/\s+/g, '');

  await t.test('it carries the event\'s details', () => {
    for (const [label, value] of EVENT) {
      assert.ok(flat.includes(label.replace(/\s+/g, '')), `${label} label`);
      assert.ok(flat.includes(value.replace(/\s+/g, '')), `${label} value`);
    }
  });

  await t.test('every recipient, phone, status and detail is in it', () => {
    for (const s of ['AdityaShankarKshirsagar', '+919112472833', 'ShubhamSuryavanshi', 'SwapnilMudgade',
      'event_document', 'event_image', 'Openedbyrecipient', '[131047]Re-engagementmessage']) {
      assert.ok(flat.includes(s), `${s} present`);
    }
  });

  await t.test('the campaign message text is in it', () => {
    assert.ok(flat.includes('HiShubham,seeyouatCollegeParty!'));
  });

  await t.test('a phone number and a template name are each drawn unbroken', async () => {
    // pdf-parse rejoins words, so this reads the text fragments the PDF actually
    // draws: a number split across two lines is two fragments. Seen in the
    // browser before the widths were rebalanced: "+91966666" then "6666".
    const doc = await buildEventDeliveryPdf(EVENT, ROWS, WHEN);
    const raw = doc.output();
    const drawn = [...raw.matchAll(/\(([^)]*)\)\s*Tj/g)].map((m: any) => m[1]);
    for (const token of ['+919112472833', '+918530808862', 'event_document', 'event_image']) {
      assert.ok(drawn.includes(token), `${token} is one fragment, not split across lines`);
    }
  });

  await t.test('a very long message wraps over pages and is never truncated', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...ROWS[1], _id: `l${i}`, messageText: `${LONG_MESSAGE} end${i}` }));
    const doc = await pdfText(await buildEventDeliveryPdf(EVENT, many, WHEN));
    const all = doc.text.replace(/\s+/g, '');
    assert.ok(doc.pages > 1, `it ran onto ${doc.pages} pages`);
    for (let i = 0; i < 220; i += 37) {
      assert.ok(all.includes(`word${String(i).padStart(3, '0')}`), `word ${i} is there`);
    }
    for (let i = 0; i < 12; i++) assert.ok(all.includes(`end${i}`), `the end of message ${i} is there`);
  });

  await t.test('a very long venue wraps rather than running off the page', async () => {
    const venue = 'Ausa Maharashtra ' + Array.from({ length: 40 }, (_, i) => `block${i}`).join(' ');
    const longEvent = EVENT.map(([k, v]) => [k, k === 'Venue' ? venue : v] as [string, string]);
    const doc = await pdfText(await buildEventDeliveryPdf(longEvent, ROWS, WHEN));
    // Presence alone proves nothing: jsPDF keeps text that runs off the page in
    // the file, so an unwrapped venue would still "contain" its last word. What
    // shows it was wrapped is that it was broken onto separate lines.
    const lines = doc.text.split('\n');
    const first = lines.find((line) => line.includes('block0'));
    assert.ok(first, 'the venue is printed');
    assert.equal(first!.includes('block39'), false, 'it did not stay on one line running off the page');
    assert.ok(lines.some((line) => line.includes('block39')), 'and the last of it is on a later line');
  });
});

test('the export columns are the Delivery Log\'s, plus what was sent', () => {
  assert.deepEqual(
    EVENT_DELIVERY_EXPORT_COLUMNS.map((c) => c.header),
    ['Contact', 'Phone', 'Template', 'Message', 'Status', 'Accepted', 'Delivered', 'Read', 'Failed', 'Details']
  );
});

test('the existing report exports are unchanged', async (t) => {
  await t.test('a search report still prints its three filter lines', () => {
    assert.deepEqual(buildMetaRows({ searchValue: 'college', startDate: '2026-10-01', endDate: '2026-10-02' }), [
      ['Search Value', 'college'], ['Start Date', '2026-10-01'], ['End Date', '2026-10-02'],
    ]);
    assert.deepEqual(buildMetaRows({}), [['Search Value', '-'], ['Start Date', '-'], ['End Date', '-']]);
  });

  await t.test('the campaign view\'s downloads are untouched', () => {
    const campaign = read('frontend/src/pages/Campaigns/CampaignReport.tsx');
    assert.ok(campaign.includes('const handleDownloadExcel'));
    assert.ok(campaign.includes('const handleDownloadPDF'));
    assert.equal(campaign.includes('EventDeliveryExport'), false, 'it keeps its own downloads');
  });
});

test('the View page wiring', async (t) => {
  const reports = read('frontend/src/pages/Reports.tsx');
  const button = read('frontend/src/components/ui/EventDeliveryExport.tsx');
  const log = read('frontend/src/components/ui/EventDeliveryLog.tsx');
  const table = read('frontend/src/components/ui/DeliveryLogTable.tsx');

  const drillStart = reports.indexOf("{activeReport === 'event' && selectedEventId ? (");
  const drill = reports.slice(drillStart, reports.indexOf('<div className="glass-panel rounded-2xl p-6', drillStart));
  const tableBranch = reports.slice(reports.indexOf('<div className="glass-panel rounded-2xl p-6', drillStart));

  await t.test('the downloads are on the no-campaign View, beside its heading', () => {
    assert.ok(drill.includes('<EventDeliveryExport'));
    const exportAt = drill.indexOf('<EventDeliveryExport');
    assert.ok(exportAt > drill.indexOf(') : campaignId ? ('), 'only in the branch without a campaign');
    assert.ok(exportAt < drill.indexOf('<EventDeliveryLog'), 'above the log, not inside it');
  });

  await t.test('never on the Event Report table itself', () => {
    assert.equal(tableBranch.includes('EventDeliveryExport'), false);
    assert.equal(tableBranch.includes('EventDeliveryLog'), false);
  });

  await t.test('they fetch only the viewed event\'s log', () => {
    assert.ok(button.includes('/reports/event/${eventId}/delivery-log'));
    assert.ok(drill.includes('eventId={String(selectedEventId)}'));
    assert.equal((button.match(/api\.get\(/g) || []).length, 1, 'one call site, paged by the helper');
  });

  await t.test('with no messages there is nothing to press, and nothing is generated', () => {
    assert.ok(button.includes('const unavailable = hasMessages !== true;'));
    assert.ok(button.includes('disabled={unavailable || busy !== null}'));
    assert.ok(button.includes("if (rows.length === 0) {"), 'checked again at the moment of download');
    assert.ok(button.includes('no messages to export'));
  });

  await t.test('the button state comes from the log\'s unfiltered count, with no extra request', () => {
    assert.ok(drill.includes('onAllTotal={setViewedEventMessages}'));
    assert.ok(log.includes("if (statusFilter === 'All') onAllTotalRef.current?.("), 'a filtered count is not "no messages"');
    assert.ok(reports.includes('setViewedEventMessages(null);'), 'a newly opened event starts unknown');
  });

  await t.test('the document describes the event with the Event Report\'s own columns', () => {
    assert.ok(reports.includes('REPORTS.event.columns.map((column) => [column.header, String(column.value(viewedEvent))]'));
  });

  await t.test('the Delivery Log itself is unchanged', () => {
    assert.equal(table.includes('Export') || table.includes('Excel'), false, 'no download inside the log');
    assert.ok(log.includes('<DeliveryLogTable'));
  });
});
