import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'node:module';
import {
  buildReportWorkbook,
  buildReportPdf,
  buildMetaRows,
  REPORT_NOTE,
  REPORT_CREDIT,
  type ReportColumn,
} from './reportExport.ts';
import {
  DELIVERY_LOG_COLUMNS,
  describeDeliveryLog,
  describeDeliveryDetail,
} from './deliveryLogReport.ts';

/**
 * The Event Report's shape, checked against a workbook this actually builds —
 * cell by cell, including the fonts, fills and borders. ExcelJS runs happily
 * in node; only the download step needs a browser, which is why it lives
 * outside buildReportWorkbook.
 *
 * The PDF writer shares the title, the filter rows and the two footer lines
 * with this one, so those are covered here; the parts that only exist inside
 * jsPDF are asserted from the source at the end.
 */

interface EventRow {
  eventId: string;
  eventName: string;
  eventType: string;
  organizerName: string;
  organizerMobile: string;
  eventDate: string;
  eventTime: string;
  eventVenue: string;
  eventStatus: string;
}

/** The nine columns, in the order the reference file fixes them. */
const COLUMNS: ReportColumn<EventRow>[] = [
  { header: 'Event ID', value: (r) => r.eventId },
  { header: 'Event Name', value: (r) => r.eventName },
  { header: 'Event Type', value: (r) => r.eventType },
  { header: 'Organizer', value: (r) => r.organizerName },
  { header: 'Mobile', value: (r) => r.organizerMobile },
  { header: 'Date', value: (r) => r.eventDate },
  { header: 'Time', value: (r) => r.eventTime },
  { header: 'Venue', value: (r) => r.eventVenue },
  { header: 'Status', value: (r) => r.eventStatus },
];

const ROWS: EventRow[] = [
  {
    eventId: 'EVT-000001',
    eventName: 'Anniverserry',
    eventType: 'Party',
    organizerName: 'Sam Mudgade',
    organizerMobile: '9112477076',
    eventDate: '10 Oct 2026',
    eventTime: '21:39',
    eventVenue: 'Ausa',
    eventStatus: 'Upcoming',
  },
];

const META = { searchValue: 'EVT-39759394', startDate: '2026-09-16', endDate: '2026-09-16' };

const build = () => buildReportWorkbook('Event Report', COLUMNS, ROWS, META);
/** Every cell's text, row by row, for the assertions that scan the sheet. */
const textOf = (sheet: any): string[][] => {
  const out: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row: any) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell: any) => cells.push(String(cell.value ?? '')));
    out.push(cells);
  });
  return out;
};

