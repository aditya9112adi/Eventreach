/**
 * Uploading guests onto a Sub-Event's member list - the rules, with no database.
 *
 * Real .xlsx buffers and a real (hand-built) PDF are read by the same extractors
 * the Contact Bulk upload uses, then classified. The HTTP behaviour (authorization,
 * the right Sub-Event, nothing else touched) is in tests/memberUpload.integration.test.ts.
 *
 * Run: npx tsx --test backend/tests/memberUpload.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as xlsx from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { extractFromExcel, extractFromPDF } from '../src/utils/fileExtractors';
import {
  MEMBER_UPLOAD_MAX_ROWS,
  classifyMemberRows,
  countUploadRows,
  isPdfUpload,
  normalizeUploadRows,
  validateUploadFile,
  type MemberMatch,
} from '../src/services/memberUploadService';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const sheetBuffer = (rows: any[][], bookType: 'xlsx' | 'biff8' = 'xlsx'): Buffer => {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), 'Sheet1');
  return xlsx.write(workbook, { type: 'buffer', bookType }) as Buffer;
};

/**
 * A table PDF made the way the application's own exports make them (jsPDF with
 * jspdf-autotable), which pdf-parse reads back as one line per row.
 */
const pdfBuffer = (rows: (string | number)[][]): Buffer => {
  const doc = new jsPDF();
  autoTable(doc, { head: [['Sr.No', 'Guest Name', 'Contact Number']], body: rows });
  return Buffer.from(doc.output('arraybuffer'));
};

const HEADER = ['Sr.No', 'Guest Name', 'Contact Number'];
const SHEET = [
  HEADER,
  [1, 'Asha Rao', '9876543210'],        // a contact, not yet a member
  [2, 'Dev Patel', '+91 91234 56780'],  // a contact, already a member
  [3, 'Meera Iyer', '9988776655'],      // not a contact at all
  [4, 'Bad Number', '1234567890'],      // ten digits, but not an Indian mobile
  [5, '', '9811122233'],                // no name
  [6, 'Asha Again', '919876543210'],    // the first contact, written another way
];
const PDF_ROWS: (string | number)[][] = [
  [1, 'Asha Rao', '+919876543210'],
  [2, 'Dev Patel', '+919123456780'],
  [3, 'Meera Iyer', '+919988776655'],
  [4, 'Bad Number', '+911234567890'],
  [5, '', '+919811122233'],
  [6, 'Asha Again', '+919876543210'],
];

const ASHA: MemberMatch = { contactId: 'c-asha', fullName: 'Asha R.' };
const DEV: MemberMatch = { contactId: 'c-dev', fullName: 'Dev Patel' };
const matches = new Map<string, MemberMatch>([['+919876543210', ASHA], ['+919123456780', DEV]]);
const members = new Set(['c-dev']);

const classify = (raw: ReturnType<typeof extractFromExcel>) => classifyMemberRows(normalizeUploadRows(raw), matches, members, 1);

describe('the file itself', () => {
  const ok = (name: string, mimetype: string, buffer: Buffer) => validateUploadFile({ originalname: name, mimetype, size: buffer.length, buffer });

  test('a real .xlsx, .xls and .pdf are accepted', () => {
    assert.equal(ok('guests.xlsx', XLSX_MIME, sheetBuffer(SHEET)), null);
    assert.equal(ok('guests.xls', 'application/vnd.ms-excel', sheetBuffer(SHEET, 'biff8')), null);
    assert.equal(ok('guests.PDF', 'application/pdf', pdfBuffer(PDF_ROWS)), null);
  });

  test('another file type is refused by its extension', () => {
    for (const name of ['guests.csv', 'guests.txt', 'guests.docx', 'guests', 'guests.xlsx.exe']) {
      assert.match(String(ok(name, XLSX_MIME, sheetBuffer(SHEET))), /Unsupported file type/);
    }
  });

  test('an extension that disagrees with the declared type is refused', () => {
    assert.match(String(ok('guests.pdf', XLSX_MIME, pdfBuffer(PDF_ROWS))), /does not match its \.pdf extension/);
    assert.match(String(ok('guests.xlsx', 'application/pdf', sheetBuffer(SHEET))), /does not match its \.xlsx extension/);
  });

  test('an empty file is refused', () => {
    assert.equal(ok('guests.xlsx', XLSX_MIME, Buffer.alloc(0)), 'The file is empty.');
    assert.equal(validateUploadFile({ originalname: 'guests.pdf', mimetype: 'application/pdf', size: 0 }), 'The file is empty.');
  });

  test('content that is not what the extension says is refused', () => {
    const text = Buffer.from('Asha Rao,9876543210\n');
    assert.match(String(ok('guests.xlsx', XLSX_MIME, text)), /not a valid Excel/);
    assert.match(String(ok('guests.pdf', 'application/pdf', text)), /not a valid PDF/);
    assert.match(String(ok('guests.xls', 'application/vnd.ms-excel', sheetBuffer(SHEET))), /not a valid Excel/); // an xlsx renamed .xls
  });

  test('isPdfUpload goes by the extension', () => {
    assert.equal(isPdfUpload({ originalname: 'a.PDF' }), true);
    assert.equal(isPdfUpload({ originalname: 'a.xlsx' }), false);
  });
});

