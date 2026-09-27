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
import { extractFromExcel, ImportFormatError, IMPORT_COLUMNS } from '../src/utils/fileExtractors';
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
