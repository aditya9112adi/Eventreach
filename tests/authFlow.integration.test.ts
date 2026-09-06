import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * End-to-end tests for the registration-approval workflow and the password
 * reset flow.
 *
 * These exercise the REAL compiled backend (routers, controllers, middleware,
 * mongoose models from backend/dist) against a throwaway local database — not
 * reimplementations of the logic. Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_test_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.FRONTEND_URL = 'http://localhost:5173';
// EMAIL_USER / EMAIL_PASS are intentionally unset: the mailer logs a warning and
// returns, so no mail is sent during tests.
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const authRoutes = require('../backend/dist/routes/authRoutes').default;
const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const { User } = require('../backend/dist/models/User');
const { Admin } = require('../backend/dist/models/Admin');
const { PasswordResetToken } = require('../backend/dist/models/PasswordResetToken');
const { hashResetToken, generateResetToken } = require('../backend/dist/utils/resetToken');

const GOOD_PASSWORD = 'TestPass123';
const NEW_PASSWORD = 'BrandNewPass456';

let server: any;
let baseUrl = '';
let ipCounter = 0;

interface Res {
  status: number;
  body: any;
}

/**
 * Each request gets a unique CF-Connecting-IP so the shared rate limiters do not
 * bleed between unrelated tests. Pass a fixed `ip` to deliberately share a
 * bucket (used by the rate-limit test).
 */
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

/** Register a User and return the created document. */
const registerUser = async (email: string, password = GOOD_PASSWORD) => {
  const res = await call('POST', '/api/auth/register', {
    body: { name: 'Test Person', email, password, role: 'User' },
  });
  return res;
};

const loginAs = (email: string, password: string) =>
  call('POST', '/api/auth/login', { body: { email, password } });

