import mongoose, { Document, Schema } from 'mongoose';

export interface IWhatsAppSender extends Document {
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating?: string | null;
  metaStatus: string | null;
  listedInMeta: boolean;
  enabled: boolean;
  /** Designated by a Super Admin for POC test messages (services/pocTestSendService). Off for every sender until set. */
  pocTestEnabled: boolean;
  label?: string;
  allowedAdminIds: Schema.Types.ObjectId[];
  lastSyncedAt?: Date;
  statusCheckedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WhatsAppSenderSchema = new Schema<IWhatsAppSender>({
  phoneNumberId: { type: String, required: true, trim: true, unique: true, immutable: true },
  wabaId: { type: String, required: true, trim: true, index: true, immutable: true },
  displayPhoneNumber: { type: String, required: true, trim: true },
  verifiedName: { type: String, required: true, trim: true },
  qualityRating: { type: String, default: null },
  metaStatus: { type: String, default: null },
  listedInMeta: { type: Boolean, default: true, index: true },
  // Newly discovered numbers must never be eligible to send until explicitly enabled.
  enabled: { type: Boolean, default: false, index: true },
  // Never set by sync: a number becomes a POC test sender only when a Super Admin says so.
  pocTestEnabled: { type: Boolean, default: false, index: true },
  label: { type: String, trim: true, maxlength: 100 },
  allowedAdminIds: [{ type: Schema.Types.ObjectId, ref: 'Admin' }],
  lastSyncedAt: Date,
  statusCheckedAt: Date,
}, { timestamps: true });

WhatsAppSenderSchema.index({ wabaId: 1, enabled: 1, metaStatus: 1 });
export const WhatsAppSender = mongoose.model<IWhatsAppSender>('WhatsAppSender', WhatsAppSenderSchema);