test('Event Report — Excel', async (t) => {
  const workbook = await build();
  const sheet = workbook.worksheets[0];
  const grid = textOf(sheet);
  const flat = grid.map((r) => r.join('|'));

  await t.test('the report states its own name', () => {
    assert.equal(grid[0][0], 'Event Report');
    assert.equal(sheet.getRow(1).font.bold, true, 'the title is bold');
  });

  await t.test('the filters it was generated from are in the report', () => {
    const find = (label: string) => grid.find((row) => row[0] === label);
    assert.deepEqual(find('Search Value')?.slice(0, 2), ['Search Value', 'EVT-39759394']);
    assert.deepEqual(find('Start Date')?.slice(0, 2), ['Start Date', '2026-09-16']);
    assert.deepEqual(find('End Date')?.slice(0, 2), ['End Date', '2026-09-16']);
  });

  await t.test('an empty filter still appears, as a dash', () => {
    assert.deepEqual(buildMetaRows({}), [
      ['Search Value', '-'],
      ['Start Date', '-'],
      ['End Date', '-'],
    ]);
    assert.deepEqual(buildMetaRows({ searchValue: '   ' })[0], ['Search Value', '-']);
  });

  await t.test('the nine columns appear in exactly the required order', () => {
    const headerIndex = grid.findIndex((row) => row[0] === 'Event ID');
    assert.ok(headerIndex > 0, 'there is a heading row');
    assert.deepEqual(grid[headerIndex].slice(0, 9), [
      'Event ID',
      'Event Name',
      'Event Type',
      'Organizer',
      'Mobile',
      'Date',
      'Time',
      'Venue',
      'Status',
    ]);
  });

  await t.test('the headings are bold and highlighted', () => {
    const headerIndex = grid.findIndex((row) => row[0] === 'Event ID');
    const headerRow = sheet.getRow(headerIndex + 1);
    assert.equal(headerRow.font.bold, true, 'bold');
    headerRow.eachCell((cell: any) => {
      assert.equal(cell.fill?.type, 'pattern', 'highlighted with a solid fill');
      assert.equal(cell.fill?.fgColor?.argb, 'FFD9E1F2');
    });
  });

  await t.test('every table cell is bordered on all four sides', () => {
    const headerIndex = grid.findIndex((row) => row[0] === 'Event ID');
    for (const rowNumber of [headerIndex + 1, headerIndex + 2]) {
      const row = sheet.getRow(rowNumber);
      row.eachCell((cell: any) => {
        for (const side of ['top', 'left', 'bottom', 'right']) {
          assert.equal(cell.border?.[side]?.style, 'thin', `${side} border on row ${rowNumber}`);
        }
      });
    }
  });

  await t.test('the data row carries the event values in column order', () => {
    const dataRow = grid.find((row) => row[0] === 'EVT-000001');
    assert.deepEqual(dataRow?.slice(0, 9), [
      'EVT-000001',
      'Anniverserry',
      'Party',
      'Sam Mudgade',
      '9112477076',
      '10 Oct 2026',
      '21:39',
      'Ausa',
      'Upcoming',
    ]);
  });

  await t.test('Date and Time stay separate columns', () => {
    const headerIndex = grid.findIndex((row) => row[0] === 'Event ID');
    assert.equal(grid[headerIndex][5], 'Date');
    assert.equal(grid[headerIndex][6], 'Time');
  });

  await t.test('both standing notes are at the foot of the report', () => {
    assert.ok(flat.some((row) => row.startsWith(REPORT_NOTE)), REPORT_NOTE);
    assert.ok(flat.some((row) => row.startsWith(REPORT_CREDIT)), REPORT_CREDIT);
    assert.equal(REPORT_NOTE, 'Note :: This report is system generated');
    assert.equal(REPORT_CREDIT, 'Designed & developed by SmartStack Soft Solutions');
  });

  await t.test('the notes come after the data, not before it', () => {
    const dataIndex = flat.findIndex((row) => row.startsWith('EVT-000001'));
    const noteIndex = flat.findIndex((row) => row.startsWith(REPORT_NOTE));
    assert.ok(noteIndex > dataIndex, 'the note follows the table');
  });

  await t.test('only the rows handed in are written — no export fetches its own', async () => {
    const empty = await buildReportWorkbook('Event Report', COLUMNS, [], META);
    const rows = textOf(empty.worksheets[0]).filter((row) => row[0]?.startsWith('EVT-'));
    assert.equal(rows.length, 0, 'an empty filtered set exports an empty table');
  });
});

/**
 * The PDF is built and read back, so these assert what the document actually
 * says rather than what its source looks like. pdf-parse is resolved from the
 * backend's dependencies — the one copy this repository already has.
 */
const readPdfText = async (doc: any): Promise<string> => {
  const require = createRequire(import.meta.url);
  const pdfParse = require(require.resolve('pdf-parse', { paths: ['./backend', '.'] }));
  const parsed = await pdfParse(Buffer.from(doc.output('arraybuffer')));
  return parsed.text;
};

