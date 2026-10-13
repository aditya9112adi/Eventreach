import crypto from 'crypto';
import mongoose from 'mongoose';
import { Event } from '../models/Event';
import { normalizeIndianPhone } from '../utils/indianPhone';

/**
 * One user-initiated change of the POC mobile number across every event in
 * the caller's scope.
 *
 * Scope follows decision B (eventOwnership.canEditEventContact): a Super
 * Admin may edit any event's contact settings, so their scope is every
 * event; an Admin may edit only the events they own - a Main Event whose
 * adminId is theirs (or, without an adminId, which they created), and that
 * Main Event's Sub-Events when the Sub-Event's own adminId agrees. Events an
 * Admin merely sees because one of their Users is assigned are never in it.
 *
 * Only `poc.mobile` changes, and only on events that already have their own
 * POC: an event without one has no POC name to go with a number, and a
 * Sub-Event without one shows its Main Event's, so it follows that update.
 * Nothing else is touched - not the POC's name, email or responsibility, not
 * the WhatsApp sender, not ownership.
 *
 * Past (Completed or Cancelled) events are left alone unless the caller
 * explicitly includes them.
 *
 * The write is a series of bounded updateMany calls. MongoDB does not make
 * them one transaction here, so a failure part-way is reported as exactly
 * that: some events updated, the rest counted as failed.
 */

export const BULK_POC_BATCH_SIZE = 500;

export class BulkPocError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, httpStatus: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BulkPocError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export interface BulkPocActor {
  id?: string;
  role?: string;
}

export type BulkPocScope = { kind: 'all' } | { kind: 'own'; adminId: string };

export interface BulkPocCounts {
  /** Events in scope (and in the chosen status range). */
  inScope: number;
  /** Events whose own POC will get the new number. */
  willUpdate: number;
  /** Events whose own POC already has the new number. */
  alreadySet: number;
  /** Events with no POC of their own: nothing to change. */
  noLocalPoc: number;
  /** Of those, Sub-Events: they show their Main Event's POC. */
  inheritingSubEvents: number;
}

export interface BulkPocPreview {
  scope: { kind: BulkPocScope['kind']; label: string };
  includePast: boolean;
  mobile: string;
  counts: BulkPocCounts;
  /**
   * A fingerprint of exactly which events would change. Confirming requires
   * it, so a review only ever confirms the events it counted - not another
   * set that happens to be the same size.
   */
  scopeToken: string;
}

export interface BulkPocResult extends BulkPocPreview {
  bulkOperationId: string;
  expected: number;
  updated: number;
  skipped: { alreadySet: number; noLocalPoc: number; changedMeanwhile: number };
  failed: number;
  failures: { batch: number; events: number; reason: string }[];
}

export interface BulkPocDeps {
  batchSize?: number;
  /** Applies one batch; injectable so a failure part-way can be tested. */
  updateBatch?: (filter: Record<string, unknown>, mobile: string, batchIndex: number) => Promise<{ matchedCount: number; modifiedCount: number }>;
  /** Reads the ids to update, in id order; injectable so a read failing part-way can be tested. */
  readIds?: (filter: Record<string, unknown>, batchSize: number) => AsyncIterable<{ _id: unknown }>;
}

/** "+91******2833": enough to recognise the number in an audit entry, not to use it. */
export const maskMobile = (e164: string): string =>
  e164.length > 7 ? `${e164.slice(0, 3)}${'*'.repeat(e164.length - 7)}${e164.slice(-4)}` : '****';

export const resolveBulkPocScope = (actor: BulkPocActor | undefined): BulkPocScope => {
  if (actor?.role === 'SuperAdmin') return { kind: 'all' };
  if (actor?.role === 'Admin' && actor.id && mongoose.isValidObjectId(actor.id)) return { kind: 'own', adminId: String(actor.id) };
  throw new BulkPocError('ACCESS_DENIED', 'Only Admins and Super Admins can update POC numbers in bulk.', 403);
};

export const validateBulkPocMobile = (raw: unknown): string => {
  const phone = normalizeIndianPhone(raw);
  if (!phone.ok) {
    throw new BulkPocError('INVALID_MOBILE', `Enter a valid Indian mobile number for the POC. ${phone.reason}`, 400);
  }
  return phone.e164;
};

