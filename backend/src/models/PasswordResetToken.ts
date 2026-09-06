import mongoose, { Document, Schema } from 'mongoose';

export type ResetAccountModel = 'Admin' | 'User';

export interface IPasswordResetToken extends Document {
  /** SHA-256 of the emailed token. The raw token is never stored. */
  tokenHash: string;
  accountId: mongoose.Types.ObjectId;
  /** Which collection the account lives in — the app has both Admin and User. */
  accountModel: ResetAccountModel;
  expiresAt: Date;
  /** Set the moment the token is redeemed, enforcing single use. */
  usedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const passwordResetTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    accountId: { type: Schema.Types.ObjectId, required: true, index: true },
    accountModel: { type: String, required: true, enum: ['Admin', 'User'] },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Let MongoDB clear out spent/expired tokens on its own.
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = mongoose.model<IPasswordResetToken>(
  'PasswordResetToken',
  passwordResetTokenSchema
);
