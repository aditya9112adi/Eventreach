import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Email provider selection and password-reset email delivery.
 *
 * Regression coverage for a production incident: RESEND_API_KEY was set on
 * Render, but the logs showed `provider=smtp` and a real SMTP connection
 * attempt (`connect ENETUNREACH ...:465`) — SMTP is unreachable from Render,
 * so every password-reset email silently failed to send.
 *
 * The root cause was operational (the key never actually reached the running
 * process), not a precedence bug — activeProvider() already checked
 * RESEND_API_KEY first. The fix hardens the code against that whole class of
 * failure: SMTP is no longer reachable in production at all, regardless of
 * what EMAIL_USER/EMAIL_PASS happen to be set to, so a missing or
 * unpropagated RESEND_API_KEY now produces a clear "not configured" instead
 * of a doomed SMTP attempt.
 *
 * These exercise the REAL compiled email.ts (backend/dist) — not a
 * reimplementation. No network provider is ever actually reached: the
 * Resend path is exercised by mocking global fetch, and the SMTP path by
 * monkey-patching nodemailer.createTransport (both are the standard, single
 * module-scoped touch point each provider goes through).
 */

const require = createRequire(import.meta.url);
const nodemailer = require('nodemailer');

const {
  activeProvider,
  verifyEmailTransport,
  sendPasswordResetEmail,
} = require('../backend/dist/utils/email');

const ENV_KEYS = ['RESEND_API_KEY', 'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_FROM', 'NODE_ENV'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const resetEnv = () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
};

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

after(() => {
  resetEnv();
});

/** Captures console output for the duration of `fn`, without printing it. */
const captureConsole = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const lines: string[] = [];
  const capture = (...args: any[]) => { lines.push(args.map(String).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return lines;
};

// ─────────────────────────────────────────────────────────────────────────────

describe('activeProvider — selection precedence', () => {
  test('RESEND_API_KEY wins outright, in every environment', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    assert.equal(activeProvider(), 'resend');

    process.env.NODE_ENV = 'production';
    assert.equal(activeProvider(), 'resend');
  });

  test('RESEND_API_KEY wins even when SMTP credentials are also present', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_USER = 'someone@gmail.com';
    process.env.EMAIL_PASS = 'app-password';
    assert.equal(activeProvider(), 'resend');
  });

  test('regression: SMTP is never selected in production, even with valid credentials and no Resend key', () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_USER = 'someone@gmail.com';
    process.env.EMAIL_PASS = 'app-password';
    // This exact combination (RESEND_API_KEY absent/unpropagated, stale SMTP
    // creds still set) is what produced the reported ENETUNREACH failure.
    assert.equal(activeProvider(), 'none');
  });

  test('SMTP is available as a development fallback when Resend is not configured', () => {
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_USER = 'someone@gmail.com';
    process.env.EMAIL_PASS = 'app-password';
    assert.equal(activeProvider(), 'smtp');
  });

  test('no provider configured resolves to none', () => {
    assert.equal(activeProvider(), 'none');
  });

  test('the placeholder EMAIL_PASS value from .env.example is never treated as configured', () => {
    process.env.EMAIL_USER = 'someone@gmail.com';
    process.env.EMAIL_PASS = 'your_app_password_here';
    assert.equal(activeProvider(), 'none');
  });

  test('a whitespace-only RESEND_API_KEY is treated as unset, not as a configured (garbage) key', () => {
    process.env.RESEND_API_KEY = '   ';
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_USER = 'someone@gmail.com';
    process.env.EMAIL_PASS = 'app-password';
    // Falls through to the dev SMTP fallback rather than trying Resend with a
    // blank Authorization header.
    assert.equal(activeProvider(), 'smtp');
  });

  test('a whitespace-only EMAIL_USER/EMAIL_PASS does not count as SMTP being configured', () => {
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_USER = '   ';
    process.env.EMAIL_PASS = '   ';
    assert.equal(activeProvider(), 'none');
  });
});

describe('verifyEmailTransport — never logs or returns secrets', () => {
  test('reports "not configured" in production with a message that names RESEND_API_KEY, not its value', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_USER = 'someone@gmail.com';
    process.env.EMAIL_PASS = 'app-password';

    const result = await verifyEmailTransport();
    assert.equal(result.provider, 'none');
    assert.equal(result.configured, false);
    assert.match(result.error, /RESEND_API_KEY/);
    assert.doesNotMatch(result.error, /gmail\.com|app-password/);
  });
});

