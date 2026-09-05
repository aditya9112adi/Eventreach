import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Resolve the real client identity for rate limiting.
 *
 * Render fronts services with Cloudflare, so the request path is
 * `client -> Cloudflare edge -> Render router -> app`. Relying on `req.ip`
 * alone resolves to a Cloudflare edge address, which rotates between POPs and
 * is shared by unrelated visitors — that both defeats brute-force protection
 * and lets strangers exhaust each other's login attempts.
 *
 * `CF-Connecting-IP` is written by Cloudflare itself and overwrites anything the
 * caller sends, so it is the trustworthy source for the originating address.
 * `req.ip` (with `trust proxy` configured in server.ts) is the fallback for
 * local development and any non-Cloudflare path.
 */
export const clientKey = (req: Request): string => {
  const header = req.headers['cf-connecting-ip'];
  const cfIp = typeof header === 'string' ? header.trim() : '';
  // ipKeyGenerator normalises IPv6 addresses into a stable /64 subnet key.
  return ipKeyGenerator(cfIp || req.ip || '');
};

// Global rate limiter for all API routes (e.g., max 200 requests per 15 minutes)
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  keyGenerator: clientKey,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiter for authentication routes (e.g., max 10 requests per 15 minutes)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  keyGenerator: clientKey,
  // Successful logins should not consume the brute-force budget.
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for specific expensive endpoints (e.g. sending bulk campaigns)
export const actionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20,
  keyGenerator: clientKey,
  message: { error: 'Too many actions performed, please try again after 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
