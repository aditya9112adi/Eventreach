/**
 * Contact import — the final Excel format.
 *
 *   Sr.No | Guest Name | Contact Number
 *
 * Real .xlsx buffers are built and parsed here, so the sheet these tests
 * describe is the sheet the importer actually reads. Nothing touches a
 * database or the network.
 *
 * Run: npx tsx --test backend/tests/contactImport.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as xlsx from 'xlsx';
import {
  extractFromExcel,
  parsePdfGuestRows,
  ImportFormatError,
  IMPORT_COLUMNS,
} from '../src/utils/fileExtractors';
import { normalizeIndianPhone } from '../src/utils/indianPhone';

/** A workbook from rows of cells, exactly as a user's file would arrive. */
const sheetBuffer = (rows: any[][]): Buffer => {
  const sheet = xlsx.utils.aoa_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

/** The reference file's own contents. */
const REFERENCE = [
  ['Sr.No', 'Guest Name', 'Contact Number'],
  [1, 'Suresh', '8786564981'],
  [2, 'Rakhi', '8452345235'],
  [3, 'Kumar', '9843196483'],
  [4, 'Nikita', '7525985316'],
  [5, 'Pranav', '8341547593'],
];

const thrown = (fn: () => unknown): ImportFormatError => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ImportFormatError, `expected an ImportFormatError, got ${error}`);
    return error as ImportFormatError;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, it returned normally' });
};

test('the final format', async (t) => {
  await t.test('the reference sheet imports, mapping name and number', () => {
    const contacts = extractFromExcel(sheetBuffer(REFERENCE));
    assert.equal(contacts.length, 5);
    assert.deepEqual(
      contacts.map((c) => [c.fullName, c.phoneNumber]),
      [
        ['Suresh', '8786564981'],
        ['Rakhi', '8452345235'],
        ['Kumar', '9843196483'],
        ['Nikita', '7525985316'],
        ['Pranav', '8341547593'],
      ]
    );
  });

  await t.test('the expected columns are stated in one place', () => {
    assert.deepEqual([...IMPORT_COLUMNS], ['Sr.No', 'Guest Name', 'Contact Number']);
  });

  await t.test('Sr.No is read but never becomes contact data', () => {
    const contacts = extractFromExcel(sheetBuffer(REFERENCE));
    for (const contact of contacts) {
      assert.ok(!('srNo' in contact), 'the serial number is not carried into the contact');
      assert.notEqual(contact.phoneNumber, '1', 'the serial column must never be read as a number');
      assert.notEqual(contact.fullName, '1');
    }
  });

  await t.test('a number held as an Excel number still imports', () => {
    const contacts = extractFromExcel(sheetBuffer([REFERENCE[0], [1, 'Suresh', 8786564981]]));
    assert.equal(contacts[0].phoneNumber, '8786564981');
  });

  await t.test('common heading variants are accepted', () => {
    const contacts = extractFromExcel(
      sheetBuffer([['Sr No', 'Full Name', 'Mobile Number'], [1, 'Suresh', '8786564981']])
    );
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].fullName, 'Suresh');
    assert.equal(contacts[0].phoneNumber, '8786564981');
  });
});

test('phone numbers survive the round trip', async (t) => {
  const importOne = (raw: any) => extractFromExcel(sheetBuffer([REFERENCE[0], [1, 'Guest', raw]]))[0];

  await t.test('a +91 number is not truncated', () => {
    const contact = importOne('+918786564981');
    assert.equal(contact.phoneNumber, '+918786564981', 'the + and country code survive extraction');
    const normalized = normalizeIndianPhone(contact.phoneNumber);
    assert.ok(normalized.ok);
    assert.equal((normalized as any).e164, '+918786564981', 'and normalize to the same 13 characters');
  });

  await t.test('91-prefixed and spaced forms reach the same number', () => {
    for (const raw of ['918786564981', '+91 87865 64981', '87865-64981'.replace('-', ' ')]) {
      const normalized = normalizeIndianPhone(importOne(raw).phoneNumber);
      assert.ok(normalized.ok, `${raw} should be usable`);
      assert.equal((normalized as any).e164, '+918786564981', `${raw} must not lose digits`);
    }
  });

  await t.test('an invalid number is left for the importer to flag, not silently dropped', () => {
    const contact = importOne('12345');
    assert.equal(contact.phoneNumber, '12345');
    assert.equal(normalizeIndianPhone(contact.phoneNumber).ok, false);
  });
});

