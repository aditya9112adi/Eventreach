import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Sign-in against the REAL compiled backend (backend/dist) on a throwaway
 * database, including the cases a slow or cold start produces: the first
 * request arriving before the database is connected, and the database dropping
 * and coming back. Nothing leaves this machine.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_loginlatency_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const authRoutes = require('../backend/dist/routes/authRoutes').default;
const { requestMiddleware } = require('../backend/dist/middleware/requestMiddleware');
const { waitForDatabase } = require('../backend/dist/middleware/databaseReady');
const { Admin } = require('../backend/dist/models/Admin');
const { AuditService } = require('../backend/dist/services/AuditService');

const PASSWORD = 'LoginLatency#2026';
const WRONG = 'Totally-Wrong#2026';
let server: any;
let baseUrl = '';
let ip = 0;

const call = (method: string, path: string, token: string | null, body?: any): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders; ms: number }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const started = Date.now();
    const url = new URL(baseUrl + path);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed, headers: res.headers, ms: Date.now() - started });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const login = (email: string, password: string) => call('POST', '/api/auth/login', null, { email, password });

/** Captures the structured timing lines the login writes. */
const captureTiming = async (run: () => Promise<void>) => {
  const lines: any[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"login_timing"')) lines.push(JSON.parse(args[0]).login_timing);
    else original(...args);
  };
  try { await run(); } finally { console.log = original; }
  return lines;
};

before(async () => {
  await mongoose.connect(TEST_DB);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const base = { passwordHash, status: 'Active' };
  await Admin.create({ ...base, name: 'Granted', email: 'granted-ll@example.com', role: 'Admin', canManageWhatsAppTemplates: true });
  await Admin.create({ ...base, name: 'Plain', email: 'plain-ll@example.com', role: 'Admin' });
  await Admin.create({ ...base, name: 'Super', email: 'super-ll@example.com', role: 'SuperAdmin' });
  await Admin.create({ ...base, name: 'Pending', email: 'pending-ll@example.com', role: 'Admin', status: 'Pending' });
  await Admin.create({ ...base, name: 'Expired', email: 'expired-ll@example.com', role: 'Admin', accessGrantedOn: new Date(), accessExpiryDate: new Date(Date.now() - 86400000) });

  const app = express();
  app.use(express.json());
  app.use(requestMiddleware);
  // The same readiness wait the real server uses, with a short bound for the test.
  app.use(waitForDatabase({ maxWaitMs: 600 }));
  app.get('/health', (_req: any, res: any) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (mongoose.connection.readyState !== 1) await mongoose.connect(TEST_DB);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('sign-in', () => {
  test('a valid sign-in returns the token and the full permission profile, and nothing secret', async () => {
    const res = await login('granted-ll@example.com', PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'Admin');
    assert.equal(res.body.user.canManageWhatsAppTemplates, true, 'permissions are initialised from the sign-in itself');
    assert.equal(res.body.user.email, 'granted-ll@example.com');
    assert.equal('passwordHash' in res.body.user, false);
    const decoded: any = jwt.verify(res.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.role, 'Admin');
    assert.equal(String(decoded.id), String(res.body.user.id));
    assert.ok(res.headers['x-request-id'], 'every response carries a request id for matching logs');

    assert.equal((await login('plain-ll@example.com', PASSWORD)).body.user.canManageWhatsAppTemplates, false);
    assert.equal((await login('super-ll@example.com', PASSWORD)).body.user.canManageWhatsAppTemplates, true);
  });

  test('the profile from sign-in is the same as /auth/me returns, so the browser need not ask again', async () => {
    const res = await login('granted-ll@example.com', PASSWORD);
    const me = await call('GET', '/api/auth/me', res.body.token);
    assert.equal(me.status, 200);
    const strip = (u: any) => JSON.stringify({ ...u, createdAt: undefined });
    assert.equal(strip(me.body.user), strip(res.body.user));
  });

  test('invalid credentials: the same 401 for an unknown email and a wrong password', async () => {
    const wrong = await login('granted-ll@example.com', WRONG);
    const unknown = await login('nobody-ll@example.com', WRONG);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body, 'nothing reveals which emails exist');
    assert.equal(wrong.body.error, 'Invalid credentials');
    assert.equal((await login('granted-ll@example.com', '')).status, 400);
  });

  test('refused accounts keep their messages: pending and expired', async () => {
    const pending = await login('pending-ll@example.com', PASSWORD);
    assert.equal(pending.status, 403);
    assert.match(pending.body.error, /pending approval/);
    const expired = await login('expired-ll@example.com', PASSWORD);
    assert.equal(expired.status, 403);
    assert.match(expired.body.error, /expired/);
  });

  test('password verification still runs on every attempt: a wrong password is never accepted, valid ones take bcrypt\'s time', async () => {
    const ok = await login('plain-ll@example.com', PASSWORD);
    assert.equal(ok.status, 200);
    const timings = await captureTiming(async () => { await login('plain-ll@example.com', PASSWORD); });
    assert.ok(timings[0].stages.password_check >= 20, `bcrypt cost is unchanged (took ${timings[0].stages.password_check} ms)`);
  });

  test('a failed audit write does not break sign-in, and a database error is a plain 500', async () => {
    const original = AuditService.log;
    AuditService.log = async () => false;
    try {
      assert.equal((await login('plain-ll@example.com', PASSWORD)).status, 200);
    } finally {
      AuditService.log = original;
    }
    const findOne = Admin.findOne;
    Admin.findOne = () => { throw new Error('database unavailable'); };
    try {
      const res = await login('plain-ll@example.com', PASSWORD);
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: 'Something went wrong' }, 'no internal detail leaks');
    } finally {
      Admin.findOne = findOne;
    }
  });
});

