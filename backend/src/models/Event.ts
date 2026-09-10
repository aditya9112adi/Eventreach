import mongoose, { Document, Schema } from 'mongoose';
import { EventStatus } from '@eventreach/shared';
import { nextSequence, formatEventId } from './Counter';

export interface IEvent extends Document {
  eventId: string;                 // "EVT-000001" — human-readable, unique, immutable
  organizerName: string;           // 1–50 chars
  organizerMobile: bigint;         // BSON Int64, exactly 10 digits (1000000000–9999999999)
  eventName: string;               // 1–20 chars
  eventType: string;               // 1–20 chars, free text
  eventDate: Date;                 // BSON Date (date component; time is eventTime)
  eventTime: number;               // minutes since midnight, 0–1439 (see note in migrateEventDbHardening.ts)
  eventVenue: string;              // 1–50 chars
  eventDescription?: string;       // 0–256 chars
  eventStatus: EventStatus;        // Upcoming | Completed | Cancelled
  createdBy?: Schema.Types.ObjectId | string;
  adminId?: Schema.Types.ObjectId | string;
  assignedUserId?: Schema.Types.ObjectId | string;
  assignedUserIds?: (Schema.Types.ObjectId | string)[];
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema: Schema = new Schema(
  {
    // Assigned automatically by the pre-validate hook below; never accepted from
    // a request. Immutable so an event keeps the same public identifier for life.
    // Uniqueness is enforced by the explicit partial index declared after the
    // schema (not `unique: true` here, which would create a second, full index).
    eventId: {
      type: String,
      immutable: true,
      match: /^EVT-\d{6,}$/,
    },
    organizerName:    { type: String,  required: true, trim: true, minlength: 1, maxlength: 50 },
    /**
     * Stored as BSON Int64 (`long`), constrained to exactly ten digits.
     *
     * `BigInt` is what produces a true Int64: Mongoose's `Number` type writes a
     * `double` for any value above 2^31, which is the original defect this
     * replaces — and a 10-digit mobile (~9.1e9) overflows int32, so `int` is not
     * an option either. The API contract is unaffected: serialize() renders it
     * back to a string, and callers only ever send the validated 10-digit
     * string, which Mongoose casts.
     *
     * Note this makes a leading zero or an international prefix unrepresentable;
     * both are already rejected by the ^\d{10}$ rule in the UI and the API.
     */
    organizerMobile: {
      type: BigInt,
      required: true,
      validate: {
        validator: (v: bigint) => v >= 1000000000n && v <= 9999999999n,
        message: 'Mobile No must be exactly 10 digits',
      },
    },
    eventName:        { type: String,  required: true, trim: true, minlength: 1, maxlength: 20 },
    eventType:        { type: String,  required: true, trim: true, minlength: 1, maxlength: 20 },
    eventDate:        { type: Date,    required: true },
    eventTime:        { type: Number,  required: true, min: 0, max: 1439 },   // minutes since midnight
    eventVenue:       { type: String,  required: true, trim: true, minlength: 1, maxlength: 50 },
    eventDescription: { type: String,  trim: true, maxlength: 256 },
    eventStatus: {
      type: String,
      required: true,
      enum: ['Upcoming', 'Completed', 'Cancelled'],
      default: 'Upcoming'
    },
    createdBy:        { type: Schema.Types.ObjectId, ref: 'Admin', index: true },
    adminId:          { type: Schema.Types.ObjectId, ref: 'Admin', index: true },
    assignedUserId:   { type: Schema.Types.ObjectId, ref: 'User', index: true },
    assignedUserIds:  [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

/**
 * Give every new event its immutable EVT-NNNNNN id before validation runs.
 * Uses the atomic counter, so concurrent creates never collide.
 */
EventSchema.pre('validate', async function (next) {
  if (this.isNew && !(this as any).eventId) {
    try {
      (this as any).eventId = formatEventId(await nextSequence('events'));
      next();
    } catch (err) {
      next(err as Error);
    }
  } else {
    next();
  }
});

// Mandatory: database-level uniqueness for the Event ID. Partial so the index
// still builds during the window between deploying this and running the
// backfill migration (documents without an eventId yet are simply not indexed).
EventSchema.index(
  { eventId: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } }
);

EventSchema.index({ eventStatus: 1 });
EventSchema.index({ assignedUserIds: 1 });
// EventList search filters on organizerMobile; also supports "events for organizer X".
EventSchema.index({ organizerMobile: 1 });

export const Event = mongoose.model<IEvent>('Event', EventSchema);
