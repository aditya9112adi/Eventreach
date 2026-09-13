import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Self-service "Forgot Password" — end to end against the REAL compiled
 * backend (routes, controllers, middleware, Mongoose models from
 * backend/dist) on a throwaway local database. Run `npm run build` in
 * backend/ first, with a mongod on 127.0.0.1:27017.
 *
 * Covers: works for Super Admin, Admin and User with no admin approval;
 * generic, enumeration-safe responses; single-use, time-limited tokens whose
 * raw value is never stored; password policy and confirmation enforcement;
 * bcrypt hashing; session invalidation on reset; and rate limiting.
 *
 * No email provider is configured for these tests (see below), so the raw
 * token that would be emailed is never observable through the API — exactly
 * as production behaves, since the response never echoes it either. Tests
 * that need a known raw token construct one with the same
 * generateResetToken/hashResetToken utilities the controller itself uses and
 * insert the PasswordResetToken document directly, then drive it through the
 * real /verify-reset-token and /reset-password endpoints. Tests of
 * /forgot-password itself check its externally-observable behaviour: the
 * response it gives, and the token record it leaves behind.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_forgot_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.FRONTEND_URL = 'http://localhost:5173';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.RESEND_API_KEY;

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const authRoutes = require('../backend/dist/routes/authRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const { User } = require('../backend/dist/models/User');
const { Admin } = require('../backend/dist/models/Admin');
const { PasswordResetToken } = require('../backend/dist/models/PasswordResetToken');
const { generateResetToken, hashResetToken } = require('../backend/dist/utils/passwordResetToken');

const GOOD_PASSWORD = 'TestPass123';
const NEW_PASSWORD = 'BrandNewPass456';
const GENERIC_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

let server: any;
let baseUrl = '';
let ipCounter = 0;

interface Res {
  status: number;
  body: any;
}

const call = (
  method: string,
  path: string,
  opts: { body?: any; token?: string; ip?: string } = {}
): Promise<Res> =>
  new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const headers: Record<string, string> = {
      'CF-Connecting-IP': opts.ip ?? `203.0.113.${(ipCounter++ % 250) + 1}`,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const loginAs = (email: string, password: string) =>
  call('POST', '/api/auth/login', { body: { email, password } });

/** Create an active account directly, bypassing the approval workflow. */
const seedAccount = async (kind: 'SuperAdmin' | 'Admin' | 'User', email: string, password = GOOD_PASSWORD) => {
  const passwordHash = await bcrypt.hash(password, 10);
  if (kind === 'User') {
    return User.create({ name: 'Seeded User', email, passwordHash, status: 'Active' });
  }
  return Admin.create({
    name: `Seeded ${kind}`,
    email,
    passwordHash,
    role: kind,
    status: 'Active',
    ...(kind === 'Admin' ? { accessGrantedOn: new Date() } : {}),
  });
};

/**
 * Insert a valid, ready-to-use reset token directly (bypassing
 * /forgot-password, which never reveals the raw token), using the exact same
 * hashing utility the controller uses. Returns the raw token to drive
 * /verify-reset-token and /reset-password with.
 */
const issueToken = async (
  accountId: any,
  accountType: 'Admin' | 'User',
  msFromNow = 15 * 60 * 1000
): Promise<string> => {
  const rawToken = generateResetToken();
  await PasswordResetToken.create({
    accountId,
    accountType,
    tokenHash: hashResetToken(rawToken),
    expiresAt: new Date(Date.now() + msFromNow),
  });
  return rawToken;
};

before(async () => {
  await mongoose.connect(TEST_DB);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/events', eventRoutes);

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Admin.deleteMany({}), PasswordResetToken.deleteMany({})]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Token hashing utility', () => {
  test('the raw token is never equal to its own hash, and the hash is a 64-char hex digest', () => {
    const raw = generateResetToken();
    const hash = hashResetToken(raw);
    assert.notEqual(hash, raw);
    assert.match(hash, /^[0-9a-f]{64}$/, 'sha256 hex digest');
    // Deterministic, so the controller can look a token up by re-hashing it.
    assert.equal(hashResetToken(raw), hash);
  });
});

describe('POST /api/auth/forgot-password — no account enumeration, no admin approval', () => {
  for (const kind of ['SuperAdmin', 'Admin', 'User'] as const) {
    test(`works for a ${kind} account with no authentication or approval involved`, async () => {
      const email = `${kind.toLowerCase()}-forgot@example.com`;
      await seedAccount(kind, email);

      // No Authorization header is sent — this is a signed-out flow, and
      // nothing here requires a Super Admin or Admin to act.
      const res = await call('POST', '/api/auth/forgot-password', { body: { email } });
      assert.equal(res.status, 200);
      assert.equal(res.body.message, GENERIC_MESSAGE);
    });
  }

  test('returns the exact same response for an existing and a nonexistent email', async () => {
    await seedAccount('User', 'exists@example.com');

    const known = await call('POST', '/api/auth/forgot-password', { body: { email: 'exists@example.com' } });
    const unknown = await call('POST', '/api/auth/forgot-password', { body: { email: 'nobody-here@example.com' } });

    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
  });

  test('a malformed email still gets the generic response, not a validation error', async () => {
    const res = await call('POST', '/api/auth/forgot-password', { body: { email: 'not-an-email' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, GENERIC_MESSAGE);
  });

  test('creates exactly one reset token for a matched account, tied to the right account type', async () => {
    const admin = await seedAccount('Admin', 'token-admin@example.com');
    await call('POST', '/api/auth/forgot-password', { body: { email: 'token-admin@example.com' } });

    const tokens = await PasswordResetToken.find({ accountId: admin._id }).lean();
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].accountType, 'Admin');
    assert.ok(tokens[0].expiresAt > new Date(), 'expires in the future');
  });

  test('creates no token at all for a nonexistent email', async () => {
    await call('POST', '/api/auth/forgot-password', { body: { email: 'still-nobody@example.com' } });
    assert.equal(await PasswordResetToken.countDocuments({}), 0);
  });

  test('a second request supersedes the first — only the newest link is ever valid', async () => {
    const user = await seedAccount('User', 'supersede@example.com');

    await call('POST', '/api/auth/forgot-password', { body: { email: 'supersede@example.com' } });
    const [first] = await PasswordResetToken.find({ accountId: user._id }).lean();

    await call('POST', '/api/auth/forgot-password', { body: { email: 'supersede@example.com' } });
    const remaining = await PasswordResetToken.find({ accountId: user._id }).lean();

    assert.equal(remaining.length, 1, 'the old token must be gone, not just superseded in effect');
    assert.notEqual(remaining[0].tokenHash, first.tokenHash);
  });

  test('is rate limited', async () => {
    await seedAccount('User', 'rate-forgot@example.com');
    const ip = '198.51.100.201';

    let limited = false;
    for (let i = 0; i < 16; i++) {
      const res = await call('POST', '/api/auth/forgot-password', { ip, body: { email: 'rate-forgot@example.com' } });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, 'the forgot-password endpoint must be rate limited');
  });
});

describe('POST /api/auth/verify-reset-token', () => {
  test('a freshly issued token is valid', async () => {
    const user = await seedAccount('User', 'verify-ok@example.com');
    const token = await issueToken(user._id, 'User');

    const res = await call('POST', '/api/auth/verify-reset-token', { body: { token } });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, true);
  });

  test('an expired token is invalid', async () => {
    const user = await seedAccount('User', 'verify-expired@example.com');
    const token = await issueToken(user._id, 'User', -1000); // expired 1s ago

    const res = await call('POST', '/api/auth/verify-reset-token', { body: { token } });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, false);
  });

  test('a bogus token is invalid', async () => {
    const res = await call('POST', '/api/auth/verify-reset-token', { body: { token: 'not-a-real-token' } });
    assert.equal(res.body.valid, false);
  });

  test('a missing token is invalid, not a crash', async () => {
    const res = await call('POST', '/api/auth/verify-reset-token', { body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, false);
  });
});

