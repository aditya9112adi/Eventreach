import * as xlsx from 'xlsx';
const pdf = require('pdf-parse');

export interface RawContact {
  fullName: string;
  phoneNumber: string;
  email?: string;
  /**
   * The sheet row this came from (1-based, counting the header). Used only to
   * point at the offending line in a validation message — never stored.
   */
  rowNumber?: number;
}

/** A header the importer could not make sense of. */
export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

/** The format the sample and the instructions describe. */
export const IMPORT_COLUMNS = ['Sr.No', 'Guest Name', 'Contact Number'] as const;

/**
 * Header matching.
 *
 * Deliberately an ALLOW LIST of exact spellings rather than a substring
 * search. The previous version took the first header containing "name" and the
 * first containing "number", which quietly mapped whatever happened to match —
 * "Event Name" into the guest's name, or a serial column into the phone. A
 * column that is not recognised is now left alone, and a sheet missing a
 * required column is refused with a message naming what it needed.
 */
const normalizeHeader = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '');

const NAME_HEADERS = new Set(['guestname', 'name', 'fullname', 'contactname', 'guest']);
const PHONE_HEADERS = new Set([
  'contactnumber',
  'phonenumber',
  'mobilenumber',
  'contactno',
  'mobileno',
  'phoneno',
  'mobile',
  'phone',
  'whatsappnumber',
  'number',
]);
const SERIAL_HEADERS = new Set(['srno', 'sr', 'sno', 'serialno', 'serialnumber', 'serial', 'slno', 'no']);
const EMAIL_HEADERS = new Set(['email', 'emailaddress', 'emailid']);

/** Excel sometimes hands back a number-formatted cell as "9876543210.0". */
const cellToText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return String(value);
  return String(value).trim().replace(/\.0+$/, '');
};

export const extractFromExcel = (buffer: Buffer): RawContact[] => {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ImportFormatError('The file has no sheets to read.');

  const sheet = workbook.Sheets[sheetName];
  // header: 1 keeps the raw header row, so the columns can be matched and
  // reported on rather than guessed at from whatever keys xlsx invents.
  const grid: any[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (grid.length === 0) throw new ImportFormatError('The sheet is empty.');

  const headers = (grid[0] || []).map((h) => cellToText(h));
  const indexOf = (allowed: Set<string>) =>
    headers.findIndex((header) => allowed.has(normalizeHeader(header)));

  const serialIndex = indexOf(SERIAL_HEADERS);
  const nameIndex = indexOf(NAME_HEADERS);
  const phoneIndex = indexOf(PHONE_HEADERS);
  const emailIndex = indexOf(EMAIL_HEADERS);

  const missing = [
    nameIndex === -1 ? 'Guest Name' : null,
    phoneIndex === -1 ? 'Contact Number' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    const found = headers.filter(Boolean).join(', ') || '(no headings)';
    throw new ImportFormatError(
      `The sheet is missing ${missing.join(' and ')}. Expected columns: ${IMPORT_COLUMNS.join(' | ')}. Found: ${found}.`
    );
  }

  const contacts: RawContact[] = [];

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const fullName = cellToText(row[nameIndex]);
    const phoneNumber = cellToText(row[phoneIndex]);
    const email = emailIndex === -1 ? '' : cellToText(row[emailIndex]);

    // A row with neither a name nor a number is blank padding, not a guest.
    // Sr.No alone does not make a row, which is why it is read but not used
    // to decide this.
    if (!fullName && !phoneNumber) continue;

    contacts.push({
      // Kept as given, including empty: the caller flags a missing name as an
      // invalid row rather than inventing a placeholder for it.
      fullName,
      // Everything but digits and a leading + goes, so "+91 98765 43210" and
      // "98765-43210" both reach the one phone rule this application has.
      phoneNumber: phoneNumber.replace(/[^0-9+]/g, ''),
      email: email || undefined,
      rowNumber: i + 1,
    });
  }

  // Sr.No is read for header validation only. It is the uploader's own
  // numbering and means nothing once the rows are in the database, so it is
  // deliberately not carried any further.
  void serialIndex;

  return contacts;
};

export const extractFromPDF = async (buffer: Buffer): Promise<RawContact[]> => {
  const data = await pdf(buffer);
  const text = data.text;

  const contacts: RawContact[] = [];

  // Basic Regex for phone numbers (looks for international or local formats)
  // This can be improved depending on the exact PDF structures
  const phoneRegex = /(?:\+?\d{1,3}[-\s]?)?\(?\d{3}\)?[-\s]?\d{3}[-\s]?\d{4}/g;

  const matches = text.match(phoneRegex);

  if (matches) {
    for (const match of matches) {
      contacts.push({
        fullName: 'Unknown Guest (PDF)', // Hard to reliably extract names from unstructured PDF
        phoneNumber: match.replace(/[^0-9+]/g, ''),
      });
    }
  }

  // Remove duplicates from the raw extraction
  const uniqueContacts = Array.from(new Map(contacts.map(c => [c.phoneNumber, c])).values());

  return uniqueContacts;
};
