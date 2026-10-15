import mongoose, { Document, Schema } from 'mongoose';

/**
 * One attempt to connect a WhatsApp number through Meta's Embedded Signup.
 *
 * Created when the person presses "Connect My WhatsApp Number", before the Meta
 * popup opens, and bound to their account. The popup's result is accepted only
 * for a session that belongs to the caller, is still open and has not expired -
 * and only once: completion claims the session atomically, so a replayed or
 * duplicated callback cannot connect a number twice. Cancelled and failed
 * attempts stay here (briefly) for the audit trail; they never create a sender.
 *
 * Holds no token, code, PIN or secret. Expires after a day (TTL index).
 */

export const ONBOARDING_SESSION_STATUSES = ['started', 'completing', 'completed', 'cancelled', 'error', 'failed'] as const;
export type OnboardingSessionStatus = (typeof ONBOARDING_SESSION_STATUSES)[number];

/** How long a started session can be completed. Meta's code itself is short-lived. */
export const ONBOARDING_SESSION_TTL_MS = 30 * 60 * 1000;

export interface IWhatsAppOnboardingSession extends Document {
  accountId: Schema.Types.ObjectId;
  status: OnboardingSessionStatus;
  startedAt: Date;
  openUntil: Date;
  finishedAt?: Date | null;
  senderId?: Schema.Types.ObjectId | null;
  /** Where the person stopped (from the popup), for a cancelled attempt. */
  cancelledAtStep?: string | null;
  /** Meta's error id and our failure code - no message text from a client is trusted or shown. */
  errorCode?: string | null;
  expiresAt: Date;
}

const schema = new Schema<IWhatsAppOnboardingSession>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    status: { type: String, enum: ONBOARDING_SESSION_STATUSES, required: true, default: 'started' },
    startedAt: { type: Date, required: true },
    openUntil: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    senderId: { type: Schema.Types.ObjectId, ref: 'WhatsAppSender', default: null },
    cancelledAtStep: { type: String, maxlength: 60, default: null },
    errorCode: { type: String, maxlength: 60, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WhatsAppOnboardingSession = mongoose.model<IWhatsAppOnboardingSession>('WhatsAppOnboardingSession', schema);
