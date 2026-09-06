import mongoose, { Document, Schema } from 'mongoose';

export type ResetRequestStatus = 'Pending' | 'Fulfilled' | 'Dismissed';
export type ResetAccountModel = 'Admin' | 'User';

/**
 * A user asking the Super Admin to reset their password.
 *
 * This app does not email reset links, so a human authorises each reset: the
 * request lands in the Super Admin's queue, they issue a one-time link and pass
 * it to the person out of band. Anyone being able to self-serve a reset from an
 * email address alone would be an account-takeover hole.
 *
 * Holds no secret — the token itself lives in PasswordResetToken, hashed.
 */
export interface IPasswordResetRequest extends Document {
  accountId: mongoose.Types.ObjectId;
  accountModel: ResetAccountModel;
  /** Denormalised for the queue UI so it renders without extra lookups. */
  name: string;
  email: string;
  role: string;
  status: ResetRequestStatus;
  requestedAt: Date;
  handledAt?: Date | null;
  handledBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const passwordResetRequestSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, required: true, index: true },
    accountModel: { type: String, required: true, enum: ['Admin', 'User'] },
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['Pending', 'Fulfilled', 'Dismissed'],
      default: 'Pending',
      index: true,
    },
    requestedAt: { type: Date, required: true, default: Date.now },
    handledAt: { type: Date, default: null },
    handledBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true }
);

passwordResetRequestSchema.index({ status: 1, requestedAt: -1 });

export const PasswordResetRequest = mongoose.model<IPasswordResetRequest>(
  'PasswordResetRequest',
  passwordResetRequestSchema
);
