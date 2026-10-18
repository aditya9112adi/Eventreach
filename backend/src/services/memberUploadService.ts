import { DEFAULT_COUNTRY_CODE } from '@eventreach/shared';
import type { MemberUploadRow } from '@eventreach/shared';
import { normalizeIndianPhone } from '../utils/indianPhone';
import type { RawContact } from '../utils/fileExtractors';

/**
 * Uploading a file of guests onto a Sub-Event's member list.
 *
 * The file is read, and every number checked, by the same code the Contact Bulk
 * upload uses (utils/fileExtractors, utils/indianPhone). What differs is the
 * last step: a Sub-Event's members are EXISTING contacts (see models/EventMember),
 * so a row is matched to a contact the caller may use rather than creating one.
 * A number that is not a contact is reported and skipped; nothing is created, and
 * neither the Main Event nor any other Sub-Event is touched.
 *
 * Pure functions, so every rule can be tested without a database.
 */

/** Rows read from one file; larger files are refused rather than half-processed. */
export const MEMBER_UPLOAD_MAX_ROWS = 5000;

const TYPES: Record<string, { mimetype: string; magic: (b: Buffer) => boolean; label: string }> = {
  '.xlsx': {
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    magic: (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b, // a zip container: "PK"
    label: 'Excel (.xlsx)',
  },
  '.xls': {
    mimetype: 'application/vnd.ms-excel',
    magic: (b) => b.length > 3 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0,
    label: 'Excel (.xls)',
  },
  '.pdf': {
    mimetype: 'application/pdf',
    magic: (b) => b.length > 4 && b.subarray(0, 5).toString('latin1') === '%PDF-',
    label: 'PDF',
  },
};

export const isPdfUpload = (file: { originalname: string }): boolean => /\.pdf$/i.test(file.originalname);

/**
 * The checks on the file itself: extension, that the declared type agrees with
 * it, that it is not empty, and that its first bytes are what the extension
 * claims. Returns a message for the uploader, or null. The browser checks the
 * same things first, but nothing here trusts that.
 */
export const validateUploadFile = (file: {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}): string | null => {
  const name = String(file.originalname ?? '');
  const ext = /\.[A-Za-z0-9]+$/.exec(name)?.[0].toLowerCase() ?? '';
  const type = TYPES[ext];
  if (!type) return 'Unsupported file type. Upload an Excel (.xlsx, .xls) or PDF (.pdf) file.';
  if (file.mimetype !== type.mimetype) return `The file does not match its ${ext} extension. Check the file and try again.`;
  const buffer = file.buffer;
  if (!buffer || buffer.length === 0 || file.size === 0) return 'The file is empty.';
  if (!type.magic(buffer)) return `The file content is not a valid ${type.label} file.`;
  return null;
};

export interface NormalizedUploadRow {
  fullName: string;
  email?: string;
  /** The number as stored on contacts (+91...) when valid; otherwise as written in the file. */
  phoneNumber: string;
  /** Why the row cannot be used, or undefined. */
  problem?: string;
}

/** The same two rules the Contact Bulk preview applies to every row: a usable number and a name. */
export const normalizeUploadRows = (rows: RawContact[]): NormalizedUploadRow[] =>
  rows.map((raw) => {
    let phoneNumber = raw.phoneNumber;
    let problem: string | undefined;

    const phone = normalizeIndianPhone(raw.phoneNumber);
    if (phone.ok) phoneNumber = phone.e164;
    else problem = phone.reason;

    if (!raw.fullName || !raw.fullName.trim()) {
      problem = problem ? `${problem} Guest Name is also missing.` : 'Guest Name is missing.';
    }
    return { fullName: raw.fullName, email: raw.email, phoneNumber, ...(problem ? { problem } : {}) };
  });

export interface MemberMatch {
  contactId: string;
  fullName: string;
}

/**
 * Gives every row its outcome:
 *  - Invalid    the number or name is unusable (same rules as Contact Bulk);
 *  - NotFound   no such contact among those this Sub-Event may use - skipped;
 *  - Duplicate  already on this Sub-Event's list, or repeated earlier in the file;
 *  - Valid      a contact that will be added by confirming.
 */
export const classifyMemberRows = (
  rows: NormalizedUploadRow[],
  matches: Map<string, MemberMatch>,
  memberContactIds: Set<string>,
  now = Date.now()
): MemberUploadRow[] => {
  const seenContacts = new Set<string>();
  return rows.map((row, i) => {
    const base = {
      id: `temp_${now}_${i}`,
      fullName: row.fullName,
      phoneNumber: row.phoneNumber,
      countryCode: DEFAULT_COUNTRY_CODE,
      ...(row.email ? { email: row.email } : {}),
    };
    if (row.problem) return { ...base, status: 'Invalid' as const, validationReason: row.problem };

    const match = matches.get(row.phoneNumber);
    if (!match) return { ...base, status: 'NotFound' as const, validationReason: 'Not in your contacts' };

    const known = { ...base, contactId: match.contactId, matchedName: match.fullName };
    if (memberContactIds.has(match.contactId)) {
      return { ...known, status: 'Duplicate' as const, validationReason: 'Already a member of this sub-event' };
    }
    if (seenContacts.has(match.contactId)) {
      return { ...known, status: 'Duplicate' as const, validationReason: 'Duplicate in file' };
    }
    seenContacts.add(match.contactId);
    return { ...known, status: 'Valid' as const };
  });
};

export const countUploadRows = (rows: MemberUploadRow[]) => ({
  total: rows.length,
  valid: rows.filter((r) => r.status === 'Valid').length,
  duplicate: rows.filter((r) => r.status === 'Duplicate').length,
  notFound: rows.filter((r) => r.status === 'NotFound').length,
  invalid: rows.filter((r) => r.status === 'Invalid').length,
});