test('validation', async (t) => {
  await t.test('a sheet with no Contact Number column is refused, naming the format', () => {
    const error = thrown(() => extractFromExcel(sheetBuffer([['Sr.No', 'Guest Name'], [1, 'Suresh']])));
    assert.match(error.message, /Contact Number/);
    assert.match(error.message, /Sr\.No \| Guest Name \| Contact Number/);
  });

  await t.test('a sheet with no Guest Name column is refused', () => {
    const error = thrown(() =>
      extractFromExcel(sheetBuffer([['Sr.No', 'Contact Number'], [1, '8786564981']]))
    );
    assert.match(error.message, /Guest Name/);
  });

  await t.test('the error repeats the headings it did find', () => {
    const error = thrown(() =>
      extractFromExcel(sheetBuffer([['Column A', 'Column B'], ['x', 'y']]))
    );
    assert.match(error.message, /Column A, Column B/);
  });

  await t.test('a column that merely contains "name" is not taken as the guest name', () => {
    // "Event Name" contains "name", and the number column here is perfectly
    // valid — so nothing else would stop the import. The old substring matcher
    // paired the two and imported an event list as guests; strict matching
    // refuses the sheet instead.
    const error = thrown(() =>
      extractFromExcel(
        sheetBuffer([['Event Name', 'Contact Number'], ['Sangeet Night', '8786564981']])
      )
    );
    assert.match(error.message, /Guest Name/, 'it must say which column is missing');
  });

  await t.test('a column that merely contains "number" is not taken as the phone', () => {
    const error = thrown(() =>
      extractFromExcel(sheetBuffer([['Guest Name', 'Ticket Number'], ['Suresh', 'T-42']]))
    );
    assert.match(error.message, /Contact Number/);
  });

  await t.test('an empty sheet is refused rather than importing nothing silently', () => {
    assert.match(thrown(() => extractFromExcel(sheetBuffer([]))).message, /empty/i);
  });

  await t.test('a row with no name is kept, so the importer can flag it', () => {
    const contacts = extractFromExcel(sheetBuffer([REFERENCE[0], [1, '', '8786564981']]));
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].fullName, '', 'no placeholder name is invented');
    assert.equal(contacts[0].phoneNumber, '8786564981');
  });

  await t.test('a row with no number is kept too', () => {
    const contacts = extractFromExcel(sheetBuffer([REFERENCE[0], [1, 'Suresh', '']]));
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].phoneNumber, '');
  });

  await t.test('blank rows are skipped, including one with only a serial number', () => {
    const contacts = extractFromExcel(
      sheetBuffer([REFERENCE[0], [1, 'Suresh', '8786564981'], ['', '', ''], [2, '', '']])
    );
    assert.equal(contacts.length, 1, 'only the real guest survives');
  });

  await t.test('the offending row can be pointed at', () => {
    const contacts = extractFromExcel(sheetBuffer([REFERENCE[0], [1, 'Suresh', '8786564981']]));
    assert.equal(contacts[0].rowNumber, 2, 'row 1 is the heading');
  });
});


/**
 * Contact import — the PDF format.
 *
 *   Sr.No | Guest Name | Contact Number
 *
 * pdf-parse hands back one line per table row with the cells run together and
 * no delimiter between them. The strings below are not invented: they are the
 * text a real PDF of this table produced, captured verbatim, down to the
 * blank leading lines and the heading with its three columns joined up.
 *
 * parsePdfGuestRows is the half of extractFromPDF that does the reading, split
 * out so these cases can be written as plain text rather than as binary
 * fixtures. extractFromPDF itself only reads the document and calls it.
 */

/** The reference list, exactly as pdf-parse renders it. */
const PDF_REFERENCE = [
  '',
  '',
  'Guest List',
  'Sr.NoGuest NameContact Number',
  '1Akshat Singh+919068578590',
  '2Sashi+919121604967',
  '3Swapnil Jagtap+919834653925',
  '4Shankar Kshirsagar+919704038464',
  '5Swapnil Mudgade+918766813161',
  '6Shubham Suryavanshi+918530808862',
  '7Aditya Shankar Kshirsagar+919112472833',
].join('\n');

