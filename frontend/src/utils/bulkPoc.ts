import { normalizeIndianMobile } from '@eventreach/shared';

/**
 * The Bulk POC page's pure logic: checking the number before asking the
 * server, deciding when Confirm may be pressed, and wording the outcome. The
 * server validates again and decides the scope; this only avoids a round
 * trip for an obviously wrong number.
 */

export interface BulkPocCounts {
  inScope: number;
  willUpdate: number;
  alreadySet: number;
  noLocalPoc: number;
  inheritingSubEvents: number;
}

export interface BulkPocPreview {
  scope: { kind: 'all' | 'own'; label: string };
  includePast: boolean;
  mobile: string;
  counts: BulkPocCounts;
  /** Fingerprint of exactly which events would change; confirming must send it back. */
  scopeToken: string;
}

export interface BulkPocResult extends BulkPocPreview {
  bulkOperationId: string;
  expected: number;
  updated: number;
  skipped: { alreadySet: number; noLocalPoc: number; changedMeanwhile: number };
  failed: number;
  failures: { batch: number; events: number; reason: string }[];
  /** `completed: false`: the update was applied but its outcome could not be written to the audit log. */
  audit?: { runId: string; started: boolean; completed: boolean };
}

/** '' when the number looks like an Indian mobile, otherwise why not. */
export const pocMobileProblem = (raw: string): string => {
  const result = normalizeIndianMobile(raw);
  return result.ok ? '' : result.reason.replace('WhatsApp number', 'mobile number');
};

/** Confirm needs a current review that would change something, and no run in progress. */
export const canConfirmBulkPoc = (preview: BulkPocPreview | null, isApplying: boolean): boolean =>
  !!preview && !isApplying && preview.counts.willUpdate > 0;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The headline after a run, and whether it is a success. Never claims more than was done. */
export const bulkPocOutcome = (result: BulkPocResult): { tone: 'success' | 'warning' | 'error'; text: string } => {
  const skipped = result.skipped.alreadySet + result.skipped.noLocalPoc + result.skipped.changedMeanwhile;
  const auditGap = result.audit?.completed === false;
  const text = `Updated ${plural(result.updated, 'event')}; ${skipped} skipped; ${result.failed} failed.${auditGap ? ' The outcome could not be written to the audit log.' : ''}`;
  if (result.failed > 0) return { tone: result.updated > 0 ? 'warning' : 'error', text };
  // Applied, but not fully audited: never shown as a clean success.
  if (auditGap) return { tone: 'warning', text };
  return { tone: 'success', text };
};
