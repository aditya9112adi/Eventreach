import mongoose, { Document, Schema } from 'mongoose';

export interface IContact extends Document {
  fullName: string;
  phoneNumber: string;
  countryCode: string;
  email?: string;
  tags?: string[];
  eventId: mongoose.Types.ObjectId;
  source: string;
  status: 'Valid' | 'Invalid' | 'Duplicate';
  validationReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ContactSchema: Schema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    phoneNumber: { type: String, required: true },
    countryCode: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true },
    tags: [{ type: String }],
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    source: { type: String, required: true, default: 'Manual' },
    status: {
      type: String,
      required: true,
      enum: ['Valid', 'Invalid', 'Duplicate'],
      default: 'Valid'
    },
    validationReason: { type: String },
  },
  { timestamps: true }
);

ContactSchema.index({ eventId: 1, phoneNumber: 1 }, { unique: true });

// Serves the contact list: filter by event, newest first, then skip/limit.
// The unique index above leads with eventId too, but its second key is
// phoneNumber, so it cannot satisfy the createdAt sort — without this the
// server had to sort every contact in an event in memory before paging.
ContactSchema.index({ eventId: 1, createdAt: -1 });

export const Contact = mongoose.model<IContact>('Contact', ContactSchema);
