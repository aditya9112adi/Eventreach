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
    // 50 is the limit the contact form and its Zod schema already enforce.
    fullName: { type: String, required: true, trim: true, minlength: 1, maxlength: 50 },

    /**
     * Deliberately unpatterned.
     *
     * A valid number is normalised to E.164 ("+919112472833"); an unparseable
     * one is kept exactly as supplied and flagged with status 'Invalid' plus a
     * validationReason, because the import flow is meant to surface bad rows
     * rather than drop them. Applying the form's ^\d{10}$ here would reject the
     * application's own legitimate Invalid records. Strict phone rules stay in
     * the UI and API layers where they belong.
     */
    phoneNumber: { type: String, required: true, trim: true },

    /**
     * Not enumerated on purpose. The manual form offers COUNTRY_OPTIONS, but
     * bulk import takes the country code from the uploaded file, so historical
     * and future imports can legitimately carry a code outside that list.
     */
    countryCode: { type: String, required: true, trim: true },

    // No pattern: the form restricts to @gmail.com, but imported contacts may
    // legitimately hold other domains and must not be rejected retroactively.
    email: { type: String, trim: true, lowercase: true },

    tags: [{ type: String, trim: true }],
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },

    // Written only by the server: 'Manual' (form) or 'Bulk Import' (upload).
    source: {
      type: String,
      required: true,
      enum: ['Manual', 'Bulk Import'],
      default: 'Manual'
    },
    status: {
      type: String,
      required: true,
      enum: ['Valid', 'Invalid', 'Duplicate'],
      default: 'Valid'
    },
    validationReason: { type: String, trim: true },
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