describe('timing log', () => {
  test('one line per sign-in with the request id, outcome and stage numbers - and nothing personal', async () => {
    let requestId = '';
    const lines = await captureTiming(async () => {
      const ok = await login('plain-ll@example.com', PASSWORD);
      requestId = String(ok.headers['x-request-id']);
      await login('plain-ll@example.com', WRONG);
      await login('pending-ll@example.com', PASSWORD);
      await login('nobody-ll@example.com', WRONG);
    });
    assert.deepEqual(lines.map((l) => l.outcome), ['success', 'invalid_credentials', 'denied', 'invalid_credentials']);
    assert.equal(lines[0].requestId, requestId, 'the log line matches the response header');
    assert.deepEqual(Object.keys(lines[0].stages), ['account_lookup', 'password_check', 'token', 'audit_and_profile']);
    const text = JSON.stringify(lines);
    for (const secret of [PASSWORD, WRONG, 'plain-ll', 'example.com', 'eyJ']) assert.equal(text.includes(secret), false, `logged: ${secret}`);
  });
});

describe('database not ready', () => {
  test('a request arriving before the database is connected gets a clear 503 in bounded time - and /health still answers', async () => {
    await mongoose.disconnect();
    try {
      const health = await call('GET', '/health', null);
      assert.equal(health.status, 200, '/health needs no database');
      const res = await login('plain-ll@example.com', PASSWORD);
      assert.equal(res.status, 503);
      assert.match(res.body.error, /starting up/);
      assert.equal(res.headers['retry-after'], '5');
      assert.ok(res.ms < 3000, `answered in bounded time (${res.ms} ms), not left hanging`);
    } finally {
      await mongoose.connect(TEST_DB);
    }
  });

  test('a request that arrives while the database is still connecting waits for it and then succeeds', async () => {
    await mongoose.disconnect();
    const connecting = new Promise<void>((resolve) => setTimeout(() => mongoose.connect(TEST_DB).then(() => resolve()), 150));
    const res = await login('plain-ll@example.com', PASSWORD);
    await connecting;
    assert.equal(res.status, 200, 'the first request after a (re)connect is served, not failed');
    assert.ok(res.ms >= 100, 'it did wait for the connection');
  });

  test('after a drop and a reconnect, sign-in works normally again', async () => {
    await mongoose.disconnect();
    assert.equal((await login('plain-ll@example.com', PASSWORD)).status, 503);
    await mongoose.connect(TEST_DB);
    assert.equal((await login('plain-ll@example.com', PASSWORD)).status, 200);
  });
});