test('the PDF format', async (t) => {
  await t.test('every guest arrives under their own name', () => {
    const contacts = parsePdfGuestRows(PDF_REFERENCE);

    assert.deepEqual(
      contacts.map((c) => [c.rowNumber, c.fullName, c.phoneNumber]),
      [
        [1, 'Akshat Singh', '+919068578590'],
        [2, 'Sashi', '+919121604967'],
        [3, 'Swapnil Jagtap', '+919834653925'],
        [4, 'Shankar Kshirsagar', '+919704038464'],
        [5, 'Swapnil Mudgade', '+918766813161'],
        [6, 'Shubham Suryavanshi', '+918530808862'],
        [7, 'Aditya Shankar Kshirsagar', '+919112472833'],
      ]
    );
  });

  await t.test('seven rows, and nothing else from the page', () => {
    // The title and the heading are both above the table and both survive
    // into the text; neither may become a guest.
    assert.equal(parsePdfGuestRows(PDF_REFERENCE).length, 7);
  });

  await t.test('no name is ever invented', () => {
    const names = parsePdfGuestRows(PDF_REFERENCE).map((c) => c.fullName);
    assert.equal(names.includes('Unknown Guest (PDF)'), false);
    assert.equal(names.every((n) => n.length > 0), true);
  });

  await t.test('the heading is not read as a guest', () => {
    // It has no trailing number, which is the whole reason it is skipped.
    assert.deepEqual(parsePdfGuestRows('Sr.NoGuest NameContact Number'), []);
  });

  await t.test('a row with no name keeps an empty name rather than a placeholder', () => {
    // The controller is what rejects this row, with "Guest Name is missing".
    // Inventing a name here is exactly what hid the gap before.
    const [contact] = parsePdfGuestRows('+919068578590');
    assert.equal(contact.fullName, '');
    assert.equal(contact.phoneNumber, '+919068578590');
  });

  await t.test('a repeated number is kept, for the controller to report', () => {
    const contacts = parsePdfGuestRows(
      ['1Akshat Singh+919068578590', '2Akshat Singh+919068578590'].join('\n')
    );
    assert.equal(contacts.length, 2, 'both rows survive the extractor');
    assert.deepEqual(contacts.map((c) => c.phoneNumber), ['+919068578590', '+919068578590']);
  });

  await t.test('spacing between the three cells does not matter', () => {
    const spaced = parsePdfGuestRows(
      [
        '1  Akshat Singh  +91 90685 78590',
        '2.  Sashi\t+919121604967',
        '3) Swapnil Jagtap  +91-98346-53925',
      ].join('\n')
    );
    assert.deepEqual(
      spaced.map((c) => [c.rowNumber, c.fullName, c.phoneNumber]),
      [
        [1, 'Akshat Singh', '+919068578590'],
        [2, 'Sashi', '+919121604967'],
        [3, 'Swapnil Jagtap', '+919834653925'],
      ]
    );
  });

  await t.test('a row with no Sr.No still reads as a guest', () => {
    const [contact] = parsePdfGuestRows('Akshat Singh+919068578590');
    assert.equal(contact.fullName, 'Akshat Singh');
    assert.equal(contact.phoneNumber, '+919068578590');
  });

  await t.test('the Sr.No is never mistaken for the number', () => {
    // Both are digits and they sit on the same line with nothing between them
    // and the name, so the trailing one has to win.
    const [contact] = parsePdfGuestRows('12Akshat Singh+919068578590');
    assert.equal(contact.phoneNumber, '+919068578590');
    assert.equal(contact.fullName, 'Akshat Singh');
    assert.equal(contact.rowNumber, 12);
  });

  await t.test('an earlier number on the line does not win over the contact number', () => {
    // A sheet exported with a booking reference or a date beside the guest
    // puts a second long number on the row. The contact is the one at the
    // END of the line, which is the only thing telling them apart.
    const [contact] = parsePdfGuestRows('4  20240115  Shankar Kshirsagar  +919704038464');
    assert.equal(contact.phoneNumber, '+919704038464');
  });

  await t.test('an empty document yields nothing rather than throwing', () => {
    assert.deepEqual(parsePdfGuestRows(''), []);
  });
});
