import mongoose, { Document, Schema } from 'mongoose';
import { EventStatus } from '@eventreach/shared';
import { nextSequence, formatEventId } from './Counter';

export interface IEvent extends Document {
  eventId: string;                 // "EVT-000001" — human-readable, unique, immutable
  organizerName: string;           // 1–50 chars
  organizerMobile: string;         // exactly 10 digits ("^[0-9]{10}$") — identifier, not a quantity
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
    // Phone number stored as a digit string, matching Contact.phoneNumber. The
    // app validates ^\d{10}$ with no country code / '+' / leading-zero handling.
    organizerMobile:  { type: String,  required: true, trim: true, match: /^[0-9]{10}$/ },
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
