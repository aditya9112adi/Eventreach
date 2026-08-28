import rateLimit from 'express-rate-limit';

// Global rate limiter for all API routes (e.g., max 200 requests per 15 minutes)
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, 
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiter for authentication routes (e.g., max 10 requests per 15 minutes)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for specific expensive endpoints (e.g. sending bulk campaigns)
export const actionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20,
  message: { error: 'Too many actions performed, please try again after 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
