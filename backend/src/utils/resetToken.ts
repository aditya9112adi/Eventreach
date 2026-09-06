import crypto from 'crypto';

/**
 * Password-reset token helpers.
 *
 * The raw token is sent to the user by email and is NEVER persisted. Only a
 * SHA-256 hash is stored, so a database leak cannot be replayed to take over
 * accounts. Lookup is by hash, which is deterministic and therefore indexable.
 */

/** Default lifetime; overridable via PASSWORD_RESET_TOKEN_TTL_MINUTES. */
export const DEFAULT_RESET_TTL_MINUTES = 30;

export const getResetTtlMinutes = (): number => {
  const raw = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 24 * 60) {
    return DEFAULT_RESET_TTL_MINUTES;
  }
  return Math.floor(raw);
};

/** 32 random bytes, URL-safe hex — 256 bits of entropy. */
export const generateResetToken = (): string => crypto.randomBytes(32).toString('hex');

/** Deterministic hash used as the stored lookup key. */
export const hashResetToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export const resetTokenExpiry = (from: Date = new Date()): Date =>
  new Date(from.getTime() + getResetTtlMinutes() * 60 * 1000);