const HAS_LOCAL_POC = { 'poc.mobile': { $exists: true, $nin: [null, ''] } };
const NO_LOCAL_POC = { $or: [{ 'poc.mobile': { $exists: false } }, { 'poc.mobile': { $in: [null, ''] } }] };

/**
 * The events in scope, as a MongoDB filter. For an Admin this mirrors
 * resolveEventOwner: Main Events they own, and Sub-Events whose adminId does
 * not contradict their Main Event's.
 */
const scopeFilter = async (scope: BulkPocScope, includePast: boolean): Promise<Record<string, unknown>> => {
  const status = includePast ? {} : { eventStatus: 'Upcoming' };
  if (scope.kind === 'all') return status;

  const admin = new mongoose.Types.ObjectId(scope.adminId);
  const mains: any[] = await Event.find({
    parentEventId: null,
    $or: [{ adminId: admin }, { adminId: null, createdBy: admin }],
  }).select('_id adminId').lean();
  const byAdminId = mains.filter((m) => m.adminId && String(m.adminId) === scope.adminId).map((m) => m._id);
  const byCreator = mains.filter((m) => !m.adminId).map((m) => m._id);

  return {
    ...status,
    $or: [
      { _id: { $in: mains.map((m) => m._id) } },
      { parentEventId: { $in: byAdminId }, adminId: { $in: [admin, null] } },
      { parentEventId: { $in: byCreator }, adminId: null },
    ],
  };
};

const scopeLabel = (scope: BulkPocScope, includePast: boolean) =>
  `${scope.kind === 'all' ? 'every event in EventReach' : 'the events you own'}${includePast ? ', including completed and cancelled ones' : ' that are upcoming'}`;

const countsFor = async (inScope: Record<string, unknown>, mobile: string): Promise<BulkPocCounts> => {
  const [total, willUpdate, alreadySet, noLocalPoc, inheritingSubEvents] = await Promise.all([
    Event.countDocuments(inScope),
    Event.countDocuments({ $and: [inScope, HAS_LOCAL_POC, { 'poc.mobile': { $ne: mobile } }] }),
    Event.countDocuments({ $and: [inScope, { 'poc.mobile': mobile }] }),
    Event.countDocuments({ $and: [inScope, NO_LOCAL_POC] }),
    Event.countDocuments({ $and: [inScope, NO_LOCAL_POC, { parentEventId: { $ne: null } }] }),
  ]);
  return { inScope: total, willUpdate, alreadySet, noLocalPoc, inheritingSubEvents };
};

const willUpdateFilter = (inScope: Record<string, unknown>, mobile: string) => ({
  $and: [inScope, HAS_LOCAL_POC, { 'poc.mobile': { $ne: mobile } }],
});

/** Hash of the caller's scope, the number and the ids that would change, read in id order. */
const scopeTokenFor = async (scope: BulkPocScope, includePast: boolean, mobile: string, inScope: Record<string, unknown>) => {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ kind: scope.kind, adminId: scope.kind === 'own' ? scope.adminId : null, includePast, mobile }));
  const cursor = Event.find(willUpdateFilter(inScope, mobile)).select('_id').sort({ _id: 1 }).lean().cursor({ batchSize: 1000 });
  for await (const doc of cursor as any) hash.update(`|${String(doc._id)}`);
  return hash.digest('hex').slice(0, 32);
};

const previewFor = async (scope: BulkPocScope, includePast: boolean, mobile: string, inScope: Record<string, unknown>): Promise<BulkPocPreview> => ({
  scope: { kind: scope.kind, label: scopeLabel(scope, includePast) },
  includePast,
  mobile,
  counts: await countsFor(inScope, mobile),
  scopeToken: await scopeTokenFor(scope, includePast, mobile, inScope),
});

export const previewBulkPocUpdate = async (actor: BulkPocActor | undefined, input: { mobile?: unknown; includePast?: unknown }): Promise<BulkPocPreview> => {
  const scope = resolveBulkPocScope(actor);
  const mobile = validateBulkPocMobile(input.mobile);
  const includePast = input.includePast === true;
  return previewFor(scope, includePast, mobile, await scopeFilter(scope, includePast));
};