describe('rows from Excel and from PDF come out the same', () => {
  const statuses = (rows: ReturnType<typeof classify>) => rows.map((r) => `${r.status}${r.contactId ? `:${r.contactId}` : ''}`);
  const expected = ['Valid:c-asha', 'Duplicate:c-dev', 'NotFound', 'Invalid', 'Invalid', 'Duplicate:c-asha'];

  test('Excel', () => {
    assert.deepEqual(statuses(classify(extractFromExcel(sheetBuffer(SHEET)))), expected);
  });

  test('PDF', async () => {
    assert.deepEqual(statuses(classify(await extractFromPDF(pdfBuffer(PDF_ROWS)))), expected);
  });
});

describe('what each row is told', () => {
  const rows = classify(extractFromExcel(sheetBuffer(SHEET)));
  const reason = (i: number) => rows[i].validationReason;

  test('a matching contact is Valid and shows the contact it matched', () => {
    assert.equal(rows[0].status, 'Valid');
    assert.equal(rows[0].contactId, 'c-asha');
    assert.equal(rows[0].matchedName, 'Asha R.');
    assert.equal(rows[0].phoneNumber, '+919876543210');
    assert.equal(rows[0].countryCode, 'IN');
  });

  test('an existing member is a Duplicate and is not added again', () => {
    assert.equal(rows[1].status, 'Duplicate');
    assert.equal(reason(1), 'Already a member of this sub-event');
  });

  test('a number that is not a contact is NotFound - nothing would be created', () => {
    assert.equal(rows[2].status, 'NotFound');
    assert.equal(rows[2].contactId, undefined);
    assert.equal(reason(2), 'Not in your contacts');
  });

  test('an unusable number is Invalid, with the Contact Bulk reason', () => {
    assert.equal(rows[3].status, 'Invalid');
    assert.ok(reason(3));
    assert.equal(rows[3].phoneNumber, '1234567890');
  });

  test('a missing name is Invalid', () => {
    assert.equal(rows[4].status, 'Invalid');
    assert.equal(reason(4), 'Guest Name is missing.');
  });

  test('the same contact written two ways is a Duplicate in the file', () => {
    assert.equal(rows[5].status, 'Duplicate');
    assert.equal(reason(5), 'Duplicate in file');
  });

  test('valid and invalid numbers are judged by the application rule, whatever the format', () => {
    const rows2 = normalizeUploadRows([
      { fullName: 'A', phoneNumber: '9876543210' },
      { fullName: 'B', phoneNumber: '+919876543211' },
      { fullName: 'C', phoneNumber: '09876543212' },
      { fullName: 'D', phoneNumber: '1234567890' },
      { fullName: 'E', phoneNumber: '98765' },
      { fullName: 'F', phoneNumber: '+14155550123' },
    ]);
    assert.deepEqual(rows2.map((r) => Boolean(r.problem)), [false, false, false, true, true, true]);
    assert.deepEqual(rows2.slice(0, 3).map((r) => r.phoneNumber), ['+919876543210', '+919876543211', '+919876543212']);
  });

  test('a row missing both name and number says both', () => {
    const [row] = normalizeUploadRows([{ fullName: ' ', phoneNumber: '12' }]);
    assert.match(String(row.problem), /Guest Name is also missing/);
  });
});

describe('counts', () => {
  test('every row is counted once and the counts add up to the total', () => {
    const rows = classify(extractFromExcel(sheetBuffer(SHEET)));
    assert.deepEqual(countUploadRows(rows), { total: 6, valid: 1, duplicate: 2, notFound: 1, invalid: 2 });
  });

  test('a file of only unknown numbers has nothing valid', () => {
    const rows = classifyMemberRows(normalizeUploadRows([{ fullName: 'X', phoneNumber: '9000000001' }]), new Map(), new Set(), 1);
    assert.equal(countUploadRows(rows).valid, 0);
    assert.equal(countUploadRows(rows).notFound, 1);
  });
});

describe('malformed sheets', () => {
  test('a sheet without the required columns is refused with the format, not read as empty', () => {
    assert.throws(() => extractFromExcel(sheetBuffer([['Sr.No', 'Guest Name'], [1, 'A']])), /Contact Number/);
    assert.throws(() => extractFromExcel(sheetBuffer([['Sr.No', 'Contact Number'], [1, '9876543210']])), /Guest Name/);
    assert.throws(() => extractFromExcel(sheetBuffer([['Column A', 'Column B'], ['x', 'y']])), /Column A, Column B/);
  });

  test('a sheet with only a header has no rows', () => {
    assert.deepEqual(extractFromExcel(sheetBuffer([HEADER])), []);
  });

  test('a PDF with no guest rows has none', async () => {
    assert.deepEqual(await extractFromPDF(pdfBuffer([[1, 'Guest list', 'to follow']])), []);
  });

  test('the row limit is stated', () => {
    assert.equal(MEMBER_UPLOAD_MAX_ROWS, 5000);
  });
});