describe('sendPasswordResetEmail — delivers over Resend when configured', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends to the right recipient, with the right subject and reset link, over HTTPS', async () => {
    process.env.RESEND_API_KEY = 're_secret_test_key_should_not_appear_in_logs';
    process.env.NODE_ENV = 'production';

    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, text: async () => '' } as Response;
    }) as any;

    const resetLink = 'https://eventreach-frontend-zeta.vercel.app/reset-password?token=abc123secrettoken';
    const logs = await captureConsole(() => sendPasswordResetEmail('Asha Menon', 'asha@example.com', resetLink));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_secret_test_key_should_not_appear_in_logs');

    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.to, ['asha@example.com']);
    assert.equal(body.subject, 'Reset your EventReach password');
    assert.match(body.html, /Asha Menon/);
    assert.ok(body.html.includes(resetLink), 'the email must contain the actual reset link');

    // Never logged: the API key, or the reset link/token themselves.
    const allLogs = logs.join('\n');
    assert.doesNotMatch(allLogs, /re_secret_test_key_should_not_appear_in_logs/);
    assert.doesNotMatch(allLogs, /abc123secrettoken/);
    assert.match(allLogs, /Email sent via resend/);
  });

  test('the From address is never a stale SMTP address left over from an earlier setup', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_USER = 'old-gmail-sender@gmail.com'; // simulates a leftover SMTP config
    process.env.NODE_ENV = 'production';

    let sentFrom = '';
    globalThis.fetch = (async (_url: string, init: any) => {
      sentFrom = JSON.parse(init.body).from;
      return { ok: true, text: async () => '' } as Response;
    }) as any;

    await sendPasswordResetEmail('Test', 'test@example.com', 'https://example.com/reset-password?token=x');
    assert.ok(!sentFrom.includes('gmail.com'), `From must not be the leftover SMTP address, got: ${sentFrom}`);
    assert.equal(sentFrom, 'EventReach <onboarding@resend.dev>');
  });

  test('EMAIL_FROM overrides the default sender for Resend too', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'EventReach <no-reply@eventreach.example>';

    let sentFrom = '';
    globalThis.fetch = (async (_url: string, init: any) => {
      sentFrom = JSON.parse(init.body).from;
      return { ok: true, text: async () => '' } as Response;
    }) as any;

    await sendPasswordResetEmail('Test', 'test@example.com', 'https://example.com/reset-password?token=x');
    assert.equal(sentFrom, 'EventReach <no-reply@eventreach.example>');
  });

  test('a Resend failure is logged without leaking the API key or the reset link', async () => {
    process.env.RESEND_API_KEY = 're_secret_should_not_leak';
    globalThis.fetch = (async () => {
      throw new Error('network unreachable');
    }) as any;

    const logs = await captureConsole(() =>
      sendPasswordResetEmail('Test', 'test@example.com', 'https://example.com/reset-password?token=leak-check')
    );
    const allLogs = logs.join('\n');
    assert.match(allLogs, /Failed to send email via resend/);
    assert.doesNotMatch(allLogs, /re_secret_should_not_leak/);
    assert.doesNotMatch(allLogs, /leak-check/);
  });
});

describe('sendPasswordResetEmail — SMTP remains a working local-development fallback', () => {
  const originalCreateTransport = nodemailer.createTransport;
  afterEach(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  test('uses SMTP in development when only EMAIL_USER/EMAIL_PASS are set', async () => {
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_USER = 'dev-sender@gmail.com';
    process.env.EMAIL_PASS = 'app-password';

    let sentMail: any = null;
    nodemailer.createTransport = () => ({
      sendMail: async (mailOptions: any) => {
        sentMail = mailOptions;
      },
    });

    await sendPasswordResetEmail('Test', 'test@example.com', 'https://localhost:5173/reset-password?token=x');
    assert.ok(sentMail, 'sendMail must have been called');
    assert.equal(sentMail.to, 'test@example.com');
    assert.equal(sentMail.subject, 'Reset your EventReach password');
    assert.equal(sentMail.from, 'EventReach <dev-sender@gmail.com>');
  });
});
