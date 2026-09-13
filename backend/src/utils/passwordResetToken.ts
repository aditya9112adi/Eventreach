import crypto from 'crypto';

/** Short-lived by design (item 11 of the forgot-password spec): 15 minutes. */
export const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * A high-entropy, URL-safe token to email to the account holder. 32 random
 * bytes (256 bits) makes offline or online guessing infeasible even without
 * rate limiting, which is why this is a link rather than a short numeric OTP.
 */
export const generateResetToken = (): string => crypto.randomBytes(32).toString('base64url');

/**
 * One-way hash used to look a token up in the database without ever storing
 * it in a form that could be replayed if the collection were ever read —
 * the same principle as never storing a plaintext password.
 */
export const hashResetToken = (rawToken: string): string =>
  crypto.createHash('sha256').update(rawToken).digest('hex');
