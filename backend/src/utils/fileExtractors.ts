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

/**
 * The contact number at the end of a row.
 *
 * Anchored to the end of the line so it is the trailing run of digits that is
 * taken, never the Sr.No at the front. The inner class allows the spacing a
 * real document uses — "+91 98765 43210", "(020) 1234-5678" — which is then
 * stripped to the same digits-and-plus shape the sheet importer produces.
 */
const PDF_TRAILING_PHONE = /(\+?\d[\d\s().-]{7,}\d)\s*$/;

/** The uploader's own Sr.No at the front of a row, with or without a separator. */
const PDF_LEADING_SERIAL = /^(\d{1,4})\s*[.)\-:]?\s*/;

/**
 * Guest rows out of a PDF.
 *
 * pdf-parse returns one line per table row, with the cells run together and no
 * delimiter between them:
 *
 *   Sr.NoGuest NameContact Number
 *   1Akshat Singh+919068578590
 *
 * so each line is read on its own. Scanning the whole document for anything
 * number-shaped, as this did before, throws that row structure away — which is
 * why every guest arrived under one hardcoded placeholder name.
 *
 * A line with no trailing number is not a guest row. That is what skips the
 * heading and any title above the table, without having to recognise them.
 */
export const parsePdfGuestRows = (text: string): RawContact[] => {
  const contacts: RawContact[] = [];

  const lines = String(text ?? '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const phoneMatch = PDF_TRAILING_PHONE.exec(line);
    if (!phoneMatch) continue;

    // Everything before the number is the Sr.No and the name, in that order.
    const beforePhone = line.slice(0, phoneMatch.index);
    const serialMatch = PDF_LEADING_SERIAL.exec(beforePhone);

    contacts.push({
      // Left empty when the row carries no name, exactly as the sheet importer
      // leaves it: the controller flags that row Invalid rather than having a
      // placeholder invented for it here.
      fullName: (serialMatch ? beforePhone.slice(serialMatch[0].length) : beforePhone).trim(),
      // Same digits-and-plus reduction the sheet importer applies, so both
      // formats reach the one phone rule this application has unchanged.
      phoneNumber: phoneMatch[1].replace(/[^0-9+]/g, ''),
      // The uploader's Sr.No when the row has one, otherwise the line it came
      // from. Used only to point at a row in a validation message.
      rowNumber: serialMatch ? Number(serialMatch[1]) : i + 1,
    });
  }

  /**
   * Deliberately not de-duplicated here. The sheet importer does not either:
   * the controller compares each row against the event and against the rest of
   * the batch, and reports what it finds. Dropping repeats at this point hid
   * them from that count entirely.
   */
  return contacts;
};

/** Reads the document, then hands its text to the row parser above. */
export const extractFromPDF = async (buffer: Buffer): Promise<RawContact[]> => {
  const data = await pdf(buffer);
  return parsePdfGuestRows(data?.text ?? '');
};
