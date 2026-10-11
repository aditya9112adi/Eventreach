/**
 * Excel and PDF of one event's View on the Access or Contact Report: the
 * event's details, then exactly the records the View shows.
 *
 * Run: npx tsx --test frontend/src/utils/reportEventViewExport.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'node:module';
import {
  buildEventViewPdf,
  buildEventViewWorkbook,
  eventViewDetails,
  eventViewFileName,
  type EventViewExport,
} from './reportEventViewExport.ts';
import type { ReportColumn } from './reportExport.ts';

const COLUMNS: ReportColumn<any>[] = [
  { header: 'Full Name', value: (r) => r.fullName, width: 26 },
  { header: 'Phone', value: (r) => r.phoneNumber, width: 18 },
  { header: 'Status', value: (r) => r.status, width: 14 },
];
const EVENT: Array<[string, string]> = [
  ['Event ID', 'EVT-000008'],
  ['Event Name', 'School Event'],
  ['Venue', 'Pune'],
];
const ROWS = [
  { _id: 'c1', fullName: 'Asha Patil', phoneNumber: '+919876500001', status: 'Valid' },
  { _id: 'c2', fullName: 'Ravi Kulkarni', phoneNumber: '+919876500002', status: 'Duplicate' },
];
const WHEN = new Date('2026-10-11T06:00:00.000Z');

const input = (over: Partial<EventViewExport<any>> = {}): EventViewExport<any> => ({
  title: 'Contact Details',
  fileName: 'ContactReport',
  eventDetails: EVENT,
  columns: COLUMNS,
  rows: ROWS,
  match: { q: 'school', startDate: '2026-09-01', endDate: '2026-11-30' },
  ...over,
});

const sheetsOf = async (workbook: any) => {
  const imported: any = await import('exceljs');
  const ExcelJS = imported.default ?? imported;
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(await workbook.xlsx.writeBuffer());
  return back.worksheets.map((sheet: any) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row: any) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell: any) => cells.push(String(cell.value ?? '')));
      rows.push(cells);
    });
    return { name: sheet.name, rows };
  });
};

const pdfText = async (doc: any): Promise<string> => {
  const require = createRequire(import.meta.url);
  const pdfParse = require(require.resolve('pdf-parse', { paths: ['./backend', '.'] }));
  return (await pdfParse(Buffer.from(doc.output('arraybuffer')))).text;
};

test('the details say which event, how many records, and which ones', async (t) => {
  await t.test('matching records: the report\'s search and period', () => {
    assert.deepEqual(eventViewDetails(input(), WHEN).slice(3, 8), [
      ['Records', '2'],
      ['Showing', "Records matching the report's filters"],
      ['Search Value', 'school'],
      ['Start Date', '2026-09-01'],
      ['End Date', '2026-11-30'],
    ]);
  });

  await t.test('every record: said so, with no search to state', () => {
    const details = eventViewDetails(input({ match: null }), WHEN);
    assert.deepEqual(details.slice(3, 5), [['Records', '2'], ['Showing', 'All records of the event']]);
    assert.equal(details.some(([label]) => label === 'Search Value'), false);
  });

  await t.test('the event\'s own lines come first, as the View shows them', () => {
    assert.deepEqual(eventViewDetails(input(), WHEN).slice(0, 3), EVENT);
  });
});

test('the Excel: the event on one sheet, exactly the records shown on the next', async () => {
  const [details, table] = await sheetsOf(await buildEventViewWorkbook(input(), WHEN));
  assert.equal(details.name, 'Event Details');
  assert.ok(details.rows.some((r) => r[0] === 'Event ID' && r[1] === 'EVT-000008'));
  assert.ok(details.rows.some((r) => r[0] === 'Search Value' && r[1] === 'school'));
  assert.equal(table.name, 'Contact Details');
  const header = table.rows.findIndex((r) => r[0] === 'Full Name');
  assert.deepEqual(table.rows[header], ['Full Name', 'Phone', 'Status']);
  const records = table.rows.slice(header + 1).filter((r) => /^\+91/.test(r[1] ?? ''));
  assert.deepEqual(records.map((r) => r[0]), ['Asha Patil', 'Ravi Kulkarni']);
  assert.ok(table.rows.some((r) => r[0] === 'Event' && r[1] === 'EVT-000008 | School Event'), 'the table sheet names its event');
});

test('the PDF: the event\'s details at the top, then the records', async () => {
  const text = await pdfText(await buildEventViewPdf(input({ title: 'Access Details' }), WHEN));
  const flat = text.replace(/\s+/g, ' ');
  for (const expected of ['Access Details', 'EVT-000008', 'School Event', 'Asha Patil', 'Ravi Kulkarni']) {
    assert.ok(flat.includes(expected), expected);
  }
  assert.ok(text.split(/\r?\n/).includes('Records2'), 'the record count');
  assert.equal(flat.split('+91').length - 1, 2, 'two records, no more');
});

test('the file name: the report, the event and the date', () => {
  assert.equal(eventViewFileName(input(), WHEN), 'ContactReport_EVT000008_11102026');
  assert.equal(eventViewFileName(input({ fileName: 'AccessReport', eventDetails: [] }), WHEN), 'AccessReport_Event_11102026');
});

test('the View offers them beside its heading, for the records it shows', () => {
  const view = fs.readFileSync('frontend/src/components/ui/ReportEventView.tsx', 'utf-8').split('\r\n').join('\n');
  assert.ok(view.includes("onClick={() => void runExport('excel')}"));
  assert.ok(view.includes("onClick={() => void runExport('pdf')}"));
  assert.ok(view.includes('disabled={!canExport}'));
  assert.ok(view.includes("const canExport = status === 'success' && shown.length > 0 && exporting === null;"), 'nothing to download, nothing offered');
});
