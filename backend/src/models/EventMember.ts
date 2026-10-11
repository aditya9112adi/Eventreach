import mongoose, { Document, Schema } from 'mongoose';

/**
 * One contact on one Sub-Event's member list.
 *
 * A contact belongs to exactly one event (Contact.eventId - the Main Event it
 * was added or imported to). A Sub-Event's members are chosen from those
 * existing contacts, so membership is a mapping rather than a copy: the same
 * contact can be on Haldi, Wedding Ceremony and Reception without a second
 * contact record, and adding or removing it on one sub-event touches no other
 * event.
 *
 * Every sub-event starts with no rows here; nothing is ever copied from the
 * Main Event's guest list.
 */
export interface IEventMember extends Document {
  eventId: mongoose.Types.ObjectId;   // the Sub-Event
  contactId: mongoose.Types.ObjectId; // an existing Contact
  addedBy?: mongoose.Types.ObjectId;  // the Admin or User who added it
  createdAt: Date;
  updatedAt: Date;
}

const EventMemberSchema: Schema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    addedBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true }
);

// A contact is on a sub-event's list at most once - the database enforces it,
// so concurrent or repeated adds are idempotent rather than duplicating rows.
// Leading with eventId, it also serves "the members of this sub-event".
EventMemberSchema.index({ eventId: 1, contactId: 1 }, { unique: true });

// Removing a contact (or the event it belongs to) removes its memberships.
EventMemberSchema.index({ contactId: 1 });

export const EventMember = mongoose.model<IEventMember>('EventMember', EventMemberSchema);