test('Event Report — PDF content', async (t) => {
  const doc = await buildReportPdf('Event Report', COLUMNS, ROWS, META);
  const text = await readPdfText(doc);
  // pdf-parse runs words together, so the assertions strip spaces.
  const flat = text.replace(/\s+/g, '');

  await t.test('the report states its own name', () => {
    assert.match(text, /Event Report/);
  });

  await t.test('it carries the same three filters as the Excel report', () => {
    assert.match(flat, /SearchValueEVT-39759394/);
    assert.match(flat, /StartDate2026-09-16/);
    assert.match(flat, /EndDate2026-09-16/);
  });

  await t.test('all nine columns are present, in order', () => {
    const headers = ['Event ID', 'Event Name', 'Event Type', 'Organizer', 'Mobile', 'Date', 'Time', 'Venue', 'Status'];
    let cursor = -1;
    for (const header of headers) {
      const at = flat.indexOf(header.replace(/\s+/g, ''), cursor + 1);
      assert.ok(at > cursor, `${header} must appear after the previous column`);
      cursor = at;
    }
  });

  await t.test('the row values are the ones handed in', () => {
    assert.match(flat, /EVT-000001/);
    assert.match(flat, /SamMudgade/);
    assert.match(flat, /9112477076/);
    assert.match(flat, /Upcoming/);
  });

  await t.test('Date, Mobile and Status survive a row with long text beside them', async () => {
    // Long names and venues are what squeeze the narrow columns. Without fixed
    // widths the date wraps to "10 Oct" / "2026" and the report reads badly.
    const crowded = {
      ...ROWS[0],
      eventName: 'Anniversary Celebration For The Whole Extended Family',
      organizerName: 'Sam Mudgade Kshirsagar Suryavanshi',
      eventVenue: 'Grand Palace Convention Centre, Kothrud, Pune 411038',
    };
    const doc = await buildReportPdf('Event Report', COLUMNS, [crowded], META);
    const crowdedText = await readPdfText(doc);

    assert.match(crowdedText, /10 Oct 2026/, 'the date stays on one line');
    assert.match(crowdedText, /9112477076/, 'the mobile is not split');
    assert.match(crowdedText, /Upcoming/, 'the status is not clipped');
    assert.match(crowdedText, /21:39/, 'the time is not split');
  });

  await t.test('both standing notes are in the document', () => {
    assert.match(text, /Note :: This report is system generated/);
    assert.match(text, /Designed & developed by SmartStack Soft Solutions/);
  });

  await t.test('nothing from the Campaign Delivery Report leaks in', () => {
    for (const field of ['Campaign Delivery', 'Message Content', 'Contact Name', 'Failure']) {
      assert.ok(!text.includes(field), `${field} belongs to the campaign report, not this one`);
    }
  });

  await t.test('it is landscape, so nine columns fit across the page', () => {
    const { width, height } = doc.internal.pageSize;
    assert.ok(width > height, `expected landscape, got ${width}x${height}`);
  });

  await t.test('a long value wraps instead of running over the border', async () => {
    const longRow = { ...ROWS[0], eventVenue: 'Grand Palace Convention Centre, Kothrud, Pune 411038' };
    const wide = await buildReportPdf('Event Report', COLUMNS, [longRow], META);
    const wrapped = await readPdfText(wide);
    assert.match(wrapped.replace(/\s+/g, ''), /GrandPalaceConventionCentre,Kothrud,Pune411038/);
    assert.equal(wide.internal.getNumberOfPages(), 1, 'wrapping must not spill onto another page');
  });

  await t.test('a long report repeats the headings and the notes on every page', async () => {
    const many = Array.from({ length: 60 }, () => ROWS[0]);
    const long = await buildReportPdf('Event Report', COLUMNS, many, META);
    const pages = long.internal.getNumberOfPages();
    assert.ok(pages > 1, `expected a multi-page report, got ${pages}`);

    const longText = await readPdfText(long);
    const headings = (longText.match(/Event ID/g) ?? []).length;
    const notes = (longText.match(/Note :: This report is system generated/g) ?? []).length;
    assert.equal(headings, pages, 'the heading row repeats on every page');
    assert.equal(notes, pages, 'the note appears on every page');
  });

  await t.test('only the rows handed in are written', async () => {
    const empty = await buildReportPdf('Event Report', COLUMNS, [], META);
    const emptyText = await readPdfText(empty);
    assert.ok(!emptyText.includes('EVT-000001'), 'an empty filtered set prints no rows');
    assert.match(emptyText, /Event Report/, 'but still prints the report itself');
  });
});

