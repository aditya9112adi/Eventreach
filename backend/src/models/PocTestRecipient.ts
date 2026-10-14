import mongoose, { Document, Schema } from 'mongoose';

/**
 * A person who agreed to receive test messages from the POC sender.
 *
 * WHY THE NUMBER IS STORED. A test message needs it to be sent, so it is kept
 * here, in full, and nowhere else: the test-send records and the audit trail
 * carry only the masked form and this document's id. The API returns it masked
 * too (the full number is never sent back to a browser).
 *
 * CONSENT. A recipient exists only because someone recorded that the person
 * agreed (`consentNote`, who recorded it and when). A revoked recipient stays
 * as a record but can no longer be sent to. Consent is the person's, not the
 * app's: nothing here infers it.
 *
 * SCOPE. A recipient belongs to the account that registered it. Only that
 * account, or a Super Admin, can send to it.
 */

export const POC_RECIPIENTS_PER_OWNER = 25;

export interface IPocTestRecipient extends Document {
  ownerId: string;
  /** E.164, e.g. +919876543210. */
  phone: string;
  label: string;
  consentNote: string;
  consentRecordedAt: Date;
  status: 'active' | 'revoked';
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const pocTestRecipientSchema = new Schema<IPocTestRecipient>(
  {
    ownerId: { type: String, required: true, index: true, immutable: true },
    phone: { type: String, required: true, trim: true, immutable: true },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    consentNote: { type: String, required: true, trim: true, minlength: 3, maxlength: 300 },
    consentRecordedAt: { type: Date, required: true, default: Date.now, immutable: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One registration per number per owner: registering again is a no-op, not a duplicate.
pocTestRecipientSchema.index({ ownerId: 1, phone: 1 }, { unique: true });

export const PocTestRecipient = mongoose.model<IPocTestRecipient>('PocTestRecipient', pocTestRecipientSchema);
