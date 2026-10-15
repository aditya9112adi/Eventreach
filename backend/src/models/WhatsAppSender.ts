import mongoose, { Document, Schema } from 'mongoose';

/**
 * A WhatsApp number EventReach can send from.
 *
 * Two sources, one inventory:
 *  - 'inventory': discovered by a Super Admin's sync of the configured
 *    WhatsApp Business Account (WHATSAPP_WABA_ID) and sent with the server's
 *    WHATSAPP_TOKEN. Unchanged.
 *  - 'embedded_signup': connected by an Admin or Super Admin through Meta's
 *    Embedded Signup (services/whatsappOnboardingService.ts). It lives in that
 *    business's OWN WhatsApp Business Account and is sent with the business
 *    token that onboarding produced, stored encrypted in `credential`
 *    (services/credentialVault.ts) and never returned by any API.
 *
 * Either way, a number is never usable until a Super Admin enables it, and the
 * phone number id is what messages go out from - never a POC's personal mobile.
 * phoneNumberId is unique: one record per Meta number, reconnected in place.
 */

export const SENDER_SOURCES = ['inventory', 'embedded_signup'] as const;
export type SenderSource = (typeof SENDER_SOURCES)[number];

/**
 * Where a connected number stands. Set only from what the backend verified with
 * Meta - never from the browser's popup result.
 *   pending_registration  verified and subscribed; Cloud API registration (the
 *                         two-step verification PIN) still needed
 *   registering           registration request in flight
 *   connected             registered on Cloud API and CONNECTED at Meta
 *   action_required       Meta reports something the business must fix
 *                         (see nextAction / nextActionMessage)
 *   disconnected          disconnected here; its credential has been erased
 */
export const ONBOARDING_STATUSES = ['pending_registration', 'registering', 'connected', 'action_required', 'disconnected'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export interface SenderCredential {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
}

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
  source: SenderSource;
  ownerAccountId?: Schema.Types.ObjectId | null;
  businessId?: string | null;
  onboardingStatus?: OnboardingStatus | null;
  nextAction?: string | null;
  nextActionMessage?: string | null;
  lastError?: { code: string | null; message: string | null; at: Date | null } | null;
  platformType?: string | null;
  codeVerificationStatus?: string | null;
  nameStatus?: string | null;
  lastVerifiedAt?: Date | null;
  connectedAt?: Date | null;
  disconnectedAt?: Date | null;
  credential?: SenderCredential | null;
  createdAt: Date;
  updatedAt: Date;
}

const credentialSchema = new Schema<SenderCredential>(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    keyId: { type: String, required: true },
  },
  { _id: false }
);

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
  // Existing records have no source: they are inventory senders (the default).
  source: { type: String, enum: SENDER_SOURCES, default: 'inventory', immutable: true, index: true },
  ownerAccountId: { type: Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
  businessId: { type: String, trim: true, default: null },
  onboardingStatus: { type: String, enum: [...ONBOARDING_STATUSES, null], default: null },
  nextAction: { type: String, trim: true, maxlength: 60, default: null },
  nextActionMessage: { type: String, trim: true, maxlength: 500, default: null },
  lastError: {
    type: new Schema({ code: { type: String, default: null }, message: { type: String, default: null, maxlength: 500 }, at: { type: Date, default: null } }, { _id: false }),
    default: null,
  },
  platformType: { type: String, default: null },
  codeVerificationStatus: { type: String, default: null },
  nameStatus: { type: String, default: null },
  lastVerifiedAt: { type: Date, default: null },
  connectedAt: { type: Date, default: null },
  disconnectedAt: { type: Date, default: null },
  // Never selected unless asked for explicitly, and never sent to a browser.
  credential: { type: credentialSchema, default: null, select: false },
}, { timestamps: true });

WhatsAppSenderSchema.index({ wabaId: 1, enabled: 1, metaStatus: 1 });
export const WhatsAppSender = mongoose.model<IWhatsAppSender>('WhatsAppSender', WhatsAppSenderSchema);