test('Event Report — PDF styling', async (t) => {
  // Fills, bold and line widths do not survive text extraction, so these few
  // are read from the builder's source. Everything the document *says* is
  // asserted against the rendered PDF above.
  const source = fs.readFileSync('frontend/src/utils/reportExport.ts', 'utf-8');
  const builder = source.slice(source.indexOf('export const buildReportPdf'), source.indexOf('export const exportToPdf'));

  await t.test('the heading row is bold and highlighted, matching the Excel fill', () => {
    assert.ok(builder.includes("fontStyle: 'bold'"), 'bold headings');
    assert.ok(builder.includes('fillColor: [217, 225, 242]'), 'the same fill the workbook uses');
  });

  await t.test('every cell is bordered', () => {
    assert.ok(builder.includes("theme: 'grid'"), "autotable's grid theme draws all four sides");
    assert.ok(builder.includes('lineWidth: 0.1'), 'with a visible line width');
  });

  await t.test('long values are set to wrap', () => {
    assert.ok(builder.includes("overflow: 'linebreak'"));
  });

  await t.test('headings repeat and rows are kept whole across pages', () => {
    assert.ok(builder.includes("showHead: 'everyPage'"));
    assert.ok(builder.includes("rowPageBreak: 'avoid'"));
  });

  await t.test('it never loads its own data', () => {
    assert.ok(builder.includes('body: rows.map'), 'the body comes from the rows argument');
    assert.ok(!/fetch\(|axios|api\./.test(builder), 'no export may query for rows');
  });
});

test('the Event Report definition itself fixes the nine columns, in order', () => {
  // The order above is this test's own array; this is the one the application
  // actually exports with.
  const page = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8');
  const eventBlock = page.slice(page.indexOf("key: 'event'"), page.indexOf("key: 'access'"));
  const headers = [...eventBlock.matchAll(/header: '([^']+)'/g)].map((m) => m[1]);

  assert.deepEqual(headers, [
    'Event ID',
    'Event Name',
    'Event Type',
    'Organizer',
    'Mobile',
    'Date',
    'Time',
    'Venue',
    'Status',
  ]);
});

test('the page hands the exporters the dataset it is showing', () => {
  const page = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8');
  const exportBlock = page.slice(page.indexOf('const runExport'), page.indexOf('const runExport') + 1400);

  assert.ok(exportBlock.includes('filteredRows'), 'exports use the filtered rows');
  assert.ok(!exportBlock.includes('api.get'), 'an export never re-fetches');
  assert.ok(
    exportBlock.includes('exportFilters.searchValue') &&
      exportBlock.includes('exportFilters.startDate') &&
      exportBlock.includes('exportFilters.endDate'),
    'and the filters printed on it are the ones the table was built from'
  );
});


/**
 * Column filters in the downloaded workbook.
 *
 * Asserted on the file as Excel receives it — the workbook is written to a
 * buffer and read back — because an autoFilter set on an in-memory sheet that
 * never reached the XML would pass a check of the object and still open
 * without a single dropdown.
 */
const reopen = async (workbook: any): Promise<any> => {
  const buffer = await workbook.xlsx.writeBuffer();
  const imported: any = await import('exceljs');
  const ExcelJS = imported.default ?? imported;
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer);
  return reopened.worksheets[0];
};

test('Event Report — Excel column filters', async (t) => {
  const sheet = await reopen(await build());
  const grid = textOf(sheet);
  const headerRowNumber = grid.findIndex((row) => row[0] === 'Event ID') + 1;

  await t.test('the saved file carries a real AutoFilter', () => {
    assert.ok(sheet.autoFilter, 'the workbook Excel opens has a filter range');
  });

  await t.test('it starts at the heading row, not at the metadata above it', () => {
    const from = String(sheet.autoFilter).split(':')[0];
    assert.equal(from, `A${headerRowNumber}`);
    // Row 1 is the title and rows 3-5 are the filters; a range starting there
    // would offer "Search Value" as a column heading.
    assert.ok(headerRowNumber > 5, 'the metadata really is above the table');
  });

  await t.test('it spans every column of the report', () => {
    const to = String(sheet.autoFilter).split(':')[1];
    // Nine columns: A to I.
    assert.equal(to.replace(/\d+$/, ''), 'I');
    assert.equal(COLUMNS.length, 9);
  });

  await t.test('it covers all the data rows and stops before the notes', () => {
    const to = Number(String(sheet.autoFilter).split(':')[1].replace(/^[A-Z]+/, ''));
    assert.equal(to, headerRowNumber + ROWS.length, 'the last data row is the last filtered row');
    const noteRow = grid.findIndex((row) => row[0] === REPORT_NOTE) + 1;
    assert.ok(noteRow > to, 'the standing notes are outside the filter');
  });

  await t.test('the heading row is still frozen', () => {
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, headerRowNumber);
  });

  await t.test('a report with no rows filters its headings alone', async () => {
    const empty = await reopen(await buildReportWorkbook('Event Report', COLUMNS, [], META));
    const [from, to] = String(empty.autoFilter).split(':');
    assert.equal(from.replace(/[A-Z]/g, ''), to.replace(/[A-Z]/g, ''), 'one row: the headings');
  });
});

