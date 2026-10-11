/**
 * Adding contacts to a Sub-Event's member list (POST /events/:id/members).
 *
 * Kept out of the components so the batching, the merging of batch results
 * and the wording of the outcome can be tested directly.
 *
 * The server takes at most 500 ids per request and reports every id as added,
 * already a member, rejected (will not succeed on retry) or failed (safe to
 * retry). A larger selection is sent in batches, one after another, and the
 * outcome reported is the sum of what the server said - never the size of the
 * selection.
 */

import { formatDateTime } from './datetime';
import type { ReportColumn, ReportMeta } from './reportExport';

/** Ids per request; below the server's 500 so a request stays small. */
export const ADD_MEMBERS_BATCH_SIZE = 200;

export interface MemberIssue {
  id: string;
  reason: string;
}

export interface AddMembersOutcome {
  added: string[];
  alreadyMembers: string[];
  /** Refused by the server (not found, not available, invalid). Retrying will not help. */
  rejected: MemberIssue[];
  /** Not written: a server or network error. Safe to retry. */
  failed: MemberIssue[];
  /** The list's size after the last batch that answered, if any did. */
  memberCount: number | null;
}

export const emptyOutcome = (): AddMembersOutcome => ({
  added: [],
  alreadyMembers: [],
  rejected: [],
  failed: [],
  memberCount: null,
});

/** Splits ids into request-sized batches, dropping repeats. */
export const chunkIds = (ids: readonly string[], size = ADD_MEMBERS_BATCH_SIZE): string[][] => {
  const unique = Array.from(new Set(ids));
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
};

/**
 * Folds one batch's response body into the running outcome. A 207 or 4xx body
 * carries the same fields as a 200, so it is read the same way.
 */
export const mergeBatchResponse = (outcome: AddMembersOutcome, body: any): AddMembersOutcome => ({
  added: [...outcome.added, ...(Array.isArray(body?.added) ? body.added : [])],
  alreadyMembers: [...outcome.alreadyMembers, ...(Array.isArray(body?.alreadyMembers) ? body.alreadyMembers : [])],
  rejected: [...outcome.rejected, ...(Array.isArray(body?.rejected) ? body.rejected : [])],
  failed: [...outcome.failed, ...(Array.isArray(body?.failed) ? body.failed : [])],
  memberCount: typeof body?.memberCount === 'number' ? body.memberCount : outcome.memberCount,
});

/**
 * A batch that got no per-id answer at all (network down, server error with no
 * body) - every id in it is recorded as failed, so it can be retried.
 */
export const mergeBatchFailure = (outcome: AddMembersOutcome, ids: readonly string[], reason: string): AddMembersOutcome => ({
  ...outcome,
  failed: [...outcome.failed, ...ids.map((id) => ({ id, reason }))],
});

/** The ids worth sending again: those that failed, not those the server refused. */
export const retryableIds = (outcome: AddMembersOutcome): string[] => Array.from(new Set(outcome.failed.map((f) => f.id)));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One line for the toast and the result panel. The tone is 'success' only when
 * nothing was refused or failed; a partial outcome is a warning that says so.
 */
export const describeOutcome = (outcome: AddMembersOutcome): { tone: 'success' | 'warning' | 'error' | 'info'; message: string } => {
  const added = outcome.added.length;
  const already = outcome.alreadyMembers.length;
  const notAdded = outcome.rejected.length + outcome.failed.length;
  const parts: string[] = [];
  if (added > 0) parts.push(`${plural(added, 'contact')} added`);
  if (already > 0) parts.push(`${plural(already, 'contact')} already ${already === 1 ? 'a member' : 'members'}`);
  if (notAdded > 0) parts.push(`${plural(notAdded, 'contact')} could not be added`);

  if (notAdded === 0 && added === 0 && already > 0) {
    return { tone: 'info', message: `All selected contacts are already members (${already}).` };
  }
  if (notAdded === 0) return { tone: 'success', message: `${parts.join(', ')}.` };
  if (added + already === 0) return { tone: 'error', message: `${parts.join(', ')}.` };
  return { tone: 'warning', message: `${parts.join(', ')}.` };
};

/** "3 members", "1 member", "No members". */
export const memberCountLabel = (count: number | undefined | null): string =>
  !count ? 'No members' : plural(count, 'member');

/** "2 sub-events", "1 sub-event". */
export const subEventCountLabel = (count: number): string => plural(count, 'sub-event');

/** A row of a Sub-Event's member list (GET /events/:id/members). */
export interface SubEventMember {
  _id: string;
  fullName: string;
  phoneNumber: string;
  email?: string;
  status: string;
  addedAt?: string | null;
  sourceEvent: { _id: string; eventId?: string; eventName: string } | null;
}

/** The columns of the member download - the member table's, in the same order. */
export const MEMBER_EXPORT_COLUMNS: ReportColumn<SubEventMember>[] = [
  { header: 'Full Name', value: (m) => m.fullName || '-', width: 26 },
  { header: 'Phone', value: (m) => m.phoneNumber || '-', width: 18 },
  { header: 'Email', value: (m) => m.email || '-', width: 28 },
  {
    header: 'Added From',
    value: (m) => (m.sourceEvent ? `${m.sourceEvent.eventId ? `${m.sourceEvent.eventId} | ` : ''}${m.sourceEvent.eventName}` : '-'),
    width: 28,
  },
  { header: 'Status', value: (m) => m.status || '-', width: 12 },
  { header: 'Added On', value: (m) => formatDateTime(m.addedAt, '-'), width: 22 },
];

const eventLabel = (e: { eventId?: string; eventName: string }) => `${e.eventId ? `${e.eventId} | ` : ''}${e.eventName}`;

/**
 * The lines at the top of the member download: which sub-event, of which Main
 * Event, the search it was taken with, and how many members it holds - counted
 * from the rows written below them, so the two can never disagree.
 */
export const buildMemberExportMeta = (
  subEvent: { eventId?: string; eventName: string; parentEvent?: { eventId?: string; eventName: string } | null },
  search: string,
  rows: readonly SubEventMember[]
): ReportMeta => ({
  rows: [
    ['Sub-Event', eventLabel(subEvent)],
    ['Main Event', subEvent.parentEvent ? eventLabel(subEvent.parentEvent) : '-'],
    ['Search Value', search.trim() || '-'],
    ['Members', String(rows.length)],
  ],
});
