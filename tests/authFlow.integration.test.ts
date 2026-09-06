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
// No email provider is configured for tests: the mailer logs a warning and
// returns, so nothing is ever actually sent.
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.RESEND_API_KEY;

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const authRoutes = require('../backend/dist/routes/authRoutes').default;
const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const { User } = require('../backend/dist/models/User');
const { Admin } = require('../backend/dist/models/Admin');

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

describe('Change password (signed in)', () => {
  test('requires authentication', async () => {
    const res = await call('POST', '/api/auth/change-password', {
      body: { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 401);
  });

  test('rejects a wrong current password and leaves the account untouched', async () => {
    await seedAccount('User', 'wrongcur@example.com');
    const token = (await loginAs('wrongcur@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'NotMyPassword123', newPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /current password is incorrect/i);

    // Original password still works; the new one never took effect.
    assert.equal((await loginAs('wrongcur@example.com', GOOD_PASSWORD)).status, 200);
    assert.equal((await loginAs('wrongcur@example.com', NEW_PASSWORD)).status, 401);
  });

  test('enforces the shared password policy on the new password', async () => {
    await seedAccount('User', 'weaknew@example.com');
    const token = (await loginAs('weaknew@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: GOOD_PASSWORD, newPassword: 'short' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 8 characters/i);
  });

  test('refuses reusing the current password', async () => {
    await seedAccount('User', 'same@example.com');
    const token = (await loginAs('same@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: GOOD_PASSWORD, newPassword: GOOD_PASSWORD },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /different/i);
  });

  test('changes the password securely and never echoes it', async () => {
    const account = await seedAccount('User', 'change@example.com');
    const token = (await loginAs('change@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);

    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes(NEW_PASSWORD), 'must not echo the password');
    assert.ok(!/passwordHash/i.test(serialised), 'must not include the hash');

    const updated = await User.findById(account._id);
    assert.notEqual(updated.passwordHash, NEW_PASSWORD, 'must not be plaintext');
    assert.ok(updated.passwordHash.startsWith('$2'), 'must be a bcrypt hash');
    assert.ok(await bcrypt.compare(NEW_PASSWORD, updated.passwordHash));
    assert.ok(updated.passwordChangedAt instanceof Date);

    assert.equal((await loginAs('change@example.com', GOOD_PASSWORD)).status, 401);
    assert.equal((await loginAs('change@example.com', NEW_PASSWORD)).status, 200);
  });

  test('revokes older sessions but keeps the caller signed in via a fresh token', async () => {
    await seedAccount('User', 'sessions@example.com');
    const oldToken = (await loginAs('sessions@example.com', GOOD_PASSWORD)).body.token;

    // A second, older session for the same account.
    const otherToken = (await loginAs('sessions@example.com', GOOD_PASSWORD)).body.token;
    assert.notEqual((await call('GET', '/api/events', { token: otherToken })).status, 401);

    // passwordChangedAt has second precision, so make sure it lands after `iat`.
    await new Promise((r) => setTimeout(r, 2100));

    const res = await call('POST', '/api/auth/change-password', {
      token: oldToken,
      body: { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token, 'a replacement token should be returned');

    // Both pre-change tokens are dead.
    assert.equal((await call('GET', '/api/events', { token: oldToken })).status, 401);
    assert.equal((await call('GET', '/api/events', { token: otherToken })).status, 401);

    // The replacement works.
    assert.notEqual((await call('GET', '/api/events', { token: res.body.token })).status, 401);
  });

  test('works for all three roles and never alters role or status', async () => {
    const cases: Array<['SuperAdmin' | 'Admin' | 'User', string]> = [
      ['SuperAdmin', 'sa-cp@example.com'],
      ['Admin', 'admin-cp@example.com'],
      ['User', 'user-cp@example.com'],
    ];

    for (const [kind, email] of cases) {
      const account = await seedAccount(kind, email);
      const token = (await loginAs(email, GOOD_PASSWORD)).body.token;

      const res = await call('POST', '/api/auth/change-password', {
        token,
        body: { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD },
      });
      assert.equal(res.status, 200, `${kind} should be able to change its password`);

      const Model = kind === 'User' ? User : Admin;
      const after = await Model.findById(account._id);
      assert.equal(after.status, 'Active', `${kind} status must be unchanged`);
      if (kind !== 'User') {
        assert.equal(after.role, kind, `${kind} role must be unchanged`);
      }

      const login = await loginAs(email, NEW_PASSWORD);
      assert.equal(login.status, 200);
      assert.equal(login.body.user.role, kind, `${kind} keeps its role`);
    }
  });

  test('a User cannot change another account\'s password', async () => {
    await seedAccount('User', 'attacker@example.com');
    const victim = await seedAccount('User', 'target-cp@example.com');
    const token = (await loginAs('attacker@example.com', GOOD_PASSWORD)).body.token;

    // The endpoint derives the account from the token; there is no id to supply,
    // so an attempt to pass one must be ignored entirely.
    const res = await call('POST', '/api/auth/change-password', {
      token,
      body: {
        currentPassword: GOOD_PASSWORD,
        newPassword: NEW_PASSWORD,
        id: String(victim._id),
        email: 'target-cp@example.com',
      },
    });
    assert.equal(res.status, 200, 'it changes the caller\'s own password');

    // The victim is untouched.
    assert.equal((await loginAs('target-cp@example.com', GOOD_PASSWORD)).status, 200);
    assert.equal((await loginAs('target-cp@example.com', NEW_PASSWORD)).status, 401);
  });

  test('the removed reset endpoints are gone', async () => {
    assert.equal(
      (await call('POST', '/api/auth/forgot-password', { body: { email: 'x@example.com' } })).status,
      404
    );
    assert.equal(
      (await call('POST', '/api/auth/reset-password', { body: { token: 'x', password: NEW_PASSWORD } })).status,
      404
    );
  });
});

describe('Super Admin administrative password reset', () => {
  const resetPath = (id: string, type: 'Admin' | 'User') =>
    `/api/admin/users/${id}/reset-password?type=${type}`;

  test('there is no unauthenticated public reset or forgot endpoint', async () => {
    // The recovery design is deliberately Super Admin mediated. A public
    // "email + new password" endpoint would be a one-request account takeover.
    for (const path of ['/api/auth/reset-password', '/api/auth/forgot-password']) {
      const res = await call('POST', path, {
        body: { email: 'victim@example.com', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      });
      assert.equal(res.status, 404, `${path} must not exist`);
    }
  });

  test('requires authentication', async () => {
    const target = await seedAccount('User', 'unauth-target@example.com');
    const res = await call('PUT', resetPath(String(target._id), 'User'), {
      body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 401);
  });

  test('a User cannot reset anyone', async () => {
    await seedAccount('User', 'plain-user@example.com');
    const target = await seedAccount('User', 'victim-a@example.com');
    const token = (await loginAs('plain-user@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('PUT', resetPath(String(target._id), 'User'), {
      token,
      body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 403);

    // The victim's password is untouched.
    assert.equal((await loginAs('victim-a@example.com', GOOD_PASSWORD)).status, 200);
    assert.equal((await loginAs('victim-a@example.com', NEW_PASSWORD)).status, 401);
  });

  test('an Admin cannot reset anyone', async () => {
    await seedAccount('Admin', 'an-admin@example.com');
    const target = await seedAccount('User', 'victim-b@example.com');
    const token = (await loginAs('an-admin@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('PUT', resetPath(String(target._id), 'User'), {
      token,
      body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 403);
    assert.equal((await loginAs('victim-b@example.com', GOOD_PASSWORD)).status, 200);
  });

  test('a Super Admin cannot reset another Super Admin', async () => {
    await seedAccount('SuperAdmin', 'sa-one@example.com');
    const peer = await seedAccount('SuperAdmin', 'sa-two@example.com');
    const token = (await loginAs('sa-one@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('PUT', resetPath(String(peer._id), 'Admin'), {
      token,
      body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 403);
    assert.equal((await loginAs('sa-two@example.com', GOOD_PASSWORD)).status, 200);
  });

  test('rejects a confirmation mismatch and a weak password', async () => {
    await seedAccount('SuperAdmin', 'sa-valid@example.com');
    const target = await seedAccount('User', 'target-valid@example.com');
    const token = (await loginAs('sa-valid@example.com', GOOD_PASSWORD)).body.token;

    const mismatch = await call('PUT', resetPath(String(target._id), 'User'), {
      token,
      body: { newPassword: NEW_PASSWORD, confirmPassword: 'SomethingElse123' },
    });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.body.error, /do not match/i);

    const weak = await call('PUT', resetPath(String(target._id), 'User'), {
      token,
      body: { newPassword: 'short', confirmPassword: 'short' },
    });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /at least 8 characters/i);

    // Neither attempt changed anything.
    assert.equal((await loginAs('target-valid@example.com', GOOD_PASSWORD)).status, 200);
  });

  test('resets a User securely, preserving role and status', async () => {
    await seedAccount('SuperAdmin', 'sa-reset-u@example.com');
    const target = await seedAccount('User', 'reset-me@example.com');
    const before = await User.findById(target._id);
    const token = (await loginAs('sa-reset-u@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('PUT', resetPath(String(target._id), 'User'), {
      token,
      body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);

    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes(NEW_PASSWORD), 'must not echo the password');
    assert.ok(!/passwordHash/i.test(serialised), 'must not leak the hash');

    const after = await User.findById(target._id);
    assert.notEqual(after.passwordHash, NEW_PASSWORD, 'must not be plaintext');
    assert.ok(after.passwordHash.startsWith('$2'), 'must be a bcrypt hash');
    assert.ok(await bcrypt.compare(NEW_PASSWORD, after.passwordHash));

    // Nothing else moved.
    assert.equal(after.status, before.status, 'status unchanged');
    assert.equal(String(after.email), String(before.email), 'email unchanged');
    assert.equal(String(after.name), String(before.name), 'name unchanged');
    assert.equal(
      String(after.assignedEventId ?? ''),
      String(before.assignedEventId ?? ''),
      'event ownership unchanged'
    );

    // Old password dead, new password works.
    assert.equal((await loginAs('reset-me@example.com', GOOD_PASSWORD)).status, 401);
    const relogin = await loginAs('reset-me@example.com', NEW_PASSWORD);
    assert.equal(relogin.status, 200);
    assert.equal(relogin.body.user.role, 'User', 'role preserved');
  });

  test('resets an Admin and preserves the Admin role', async () => {
    await seedAccount('SuperAdmin', 'sa-reset-a@example.com');
    const target = await seedAccount('Admin', 'admin-reset@example.com');
    const token = (await loginAs('sa-reset-a@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('PUT', resetPath(String(target._id), 'Admin'), {
      token,
      body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);

    const after = await Admin.findById(target._id);
    assert.equal(after.role, 'Admin', 'role must be unchanged');
    assert.equal(after.status, 'Active', 'status must be unchanged');

    const relogin = await loginAs('admin-reset@example.com', NEW_PASSWORD);
    assert.equal(relogin.status, 200);
    assert.equal(relogin.body.user.role, 'Admin');
  });

  test('revokes the existing sessions of the target account', async () => {
    await seedAccount('SuperAdmin', 'sa-revoke@example.com');
    const target = await seedAccount('User', 'revoke-target@example.com');
    const victimToken = (await loginAs('revoke-target@example.com', GOOD_PASSWORD)).body.token;
    assert.notEqual((await call('GET', '/api/events', { token: victimToken })).status, 401);

    // passwordChangedAt has second precision, so land it after the token's iat.
    await new Promise((r) => setTimeout(r, 2100));

    const saToken = (await loginAs('sa-revoke@example.com', GOOD_PASSWORD)).body.token;
    const res = await call('PUT', resetPath(String(target._id), 'User'), {
      token: saToken,
      body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);

    assert.equal(
      (await call('GET', '/api/events', { token: victimToken })).status,
      401,
      'the old session of the target must be revoked'
    );
  });

  test('rejects an unknown account and a missing type', async () => {
    await seedAccount('SuperAdmin', 'sa-404@example.com');
    const token = (await loginAs('sa-404@example.com', GOOD_PASSWORD)).body.token;
    const orphan = '507f1f77bcf86cd799439011';

    assert.equal(
      (await call('PUT', resetPath(orphan, 'User'), {
        token,
        body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      })).status,
      404
    );

    assert.equal(
      (await call('PUT', `/api/admin/users/${orphan}/reset-password`, {
        token,
        body: { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      })).status,
      400
    );
  });

  test('is rate limited', async () => {
    await seedAccount('SuperAdmin', 'sa-rate@example.com');
    const target = await seedAccount('User', 'rate-target@example.com');
    const token = (await loginAs('sa-rate@example.com', GOOD_PASSWORD)).body.token;
    const ip = '198.51.100.77';

    let limited = false;
    for (let i = 0; i < 16; i++) {
      const res = await call('PUT', resetPath(String(target._id), 'User'), {
        token,
        ip,
        body: { newPassword: `RotatePass${i}23`, confirmPassword: `RotatePass${i}23` },
      });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, 'the reset endpoint must be rate limited');
  });
});

describe('Change password accepts the confirmPassword field', () => {
  test('rejects a mismatched confirmation', async () => {
    await seedAccount('User', 'confirm-mismatch@example.com');
    const token = (await loginAs('confirm-mismatch@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('POST', '/api/auth/change-password', {
      token,
      body: {
        currentPassword: GOOD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: 'DifferentPass123',
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /do not match/i);

    assert.equal((await loginAs('confirm-mismatch@example.com', GOOD_PASSWORD)).status, 200);
  });

  test('accepts a matching confirmation', async () => {
    await seedAccount('User', 'confirm-ok@example.com');
    const token = (await loginAs('confirm-ok@example.com', GOOD_PASSWORD)).body.token;

    const res = await call('POST', '/api/auth/change-password', {
      token,
      body: {
        currentPassword: GOOD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      },
    });
    assert.equal(res.status, 200);
    assert.equal((await loginAs('confirm-ok@example.com', NEW_PASSWORD)).status, 200);
  });
});