describe('POST /api/auth/reset-password — succeeds for every role, no approval involved', () => {
  for (const kind of ['SuperAdmin', 'Admin', 'User'] as const) {
    test(`resets a ${kind} account's password and hashes it with bcrypt`, async () => {
      const email = `${kind.toLowerCase()}-reset@example.com`;
      const account = await seedAccount(kind, email);
      const accountType = kind === 'User' ? 'User' : 'Admin';
      const token = await issueToken(account._id, accountType);

      const res = await call('POST', '/api/auth/reset-password', {
        body: { token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      });
      assert.equal(res.status, 200);

      const serialised = JSON.stringify(res.body);
      assert.ok(!serialised.includes(NEW_PASSWORD), 'must not echo the password');
      assert.ok(!/passwordHash/i.test(serialised), 'must not leak the hash');

      const Model = accountType === 'User' ? User : Admin;
      const after = await Model.findById(account._id);
      assert.notEqual(after.passwordHash, NEW_PASSWORD, 'must not be stored as plaintext');
      assert.ok(after.passwordHash.startsWith('$2'), 'must be a bcrypt hash');
      assert.ok(await bcrypt.compare(NEW_PASSWORD, after.passwordHash));

      // Old password dead, new password works, role preserved.
      assert.equal((await loginAs(email, GOOD_PASSWORD)).status, 401);
      const relogin = await loginAs(email, NEW_PASSWORD);
      assert.equal(relogin.status, 200);
      assert.equal(relogin.body.user.role, kind);
    });
  }

  test('is single-use: the same token cannot be used twice', async () => {
    const user = await seedAccount('User', 'single-use@example.com');
    const token = await issueToken(user._id, 'User');

    const first = await call('POST', '/api/auth/reset-password', {
      body: { token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(first.status, 200);

    const second = await call('POST', '/api/auth/reset-password', {
      body: { token, newPassword: 'AnotherPass789', confirmPassword: 'AnotherPass789' },
    });
    assert.equal(second.status, 400);
    assert.match(second.body.error, /invalid or has expired/i);

    // The second, rejected attempt changed nothing.
    assert.equal((await loginAs('single-use@example.com', NEW_PASSWORD)).status, 200);
    assert.equal((await loginAs('single-use@example.com', 'AnotherPass789')).status, 401);
  });

  test('a successful reset invalidates every other outstanding token for the same account', async () => {
    const user = await seedAccount('User', 'multi-token@example.com');
    // Two tokens issued independently (simulating two separate forgot-password
    // requests before either was used) — the model does not require them to
    // come from the same call, only from the same account.
    const tokenA = await issueToken(user._id, 'User');
    const tokenB = await issueToken(user._id, 'User');

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: tokenA, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);

    const stillValid = await call('POST', '/api/auth/verify-reset-token', { body: { token: tokenB } });
    assert.equal(stillValid.body.valid, false, 'the other outstanding token must be invalidated too');
    assert.equal(await PasswordResetToken.countDocuments({ accountId: user._id }), 0);
  });

  test('an expired token is rejected and the password is unchanged', async () => {
    const user = await seedAccount('User', 'expired-reset@example.com');
    const token = await issueToken(user._id, 'User', -1000);

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid or has expired/i);
    assert.equal((await loginAs('expired-reset@example.com', GOOD_PASSWORD)).status, 200);
  });

  test('a bogus token is rejected', async () => {
    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: 'not-a-real-token', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid or has expired/i);
  });

  test('rejects a confirmation mismatch and leaves the password unchanged', async () => {
    const user = await seedAccount('User', 'mismatch@example.com');
    const token = await issueToken(user._id, 'User');

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token, newPassword: NEW_PASSWORD, confirmPassword: 'SomethingElse123' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /do not match/i);
    assert.equal((await loginAs('mismatch@example.com', GOOD_PASSWORD)).status, 200);

    // The token is still unconsumed — a mismatch must not burn the link.
    assert.equal((await call('POST', '/api/auth/verify-reset-token', { body: { token } })).body.valid, true);
  });

  test('rejects a password that fails the shared policy and leaves the password unchanged', async () => {
    const user = await seedAccount('User', 'weak@example.com');
    const token = await issueToken(user._id, 'User');

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token, newPassword: 'short', confirmPassword: 'short' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 8 characters/i);
    assert.equal((await loginAs('weak@example.com', GOOD_PASSWORD)).status, 200);
  });

  test('a token for an account that no longer exists is rejected, not a crash', async () => {
    const user = await seedAccount('User', 'deleted-account@example.com');
    const token = await issueToken(user._id, 'User');
    await User.deleteOne({ _id: user._id });

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid or has expired/i);
  });

  test('revokes the account\'s existing sessions on success', async () => {
    const user = await seedAccount('User', 'revoke-forgot@example.com');
    const victimToken = (await loginAs('revoke-forgot@example.com', GOOD_PASSWORD)).body.token;
    assert.notEqual((await call('GET', '/api/events', { token: victimToken })).status, 401);

    // passwordChangedAt has second precision, so land it after the token's iat.
    await new Promise((r) => setTimeout(r, 2100));

    const resetToken = await issueToken(user._id, 'User');
    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: resetToken, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);

    assert.equal(
      (await call('GET', '/api/events', { token: victimToken })).status,
      401,
      'the session active before the reset must be revoked'
    );
  });

  test('is rate limited', async () => {
    const user = await seedAccount('User', 'rate-reset@example.com');
    const ip = '198.51.100.202';

    let limited = false;
    for (let i = 0; i < 16; i++) {
      const token = await issueToken(user._id, 'User');
      const res = await call('POST', '/api/auth/reset-password', {
        ip,
        body: { token, newPassword: `RotatePass${i}23`, confirmPassword: `RotatePass${i}23` },
      });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, 'the reset-password endpoint must be rate limited');
  });
});