test('the Delivery Log downloads as the table shows it', async (t) => {
  const logs = [
    {
      _id: '1',
      contactId: { fullName: 'Sashi', phoneNumber: '+919121604967' },
      status: 'Sent',
      sentAt: '2026-10-01T10:00:00.000Z',
      createdAt: '2026-10-01T09:59:00.000Z',
    },
    {
      _id: '2',
      contactName: 'Swapnil Jagtap',
      phoneNumber: '+919834653925',
      status: 'Failed',
      errorCode: 131047,
      errorReason: 'Re-engagement message',
      failedAt: '2026-10-01T11:00:00.000Z',
      createdAt: '2026-10-01T10:59:00.000Z',
    },
  ];
  const meta = { searchValue: '', startDate: '2026-10-01', endDate: '2026-10-02' };
  const sheet = await reopen(
    await buildReportWorkbook('Delivery Log', DELIVERY_LOG_COLUMNS, logs, meta)
  );
  const grid = textOf(sheet);

  await t.test('the eight columns are the ones the page lists, in its order', () => {
    const headings = grid.find((row) => row[0] === 'Contact');
    assert.deepEqual(headings?.slice(0, 8), [
      'Contact',
      'Phone',
      'Status',
      'Accepted',
      'Delivered',
      'Read',
      'Failed',
      'Details',
    ]);
  });

  await t.test('the status is the resolved milestone, not the stored value', () => {
    const row = grid.find((r) => r[0] === 'Sashi');
    // Stored 'Sent' means WhatsApp accepted it, which is what the table shows.
    assert.equal(row?.[2], 'Accepted by WhatsApp');
    assert.equal(describeDeliveryLog(logs[0] as any).label, 'Accepted by WhatsApp');
  });

  await t.test('a failure carries its reason across, as the Details cell does', () => {
    const row = grid.find((r) => r[0] === 'Swapnil Jagtap');
    assert.equal(row?.[2], 'Failed');
    assert.equal(row?.[7], '[131047] Re-engagement message');
  });

  await t.test('the period it covers is in its header', () => {
    const find = (label: string) => grid.find((row) => row[0] === label);
    assert.deepEqual(find('Start Date')?.slice(0, 2), ['Start Date', '2026-10-01']);
    assert.deepEqual(find('End Date')?.slice(0, 2), ['End Date', '2026-10-02']);
  });

  await t.test('every one of its columns has a filter', () => {
    const headerRowNumber = grid.findIndex((row) => row[0] === 'Contact') + 1;
    assert.equal(
      String(sheet.autoFilter),
      `A${headerRowNumber}:H${headerRowNumber + logs.length}`,
      'A to H is all eight columns, across both data rows'
    );
  });
});


/**
 * The report request and the events cache are two different things.
 *
 * Asserted from the page source, as the cases above do for the export wiring:
 * this is effect-and-ref plumbing that only runs inside a mounted React tree,
 * and the property that matters is which request carries the dates and which
 * one fills the cache.
 */
