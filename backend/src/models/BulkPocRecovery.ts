import mongoose, { Document, Schema } from 'mongoose';

/**
 * Recovery data for the bulk POC mobile update (services/bulkPocService).
 *
 * Before a batch of events is changed, the POC mobile number each one holds
 * is saved here, one document per batch, keyed by the run's id - the same id
 * (`bulkOperationId`) that links the run's audit entries. If saving it fails,
 * that batch is not changed.
 *
 * WHY A SEPARATE COLLECTION. The numbers are stored IN FULL: restoring needs
 * them. The audit log must never hold a full number (it is searchable and
 * exportable and shown masked), so they live here instead.
 *
 * ACCESS. Nothing reads this collection through the API: no route, controller
 * or report imports it, and only bulkPocService writes it. It is reachable
 * only with direct database access, which is the access level that can
 * already read the events' own POC numbers. Do not add an endpoint, export or
 * log line that returns these documents.
 *
 * RETENTION. They hold personal data (phone numbers), so they expire: a TTL
 * index on `expiresAt` removes each document BULK_POC_RECOVERY_RETENTION_DAYS
 * after it was written. That is also the longest a run can be recovered from.
 * The collection and its index are created by Mongoose on first use; no
 * migration is needed.
 *
 * RECOVERY (manual, deliberately not automated). A document is a write-ahead
 * record: it is saved BEFORE its batch is changed, so it lists events that the
 * batch may or may not have changed (a crash, or a concurrent edit, can leave
 * either). To restore an event, set its `poc.mobile` back to `previousMobile`
 * only while its current value still equals `newMobile`; skip it otherwise.
 * `status` is 'applied' once the batch finished and its counts are in
 * `outcome`; a document still 'prepared' belongs to a batch that did not
 * report back (failed, or the process stopped).
 */

export const BULK_POC_RECOVERY_RETENTION_DAYS = 90;

export interface IBulkPocRecoveryEntry {
  eventId: mongoose.Types.ObjectId;
  /** The event's POC mobile as stored just before this run, in full. */
  previousMobile: string;
}

export interface IBulkPocRecovery extends Document {
  runId: string;
  batchIndex: number;
  actorId: string | null;
  /** The number this run sets, in full. */
  newMobile: string;
  entries: IBulkPocRecoveryEntry[];
  status: 'prepared' | 'applied';
  outcome?: { matched: number; modified: number };
  expiresAt: Date;
  createdAt: Date;
}

const entrySchema = new Schema<IBulkPocRecoveryEntry>(
  {
    eventId: { type: Schema.Types.ObjectId, required: true },
    previousMobile: { type: String, required: true, maxlength: 20 },
  },
  { _id: false }
);

const bulkPocRecoverySchema = new Schema<IBulkPocRecovery>(
  {
    runId: { type: String, required: true },
    batchIndex: { type: Number, required: true, min: 1 },
    actorId: { type: String, default: null },
    newMobile: { type: String, required: true, maxlength: 20 },
    entries: { type: [entrySchema], default: [] },
    status: { type: String, enum: ['prepared', 'applied'], default: 'prepared' },
    outcome: { type: new Schema({ matched: Number, modified: Number }, { _id: false }), default: undefined },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'bulk_poc_recovery' }
);

// One document per batch of a run.
bulkPocRecoverySchema.index({ runId: 1, batchIndex: 1 }, { unique: true });
// Retention: MongoDB removes a document once `expiresAt` has passed.
bulkPocRecoverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BulkPocRecovery = mongoose.model<IBulkPocRecovery>('BulkPocRecovery', bulkPocRecoverySchema);
