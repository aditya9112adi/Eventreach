import mongoose, { Schema, Document } from 'mongoose';

/**
 * One row per campaign recipient, tracking that message from queueing through
 * to whatever WhatsApp last told us about it.
 *
 * STATUS vs TIMESTAMPS — read this before adding a status value.
 *
 * `status` is the coarse state, and its values are fixed: the production
 * database carries a $jsonSchema validator (see migrateDbHardening.ts) that
 * pins it to exactly Pending | Sent | Delivered | Failed. Writing any other
 * value is rejected by MongoDB itself, so a new status cannot be introduced
 * without a migration.
 *
 * That is not a limitation worth fighting here, because delivery milestones
 * are not mutually exclusive states in the first place — a read message is
 * also a delivered message. The milestones are therefore recorded as
 * timestamps (`sentAt`, `deliveredAt`, `readAt`, `failedAt`), which models
 * them accurately and lets a report distinguish "delivered" from "read"
 * without either one overwriting the other.
 *
 * What each status means:
 *   Pending   — queued by EventReach, not yet handed to WhatsApp.
 *   Sent      — ACCEPTED BY WHATSAPP. Meta answered the send call with a
 *               message id. It does NOT mean the handset received anything;
 *               that only arrives later on the webhook. The UI says
 *               "Accepted by WhatsApp" rather than "Sent" for this reason.
 *   Delivered — the webhook reported delivery to the device. If `readAt` is
 *               also set, the recipient opened it.
 *   Failed    — either the send call was rejected outright, or the webhook
 *               later reported the message as failed. `errorCode` /
 *               `errorReason` carry Meta's own reason.
 */
export interface IMessageLog extends Document {
  campaignId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  /** Denormalised so a report still names the recipient if the contact is deleted. */
  contactName?: string;
  phoneNumber: string;
  /** The personalised text actually sent to this recipient. */
  messageText?: string;
  /** WhatsApp's own message id ("wamid.…"), the key the webhook correlates on. */
  wamid?: string;
  status: 'Pending' | 'Sent' | 'Delivered' | 'Failed';
  /** Meta's numeric error code, e.g. 131047 (re-engagement window). */
  errorCode?: number;
  errorReason?: string;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const messageLogSchema = new Schema(
  {
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
      index: true
    },
    contactId: {
      type: Schema.Types.ObjectId,
      ref: 'Contact',
      required: true
    },
    contactName: {
      type: String
    },
    phoneNumber: {
      type: String,
      required: true
    },
    messageText: {
      type: String
    },
    wamid: {
      type: String
    },
    status: {
      type: String,
      enum: ['Pending', 'Sent', 'Delivered', 'Failed'],
      default: 'Pending'
    },
    errorCode: {
      type: Number
    },
    errorReason: {
      type: String
    },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    failedAt: { type: Date },
  },
  { timestamps: true }
);

// Indexes to speed up dashboard analytics queries
messageLogSchema.index({ createdAt: -1 });
messageLogSchema.index({ status: 1 });
messageLogSchema.index({ campaignId: 1, status: 1 });
messageLogSchema.index({ campaignId: 1, createdAt: -1 });
// Every webhook callback arrives keyed by wamid and nothing else, so this is
// the hot path for status updates. Partial rather than sparse+unique: rows
// queued before a send attempt have no wamid at all, and a failed send never
// gets one.
messageLogSchema.index(
  { wamid: 1 },
  { partialFilterExpression: { wamid: { $type: 'string' } } }
);

export const MessageLog = mongoose.model<IMessageLog>('MessageLog', messageLogSchema);
