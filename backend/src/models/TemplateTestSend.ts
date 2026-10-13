import mongoose, { Document, Schema } from 'mongoose';

/**
 * One test send of an approved template from the POC sender: the write-ahead
 * record, the outcome and the delivery status, in one document.
 *
 * It is written BEFORE anything is sent (state `Claimed`), so a crash or a
 * lost answer leaves evidence that a send may have happened - and that is what
 * stops the next attempt from silently sending a duplicate.
 *
 * States
 *   Claimed               written, the request to Meta not yet answered
 *   Accepted              Meta returned a message id (NOT proof of delivery)
 *   Failed                Meta answered with an error: nothing was sent
 *   Unknown               no usable answer: the message may or may not have
 *                         been sent. Stays Unknown until a person reconciles it
 *   ConfirmedReceived     a person confirmed the message arrived
 *   ConfirmedNotReceived  a person confirmed it did not
 * A `Claimed` record older than the lease is Unknown: the process that wrote
 * it is gone.
 *
 * PRIVACY. No message content and no variable values are stored - only how
 * many there were - and no full phone number: the recipient is the id of its
 * PocTestRecipient document plus the masked form. The Meta error kept is
 * code/category only.
 *
 * IDEMPOTENCY. (actorId, idempotencyKey) is unique, so the same intended send
 * submitted twice - a double click, a retry, two instances - claims once and
 * sends once. That is the only cross-instance guarantee: two DIFFERENT keys
 * for the same message are caught by a read-then-insert duplicate guard, which
 * is not a distributed lock and can lose a true race.
 *
 * RETENTION. Expires after TEST_SEND_RETENTION_DAYS (TTL index).
 */

export const TEST_SEND_RETENTION_DAYS = 90;

export const TEST_SEND_STATES = ['Claimed', 'Accepted', 'Failed', 'Unknown', 'ConfirmedReceived', 'ConfirmedNotReceived'] as const;
export type TestSendState = (typeof TEST_SEND_STATES)[number];

export type TestSendDelivery = 'sent' | 'delivered' | 'read' | 'failed';

export interface ITemplateTestSend extends Document {
  actorId: string;
  idempotencyKey: string;
  senderId: string;
  /** The phone number id the message was sent from, as resolved at send time. */
  phoneNumberId: string;
  wabaId: string;
  templateId: string;
  templateName: string;
  templateLanguage: string;
  recipientId: string;
  recipientMasked: string;
  variableCount: number;
  /** Fingerprint of what was reviewed; used by the duplicate guard. */
  contentHash: string;
  state: TestSendState;
  outcomeCode: string | null;
  errorCategory: string | null;
  metaErrorCode: number | null;
  /** Meta's message id: the key delivery webhooks arrive under. */
  wamid: string | null;
  delivery: TestSendDelivery | null;
  deliveryUpdatedAt: Date | null;
  deliveryErrorCode: number | null;
  claimedAt: Date;
  completedAt: Date | null;
  reconciledBy: string | null;
  reconciledAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const templateTestSendSchema = new Schema<ITemplateTestSend>(
  {
    actorId: { type: String, required: true, immutable: true },
    idempotencyKey: { type: String, required: true, immutable: true },
    senderId: { type: String, required: true, immutable: true },
    phoneNumberId: { type: String, required: true, immutable: true },
    wabaId: { type: String, required: true, immutable: true },
    templateId: { type: String, required: true, immutable: true },
    templateName: { type: String, required: true, immutable: true },
    templateLanguage: { type: String, required: true, immutable: true },
    recipientId: { type: String, required: true, immutable: true },
    recipientMasked: { type: String, required: true, immutable: true },
    variableCount: { type: Number, required: true, immutable: true },
    contentHash: { type: String, required: true, immutable: true },
    state: { type: String, enum: TEST_SEND_STATES, required: true, default: 'Claimed', index: true },
    outcomeCode: { type: String, default: null },
    errorCategory: { type: String, default: null },
    metaErrorCode: { type: Number, default: null },
    wamid: { type: String, default: null },
    delivery: { type: String, enum: ['sent', 'delivered', 'read', 'failed', null], default: null },
    deliveryUpdatedAt: { type: Date, default: null },
    deliveryErrorCode: { type: Number, default: null },
    claimedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date, default: null },
    reconciledBy: { type: String, default: null },
    reconciledAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

templateTestSendSchema.index({ actorId: 1, idempotencyKey: 1 }, { unique: true });
templateTestSendSchema.index({ wamid: 1 }, { sparse: true });
templateTestSendSchema.index({ actorId: 1, claimedAt: -1 });
templateTestSendSchema.index({ contentHash: 1, claimedAt: -1 });
templateTestSendSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TemplateTestSend = mongoose.model<ITemplateTestSend>('TemplateTestSend', templateTestSendSchema);
