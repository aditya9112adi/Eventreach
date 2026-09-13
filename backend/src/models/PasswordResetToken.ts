import mongoose, { Document, Schema } from 'mongoose';

/**
 * A single-use, time-limited password-reset token for a Super Admin, Admin or
 * User account.
 *
 * Only the token's SHA-256 hash is ever stored — never the raw value that was
 * emailed to the account — the same principle as never storing a plaintext
 * password. Owning the token proves the caller controls the account's inbox;
 * it is deliberately unrelated to the account's password or any admin
 * approval, so no permission is required to use it (see forgotPassword /
 * resetPassword in authController.ts).
 *
 * Deliberately outside the MongoDB hardening migration (migrateDbHardening.ts):
 * this is a brand-new, short-lived, non-authoritative collection, not one of
 * the 9 collections that migration hardens, so it carries no $jsonSchema
 * validator — Mongoose's own schema is enough here.
 */
export type ResetAccountType = 'Admin' | 'User';

export interface IPasswordResetToken extends Document {
  accountId: mongoose.Types.ObjectId;
  accountType: ResetAccountType;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const PasswordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true, index: true },
    accountType: { type: String, enum: ['Admin', 'User'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'passwordresettokens' }
);

// A lapsed token is deleted rather than left to linger — the API treats
// "expired" and "never existed" identically, so there is nothing gained by
// keeping the row around, and every reason to keep the collection from
// growing unbounded.
PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = mongoose.model<IPasswordResetToken>(
  'PasswordResetToken',
  PasswordResetTokenSchema
);
