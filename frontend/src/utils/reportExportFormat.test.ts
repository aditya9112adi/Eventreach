import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  buildReportWorkbook,
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

test('Event Report — PDF shares the same contract', async (t) => {
  const source = fs.readFileSync('frontend/src/utils/reportExport.ts', 'utf-8');

  await t.test('it prints the title, the filters and both notes', () => {
    const pdf = source.slice(source.indexOf('export const exportToPdf'));
    assert.ok(pdf.includes('doc.text(title'), 'the report name');
    assert.ok(pdf.includes('buildMetaRows(meta)'), 'the same three filter lines as Excel');
    assert.ok(pdf.includes('REPORT_NOTE'), REPORT_NOTE);
    assert.ok(pdf.includes('REPORT_CREDIT'), REPORT_CREDIT);
  });

  await t.test('the table is drawn with borders on every side', () => {
    const pdf = source.slice(source.indexOf('export const exportToPdf'));
    assert.ok(pdf.includes("theme: 'grid'"), "autotable's grid theme draws all four sides");
    assert.ok(pdf.includes('lineWidth'), 'with a visible line width');
  });

  await t.test('the headings are bold and filled', () => {
    const pdf = source.slice(source.indexOf('export const exportToPdf'));
    assert.ok(pdf.includes("fontStyle: 'bold'"));
    assert.ok(pdf.includes('fillColor: [217, 225, 242]'));
  });

  await t.test('it writes the rows it is given, and never queries for more', () => {
    const pdf = source.slice(source.indexOf('export const exportToPdf'));
    assert.ok(pdf.includes('body: rows.map'), 'the body comes from the rows argument');
    assert.ok(!/\bfetch\(|\baxios\b|\bapi\./.test(pdf), 'no export may load its own dataset');
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