/** Create an active account directly, bypassing the approval workflow. */
const seedAccount = async (
  kind: 'SuperAdmin' | 'Admin' | 'User',
  email: string,
  password = GOOD_PASSWORD
) => {
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

before(async () => {
  await mongoose.connect(TEST_DB);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
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
  await Promise.all([
    User.deleteMany({}),
    Admin.deleteMany({}),
    PasswordResetToken.deleteMany({}),
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Registration approval workflow', () => {
  test('1. registration creates a Pending user', async () => {
    const res = await registerUser('pending1@example.com');
    assert.equal(res.status, 201);

    const created = await User.findOne({ email: 'pending1@example.com' });
    assert.ok(created, 'user should exist');
    assert.equal(created.status, 'Pending');
  });

  test('2. registration timestamp is generated server-side and client values are ignored', async () => {
    const forged = new Date('1999-01-01T00:00:00.000Z').toISOString();
    const before = Date.now();
    const res = await call('POST', '/api/auth/register', {
      body: {
        name: 'Clock Faker',
        email: 'clock@example.com',
        password: GOOD_PASSWORD,
        role: 'User',
        // All of these must be ignored by the server.
        createdAt: forged,
        approvedAt: forged,
        status: 'Active',
        role_: 'SuperAdmin',
      },
    });
    assert.equal(res.status, 201);

    const created = await User.findOne({ email: 'clock@example.com' });
    assert.ok(created.createdAt, 'createdAt must be set by the server');
    assert.ok(
      created.createdAt.getTime() >= before - 5000,
      'createdAt must be "now", not the client-supplied 1999 date'
    );
    // Client could not force an approved account.
    assert.equal(created.status, 'Pending');
    assert.equal(created.approvedAt, undefined);
  });

  test('3. a Pending user cannot log in or reach protected APIs', async () => {
    await registerUser('pending2@example.com');

    const login = await loginAs('pending2@example.com', GOOD_PASSWORD);
    assert.equal(login.status, 403);
    assert.match(login.body.error, /pending approval/i);

    // Even with a hand-minted token the middleware must refuse.
    const pendingUser = await User.findOne({ email: 'pending2@example.com' });
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { id: String(pendingUser._id), email: pendingUser.email, role: 'User' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const protectedRes = await call('GET', '/api/events', { token });
    assert.equal(protectedRes.status, 401);
  });

  test('4. an approved user can authenticate', async () => {
    await registerUser('approve-me@example.com');
    const superAdmin = await seedAccount('SuperAdmin', 'super4@example.com');
    const saToken = (await loginAs('super4@example.com', GOOD_PASSWORD)).body.token;

    const target = await User.findOne({ email: 'approve-me@example.com' });
    const approve = await call('PUT', `/api/admin/users/${target._id}/approve?type=User`, {
      token: saToken,
      body: {},
    });
    assert.equal(approve.status, 200);

    const login = await loginAs('approve-me@example.com', GOOD_PASSWORD);
    assert.equal(login.status, 200);
    assert.ok(login.body.token, 'approved user should receive a token');
    assert.equal(login.body.user.role, 'User');

    // Approval metadata is recorded server-side.
    const updated = await User.findOne({ email: 'approve-me@example.com' });
    assert.equal(updated.status, 'Active');
    assert.ok(updated.approvedAt instanceof Date);
    assert.equal(String(updated.approvedBy), String(superAdmin._id));
  });

  test('5. a rejected user cannot authenticate or reach protected APIs', async () => {
    await registerUser('reject-me@example.com');
    await seedAccount('SuperAdmin', 'super5@example.com');
    const saToken = (await loginAs('super5@example.com', GOOD_PASSWORD)).body.token;

    const target = await User.findOne({ email: 'reject-me@example.com' });
    const reject = await call('PUT', `/api/admin/users/${target._id}/reject?type=User`, {
      token: saToken,
      body: { reason: 'Not a recognised contact' },
    });
    assert.equal(reject.status, 200);

    const stored = await User.findOne({ email: 'reject-me@example.com' });
    assert.equal(stored.status, 'Rejected');
    assert.equal(stored.rejectionReason, 'Not a recognised contact');
    assert.ok(stored.rejectedAt instanceof Date);

    const login = await loginAs('reject-me@example.com', GOOD_PASSWORD);
    assert.equal(login.status, 403);
    assert.match(login.body.error, /rejected/i);
  });
});

describe('Approval authorization', () => {
  const setupTarget = async () => {
    await registerUser('target@example.com');
    return User.findOne({ email: 'target@example.com' });
  };

  test('6. a Super Admin can approve', async () => {
    const target = await setupTarget();
    await seedAccount('SuperAdmin', 'super6@example.com');
    const token = (await loginAs('super6@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('PUT', `/api/admin/users/${target._id}/approve?type=User`, {
      token,
      body: {},
    });
    assert.equal(res.status, 200);
  });

  test('7. an Admin cannot approve users', async () => {
    const target = await setupTarget();
    await seedAccount('Admin', 'admin7@example.com');
    const token = (await loginAs('admin7@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('PUT', `/api/admin/users/${target._id}/approve?type=User`, {
      token,
      body: {},
    });
    assert.equal(res.status, 403);

    const unchanged = await User.findById(target._id);
    assert.equal(unchanged.status, 'Pending');
  });

  test('8. a User cannot approve users, including themselves', async () => {
    await seedAccount('User', 'plain8@example.com');
    const token = (await loginAs('plain8@example.com', GOOD_PASSWORD)).body.token;
    const self = await User.findOne({ email: 'plain8@example.com' });

    const other = await setupTarget();

    const approveOther = await call('PUT', `/api/admin/users/${other._id}/approve?type=User`, {
      token,
      body: {},
    });
    assert.equal(approveOther.status, 403);

    const approveSelf = await call('PUT', `/api/admin/users/${self._id}/approve?type=User`, {
      token,
      body: {},
    });
    assert.equal(approveSelf.status, 403);

    // And they cannot read the pending queue either.
    const listing = await call('GET', '/api/admin/users/pending', { token });
    assert.equal(listing.status, 403);
  });
});

describe('Forgot password', () => {
  test('9. the response is identical whether or not the account exists', async () => {
    await seedAccount('User', 'exists9@example.com');

    const known = await call('POST', '/api/auth/forgot-password', {
      body: { email: 'exists9@example.com' },
    });
    const unknown = await call('POST', '/api/auth/forgot-password', {
      body: { email: 'nobody9@example.com' },
    });

    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
    assert.match(known.body.message, /if an account exists/i);

    // A token was issued only for the real account.
    assert.equal(await PasswordResetToken.countDocuments({}), 1);
  });

  test('the raw token is never stored — only its hash', async () => {
    await seedAccount('User', 'hash@example.com');
    await call('POST', '/api/auth/forgot-password', { body: { email: 'hash@example.com' } });

    const record = await PasswordResetToken.findOne({});
    assert.ok(record.tokenHash, 'a hash must be stored');
    assert.equal(record.tokenHash.length, 64, 'sha256 hex digest');
    const serialised = JSON.stringify(record.toObject());
    assert.ok(!/"token"\s*:/.test(serialised), 'no raw token field should exist');
  });

  test('the endpoint is rate limited', async () => {
    const sharedIp = '198.51.100.42';
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const res = await call('POST', '/api/auth/forgot-password', {
        body: { email: `probe${i}@example.com` },
        ip: sharedIp,
      });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    assert.ok(sawLimit, 'repeated requests from one client should be rate limited');
  });
});

describe('Reset password', () => {
  /** Issue a reset token directly so expiry/reuse can be controlled precisely. */
  const issueToken = async (accountId: any, accountModel: 'Admin' | 'User', expiresAt: Date) => {
    const raw = generateResetToken();
    await PasswordResetToken.create({
      tokenHash: hashResetToken(raw),
      accountId,
      accountModel,
      expiresAt,
    });
    return raw;
  };

  test('10. an expired token is rejected', async () => {
    const user = await seedAccount('User', 'expired10@example.com');
    const raw = await issueToken(user._id, 'User', new Date(Date.now() - 60_000));

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: raw, password: NEW_PASSWORD },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid or has expired/i);

    // Old password still works.
    assert.equal((await loginAs('expired10@example.com', GOOD_PASSWORD)).status, 200);
  });

  test('11. a token can only be used once', async () => {
    const user = await seedAccount('User', 'once11@example.com');
    const raw = await issueToken(user._id, 'User', new Date(Date.now() + 600_000));

    const first = await call('POST', '/api/auth/reset-password', {
      body: { token: raw, password: NEW_PASSWORD },
    });
    assert.equal(first.status, 200);

    const second = await call('POST', '/api/auth/reset-password', {
      body: { token: raw, password: 'YetAnotherPass789' },
    });
    assert.equal(second.status, 400);
    assert.match(second.body.error, /invalid or has expired/i);

    // The second attempt must not have taken effect.
    assert.equal((await loginAs('once11@example.com', 'YetAnotherPass789')).status, 401);
    assert.equal((await loginAs('once11@example.com', NEW_PASSWORD)).status, 200);
  });

  test('12. the password is updated securely and never returned', async () => {
    const user = await seedAccount('User', 'secure12@example.com');
    const raw = await issueToken(user._id, 'User', new Date(Date.now() + 600_000));

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: raw, password: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);

    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes(NEW_PASSWORD), 'response must not echo the password');
    assert.ok(!/passwordHash/i.test(serialised), 'response must not include the hash');

    const updated = await User.findById(user._id);
    assert.notEqual(updated.passwordHash, NEW_PASSWORD, 'must not be plaintext');
    assert.ok(updated.passwordHash.startsWith('$2'), 'must be a bcrypt hash');
    assert.ok(await bcrypt.compare(NEW_PASSWORD, updated.passwordHash));
    assert.ok(updated.passwordChangedAt instanceof Date);

    // Old password no longer works, new one does.
    assert.equal((await loginAs('secure12@example.com', GOOD_PASSWORD)).status, 401);
    assert.equal((await loginAs('secure12@example.com', NEW_PASSWORD)).status, 200);
  });

  test('13. role and status are unchanged by a password reset (all three roles)', async () => {
    const cases: Array<['SuperAdmin' | 'Admin' | 'User', string]> = [
      ['SuperAdmin', 'super13@example.com'],
      ['Admin', 'admin13@example.com'],
      ['User', 'user13@example.com'],
    ];

    for (const [kind, email] of cases) {
      const account = await seedAccount(kind, email);
      const model = kind === 'User' ? 'User' : 'Admin';
      const raw = await issueToken(account._id, model as any, new Date(Date.now() + 600_000));

      const res = await call('POST', '/api/auth/reset-password', {
        body: { token: raw, password: NEW_PASSWORD },
      });
      assert.equal(res.status, 200, `${kind} reset should succeed`);

      const Model = kind === 'User' ? User : Admin;
      const after = await Model.findById(account._id);
      assert.equal(after.status, 'Active', `${kind} status must be unchanged`);
      if (kind !== 'User') {
        assert.equal(after.role, kind, `${kind} role must be unchanged`);
      }

      const login = await loginAs(email, NEW_PASSWORD);
      assert.equal(login.status, 200, `${kind} should log in with the new password`);
      assert.equal(login.body.user.role, kind, `${kind} keeps its role after reset`);
    }
  });

  test('14. an invalid / empty / unknown token is rejected', async () => {
    const missing = await call('POST', '/api/auth/reset-password', {
      body: { password: NEW_PASSWORD },
    });
    assert.equal(missing.status, 400);

    const empty = await call('POST', '/api/auth/reset-password', {
      body: { token: '', password: NEW_PASSWORD },
    });
    assert.equal(empty.status, 400);

    const unknown = await call('POST', '/api/auth/reset-password', {
      body: { token: 'a'.repeat(64), password: NEW_PASSWORD },
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /invalid or has expired/i);
  });

  test('a weak password is rejected by the shared policy', async () => {
    const user = await seedAccount('User', 'weak@example.com');
    const raw = await issueToken(user._id, 'User', new Date(Date.now() + 600_000));

    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: raw, password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 8 characters/i);
  });

  test('resetting the password invalidates tokens issued earlier', async () => {
    const user = await seedAccount('User', 'session@example.com');
    const oldSession = (await loginAs('session@example.com', GOOD_PASSWORD)).body.token;

    // The old session works before the reset.
    assert.notEqual((await call('GET', '/api/events', { token: oldSession })).status, 401);

    const raw = await issueToken(user._id, 'User', new Date(Date.now() + 600_000));
    // Ensure passwordChangedAt is comfortably after the token's `iat` (second precision).
    await new Promise((r) => setTimeout(r, 2100));
    await call('POST', '/api/auth/reset-password', { body: { token: raw, password: NEW_PASSWORD } });

    const after = await call('GET', '/api/events', { token: oldSession });
    assert.equal(after.status, 401, 'the pre-reset session must be revoked');
  });
});
