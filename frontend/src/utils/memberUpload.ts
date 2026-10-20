import type { MemberUploadRow } from '@eventreach/shared';
import type { AddMembersOutcome } from './subEventMembers';

/**
 * Uploading a file of guests onto a Sub-Event's member list.
 *
 * The server reads the file and matches each row to an existing contact
 * (POST /events/:id/members/upload, which saves nothing); confirming sends the
 * matched contact ids through the batched add in subEventMembers.ts
 * (see subEventMembers.ts). These helpers hold the checks and wording that are
 * not React, so they can be tested directly.
 */

/** The server refuses larger files; stopping them here saves the round trip. */
export const MEMBER_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export const MEMBER_UPLOAD_ACCEPT = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/pdf': ['.pdf'],
};

/** What the browser can check before sending. The server checks all of it again. */
export const checkMemberUploadFile = (file: { name: string; size: number }): string | null => {
  if (!/\.(xlsx|xls|pdf)$/i.test(file.name)) return 'Unsupported file type. Choose an Excel (.xlsx, .xls) or PDF (.pdf) file.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MEMBER_UPLOAD_MAX_BYTES) return 'The file is larger than 10 MB.';
  return null;
};

export interface UploadCounts {
  total: number;
  valid: number;
  duplicate: number;
  notFound: number;
  invalid: number;
}

export const summarizeRows = (rows: readonly MemberUploadRow[]): UploadCounts => ({
  total: rows.length,
  valid: rows.filter((r) => r.status === 'Valid').length,
  duplicate: rows.filter((r) => r.status === 'Duplicate').length,
  notFound: rows.filter((r) => r.status === 'NotFound').length,
  invalid: rows.filter((r) => r.status === 'Invalid').length,
});

/** The contacts that confirming will add: matched, valid rows, each once. */
export const validContactIds = (rows: readonly MemberUploadRow[]): string[] =>
  Array.from(new Set(rows.filter((r) => r.status === 'Valid' && r.contactId).map((r) => r.contactId as string)));

export const withoutStatus = (rows: readonly MemberUploadRow[], status: MemberUploadRow['status']): MemberUploadRow[] =>
  rows.filter((r) => r.status !== status);

export interface UploadResult {
  tone: 'success' | 'warning' | 'error' | 'info';
  /** The headline counts, each shown once. */
  added: number;
  alreadyMembers: number;
  notInContacts: number;
  invalid: number;
  notAdded: number;
  message: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The outcome of confirming. `counts` are those of the preview as it stood when
 * confirmed (rows the user removed are not counted); `outcome` is what the
 * server said. Rows skipped before the server was asked - duplicates, numbers
 * that are not contacts, invalid rows - are reported beside what it added.
 */
export const describeUploadResult = (counts: UploadCounts, outcome: AddMembersOutcome): UploadResult => {
  const added = outcome.added.length;
  const alreadyMembers = outcome.alreadyMembers.length + counts.duplicate;
  const notAdded = outcome.rejected.length + outcome.failed.length;
  const parts: string[] = [];
  if (added > 0) parts.push(`${plural(added, 'member')} added`);
  if (alreadyMembers > 0) parts.push(`${alreadyMembers} skipped (already ${alreadyMembers === 1 ? 'a member' : 'members'} or repeated)`);
  if (counts.notFound > 0) parts.push(`${counts.notFound} skipped (not in your contacts)`);
  if (counts.invalid > 0) parts.push(`${counts.invalid} skipped (invalid)`);
  if (notAdded > 0) parts.push(`${notAdded} could not be added`);

  const tone = notAdded > 0 ? (added > 0 ? 'warning' : 'error') : added > 0 ? 'success' : 'info';
  const message = parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing was added.';
  return { tone, added, alreadyMembers, notInContacts: counts.notFound, invalid: counts.invalid, notAdded, message };
};
