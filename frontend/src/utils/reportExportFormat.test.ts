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