/** One run at a time per account, in this process. A repeat click gets a clear refusal. */
const running = new Set<string>();

export const applyBulkPocUpdate = async (
  actor: BulkPocActor | undefined,
  input: { mobile?: unknown; includePast?: unknown; expectedCount?: unknown; scopeToken?: unknown },
  deps: BulkPocDeps = {}
): Promise<BulkPocResult> => {
  const scope = resolveBulkPocScope(actor);
  const mobile = validateBulkPocMobile(input.mobile);
  const includePast = input.includePast === true;
  const expected = input.expectedCount;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0 || typeof input.scopeToken !== 'string' || !input.scopeToken) {
    throw new BulkPocError('VALIDATION_ERROR', 'Review the affected events first: the reviewed scope is missing.', 400);
  }

  const key = String(actor?.id);
  if (running.has(key)) {
    throw new BulkPocError('BULK_POC_IN_PROGRESS', 'A POC update you started is still running. Wait for it to finish.', 409);
  }
  running.add(key);
  try {
    const inScope = await scopeFilter(scope, includePast);
    const preview = await previewFor(scope, includePast, mobile, inScope);
    const { counts } = preview;

    // Exactly the events that were reviewed must still be the ones that would
    // change - not merely as many. Otherwise nothing is written and the caller
    // sees the new review; this is also what makes a repeated submission of a
    // finished update harmless.
    if (preview.scopeToken !== input.scopeToken || counts.willUpdate !== expected) {
      throw new BulkPocError(
        'SCOPE_CHANGED',
        `The events to update changed since they were reviewed (${expected} then, ${counts.willUpdate} now). Nothing was changed; review and confirm again.`,
        409,
        { preview }
      );
    }

    const willUpdate = willUpdateFilter(inScope, mobile);
    const batchSize = Math.max(1, deps.batchSize ?? BULK_POC_BATCH_SIZE);
    const updateBatch = deps.updateBatch ?? (async (filter: Record<string, unknown>, value: string) => {
      const r = await Event.updateMany(filter, { $set: { 'poc.mobile': value } }, { runValidators: true });
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    });

    let updated = 0;
    let changedMeanwhile = 0;
    let failed = 0;
    const failures: BulkPocResult['failures'] = [];

    // Ids are read in order, a batch at a time, so memory stays bounded however
    // many events there are. Each batch re-applies the full condition, so an
    // event whose POC was removed or already changed meanwhile is left alone.
    const cursor = deps.readIds
      ? deps.readIds(willUpdate, batchSize)
      : (Event.find(willUpdate).select('_id').sort({ _id: 1 }).lean().cursor({ batchSize }) as unknown as AsyncIterable<{ _id: unknown }>);
    let batch: unknown[] = [];
    let batchIndex = 0;
    let processed = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const ids = batch;
      batch = [];
      batchIndex += 1;
      processed += ids.length;
      try {
        const r = await updateBatch({ $and: [{ _id: { $in: ids } }, willUpdate] }, mobile, batchIndex);
        updated += r.modifiedCount;
        changedMeanwhile += ids.length - r.matchedCount;
      } catch (error: any) {
        failed += ids.length;
        failures.push({ batch: batchIndex, events: ids.length, reason: error?.name === 'ValidationError' ? 'The stored data failed validation.' : 'The database refused the update.' });
      }
    };
    try {
      for await (const doc of cursor) {
        batch.push(doc._id);
        if (batch.length >= batchSize) await flush();
      }
      await flush();
    } catch {
      // Reading the remaining ids failed part-way (flush catches its own
      // errors). What was written stays written; everything not yet attempted
      // is reported as failed, so the run is still audited and the caller can
      // review again to finish it.
      const notAttempted = Math.max(0, expected - processed);
      if (notAttempted > 0) {
        failed += notAttempted;
        failures.push({ batch: batchIndex + 1, events: notAttempted, reason: 'The run stopped early: the database stopped answering.' });
      }
    }

    return {
      ...preview,
      bulkOperationId: `BULK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      expected,
      updated,
      skipped: { alreadySet: counts.alreadySet, noLocalPoc: counts.noLocalPoc, changedMeanwhile },
      failed,
      failures,
    };
  } finally {
    running.delete(key);
  }
};