test('every report request states the period it covers', async (t) => {
  const page = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8');
  const loadReport = page.slice(page.indexOf('const loadReport'), page.indexOf('const loadReport') + 1600);

  await t.test('the request sends both dates', () => {
    assert.ok(loadReport.includes('startDate: filters.startDate'), 'startDate is sent');
    assert.ok(loadReport.includes('endDate: filters.endDate'), 'endDate is sent');
  });

  await t.test('all three reports go through that one request', () => {
    // Event, Access and Contact differ only by endpoint, so none can be left
    // sending a report request without its range.
    assert.ok(loadReport.includes('REPORTS[key].endpoint'), 'one request serves every tab');
    const keys = [...page.matchAll(/^  (event|access|contact): \{$/gm)].map((m) => m[1]);
    assert.deepEqual(keys, ['event', 'access', 'contact']);
  });

  await t.test('a report is not generated until the range is usable', () => {
    const runSearch = page.slice(page.indexOf('const runSearch'), page.indexOf('const runSearch') + 900);
    const guardAt = runSearch.indexOf('validateReportDateRange');
    const requestAt = runSearch.indexOf('loadReport(activeReport');
    assert.ok(guardAt >= 0, 'the range is checked');
    assert.ok(requestAt >= 0, 'and the request is in the same function');
    assert.ok(guardAt < requestAt, 'the check comes BEFORE the request is made');
  });
});

test('the events cache is not the Event Report', async (t) => {
  const page = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8');
  const loadReport = page.slice(page.indexOf('const loadReport'), page.indexOf('const loadReport') + 1600);
  const cache = page.slice(
    page.indexOf('const loadEventsForSelectors'),
    page.indexOf('const loadEventsForSelectors') + 500
  );

  await t.test('the filtered report response never becomes the cache', () => {
    // This is the regression the split exists to prevent: an Event Report for
    // one week would otherwise leave the picker holding only that week.
    assert.ok(!loadReport.includes('setEvents('), 'a report response is report data only');
    assert.ok(!loadReport.includes('eventsRequested'), 'and it does not mark the cache as loaded');
  });

  await t.test('the cache is fetched complete, with no range', () => {
    assert.ok(cache.includes("api.get('/events')"), 'the plain authorized list');
    assert.ok(!cache.includes('startDate'), 'no report range is applied to it');
    assert.ok(cache.includes('setEvents('), 'and it is what fills the cache');
  });

  await t.test('a Contact Report still has every event available to name from', () => {
    // Contacts carry only an eventId, so a guest whose event falls outside the
    // Contact Report's own range still has to show that event's name.
    const runSearch = page.slice(page.indexOf('const runSearch'), page.indexOf('const runSearch') + 700);
    assert.ok(runSearch.includes('loadEventsForSelectors()'), 'the cache is loaded for the run');
  });
});

test('the Delivery Log applies and prints its range', async (t) => {
  const page = fs.readFileSync('frontend/src/pages/Campaigns/CampaignReport.tsx', 'utf-8');

  await t.test('rows are filtered on the one timestamp every log has', () => {
    assert.ok(
      page.includes('withinRange(deliveryLogDate(log), startDate, endDate)'),
      'createdAt — sentAt and deliveredAt are absent until those milestones happen'
    );
  });

  await t.test('neither download runs without a usable range', () => {
    const excel = page.slice(page.indexOf('handleDownloadExcel'), page.indexOf('handleDownloadPDF'));
    const pdf = page.slice(page.indexOf('const handleDownloadPDF'), page.indexOf('const handleDownloadPDF') + 400);
    assert.ok(excel.includes('validateReportDateRange'), 'Excel is guarded');
    assert.ok(pdf.includes('validateReportDateRange'), 'PDF is guarded too');
  });

  await t.test('both formats state the period', () => {
    const excelCall = page.slice(page.indexOf('exportToExcel('), page.indexOf('exportToExcel(') + 400);
    assert.match(excelCall, /startDate,/, 'the workbook carries the start as metadata');
    assert.match(excelCall, /endDate,/, 'and the end');
    assert.ok(page.includes('`Start Date: ${startDate}`'), 'and the PDF prints it');
    assert.ok(page.includes('`End Date: ${endDate}`'));
  });

  await t.test('it exports the rows it is showing, not the unfiltered set', () => {
    const excel = page.slice(page.indexOf('handleDownloadExcel'), page.indexOf('handleDownloadPDF'));
    assert.ok(excel.includes('visibleLogs'), 'the filtered rows');
    assert.ok(!excel.includes('api.get'), 'an export never re-fetches');
  });
});


/**
 * The mandatory range applies to every role, not just the one that presses
 * Search.
 *
 * Super Admins generate a report explicitly; every other role's tab loads its
 * own rows. Both paths have to run the same check, or an Admin opening a tab
 * would be shown a report covering no stated period — and a half-filled range
 * would be sent as "?startDate=2026-10-01&endDate=" and come back 400.
 */
test('no role can load a report without both dates', async (t) => {
  const page = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8');
  const liveEffect = page.slice(
    page.indexOf('Roles other than Super Admin filter live'),
    page.indexOf('/** Super Admin: generate the report for the current filters. */')
  );

  await t.test('the live path is gated by the same validator', () => {
    assert.ok(liveEffect.includes('validateReportDateRange(startDate, endDate)'), 'it runs the check');
  });

  await t.test('and it is checked before any request is made', () => {
    const guardAt = liveEffect.indexOf('validateReportDateRange');
    const requestAt = liveEffect.indexOf('loadReport(activeReport');
    assert.ok(guardAt >= 0 && requestAt >= 0, 'both are in this effect');
    assert.ok(guardAt < requestAt, 'the check comes first');
  });

  await t.test('an incomplete range returns before the request, so nothing is sent', () => {
    const guard = liveEffect.slice(liveEffect.indexOf('if (problem)'), liveEffect.indexOf('setDateError(\'\')'));
    assert.ok(guard.includes('return;'), 'the effect stops');
    assert.ok(!guard.includes('loadReport'), 'no API call inside the failing branch');
  });

  await t.test('it says what is missing rather than failing the tab', () => {
    assert.ok(liveEffect.includes('setDateError(problem)'), 'the message is shown');
    assert.ok(!liveEffect.includes("type: 'failure'"), 'the tab is not reported as a failed load');
  });

  await t.test('the table is emptied rather than left holding undated rows', () => {
    assert.ok(liveEffect.includes("dispatch({ type: 'reset'"), 'the run is reset');
  });

  await t.test('the Event Report no longer bypasses the request for live roles', () => {
    // It used to answer from the events cache, which meant one report could be
    // generated with no dates at all.
    assert.ok(!liveEffect.includes('rows: events'), 'no cache shortcut remains');
  });

  await t.test('Super Admin is held to exactly the same check', () => {
    const runSearch = page.slice(page.indexOf('const runSearch'), page.indexOf('const runSearch') + 900);
    assert.ok(runSearch.includes('validateReportDateRange(startDate, endDate)'));
  });
});


/**
 * The Details column says the same thing in the download as on the screen.
 *
 * The table renders that cell in JSX and the export writes it from
 * describeDeliveryDetail, so the two can drift — and did: a queued row read
 * "Waiting to be processed" on screen and "Queued" in the spreadsheet. Each
 * wording the exporter can produce is checked against the page's own markup.
 */
test('the exported Details match the Delivery Log table', async (t) => {
  const page = fs.readFileSync('frontend/src/pages/Campaigns/CampaignReport.tsx', 'utf-8');

  const cases: Array<[string, any]> = [
    ['a failure', { status: 'Failed', errorCode: 131047, errorReason: 'Re-engagement message' }],
    ['a read message', { status: 'Delivered', deliveredAt: 'x', readAt: 'y' }],
    ['a delivered message', { status: 'Delivered', deliveredAt: 'x' }],
    ['an accepted message', { status: 'Sent', sentAt: 'x' }],
    ['a queued message', { status: 'Pending' }],
  ];

  for (const [label, row] of cases) {
    await t.test(`${label} reads the same in both`, () => {
      const detail = describeDeliveryDetail(row);
      if (row.status === 'Failed') {
        // The failure text is the stored code and reason, which the cell
        // builds the same way rather than from a fixed phrase.
        assert.equal(detail, '[131047] Re-engagement message');
        return;
      }
      assert.ok(
        page.includes(detail),
        `the table has no cell reading "${detail}" — the export has drifted from it`
      );
    });
  }

  await t.test('the status label is shared outright, not re-stated', () => {
    // describeDeliveryLog is imported by the page, so the Status column cannot
    // disagree the way Details did.
    assert.ok(page.includes('describeDeliveryLog'), 'the page uses the shared resolver');
  });
});


/**
 * The period survives a change of report.
 *
 * One switchReport serves all three tabs, so these assertions cover every
 * transition between them — Event to Contact, Contact to Access, Access to
 * Event — rather than three near-identical cases that would only re-check the
 * same function.
 */
test('switching report keeps the dates', async (t) => {
  const page = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8');
  const switchStart = page.indexOf('const switchReport');
  const switchReport = page.slice(switchStart, page.indexOf('\n  };', switchStart));

  await t.test('the one switch serves every tab, so all three transitions are this code', () => {
    assert.ok(switchReport.includes('setActiveReport(key)'), 'the tab is set from its argument');
    const calls = [...page.matchAll(/switchReport\(/g)].length;
    assert.ok(calls >= 1, 'and the tabs all call it');
  });

  await t.test('neither date is cleared on the way', () => {
    assert.ok(!switchReport.includes("setStartDate('')"), 'Start Date is carried over');
    assert.ok(!switchReport.includes("setEndDate('')"), 'End Date is carried over');
  });

  await t.test('the tab-specific filters still start fresh', () => {
    assert.ok(switchReport.includes("setSearchValue('')"), 'the search text resets');
    assert.ok(switchReport.includes('setMode(REPORTS[key].options[0].key)'), 'the mode resets');
    assert.ok(switchReport.includes("dispatch({ type: 'reset'"), 'the previous report is discarded');
  });

  await t.test('Clear still clears them — preserving is not the same as pinning', () => {
    const clear = page.slice(page.indexOf('const clearFilters'), page.indexOf('const clearFilters') + 700);
    assert.ok(clear.includes("setStartDate('')") && clear.includes("setEndDate('')"));
  });

  await t.test('the preserved range is what the next request carries', () => {
    const loadReport = page.slice(page.indexOf('const loadReport'), page.indexOf('const loadReport') + 1600);
    assert.ok(loadReport.includes('startDate: filters.startDate'));
    assert.ok(loadReport.includes('endDate: filters.endDate'));
    // Both entry points pass the live filters, which now still hold the dates.
    const live = page.slice(page.indexOf('Roles other than Super Admin filter live'), page.indexOf('/** Super Admin: generate'));
    assert.ok(live.includes('loadReport(activeReport, liveFiltersRef.current)'));
    const runSearch = page.slice(page.indexOf('const runSearch'), page.indexOf('const runSearch') + 900);
    assert.ok(runSearch.includes('loadReport(activeReport, liveFilters)'));
  });
});

/**
 * One validation voice, whatever the role.
 *
 * The filter form used to be validated by the browser for the roles that press
 * Search, so a Super Admin was told "Please fill out this field." while an
 * Admin was told what the application says. The form no longer defers to the
 * browser, so every role reaches validateReportDateRange.
 */
test('the application owns the date validation', async (t) => {
  const bar = fs.readFileSync('frontend/src/components/ui/ReportFilterBar.tsx', 'utf-8');
  const page = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8');

  await t.test('the form does not hand validation to the browser', () => {
    assert.ok(/<form[\s\S]{0,900}noValidate/.test(bar), 'the filter form is noValidate');
  });

  await t.test('the fields are still announced as required', () => {
    // Turning off the browser's checking must not stop a screen reader saying
    // the field is needed.
    assert.equal((bar.match(/aria-required="true"/g) || []).length, 2, 'both dates');
    assert.ok(bar.includes('Start Date <span className="text-destructive">*</span>'));
    assert.ok(bar.includes('End Date <span className="text-destructive">*</span>'));
  });

  await t.test('Search stays pressable so the application can answer', () => {
    // Disabling it on dateError left the user with a stale message and no way
    // to ask again.
    const at = bar.indexOf('type="submit"');
    const search = bar.slice(at, at + 220);
    assert.ok(search.includes('disabled={isSearching}'), 'only a request in flight disables it');
    assert.ok(!search.includes('Boolean(dateError)'), 'an invalid range does not lock the button');
  });

  await t.test('and pressing it with a bad range makes no request', () => {
    const runSearch = page.slice(page.indexOf('const runSearch'), page.indexOf('const runSearch') + 900);
    const guardAt = runSearch.indexOf('validateReportDateRange');
    const requestAt = runSearch.indexOf('loadReport(activeReport');
    assert.ok(guardAt >= 0 && guardAt < requestAt, 'the check still precedes the request');
    assert.ok(runSearch.includes('setDateError(problem)'), 'and the message is the application\'s');
  });

  await t.test('the downloads are still what stay disabled', () => {
    assert.ok(bar.includes('!isExporting && !isSearching && !dateError'), 'no file without a usable range');
  });
});
