import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Permission to manage WhatsApp templates:
 *  - PUT /api/admin/admins/:id/whatsapp-template-access - Super Admin only,
 *    Admin targets only, audited;
 *  - the flag in /api/auth/me and the login profile (for showing the page);
 *  - the flag is never accepted from a request body anywhere else.
 *
 * Over real HTTP against the REAL compiled backend (backend/dist) on a
 * throwaway database. Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_templateperm_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const authRoutes = require('../backend/dist/routes/authRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { AuditLog } = require('../backend/dist/models/AuditLog');

const PASSWORD = 'PermTest12345';
let server: any;
let baseUrl = '';
let ip = 0;
const fx: any = {};

const call = (method: string, path: string, token: string | null, body?: any): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    // A fresh client address per call keeps the per-IP rate limiters out of the way.
    const headers: Record<string, string> = { 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(baseUrl + path);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const grant = (id: any, enabled: unknown, token = fx.super) => call('PUT', `/api/admin/admins/${id}/whatsapp-template-access`, token, { enabled });

before(async () => {
  await mongoose.connect(TEST_DB);
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-perm@example.com', passwordHash, role: 'SuperAdmin', status: 'Active' });
  fx.admin = await Admin.create({ name: 'Admin', email: 'admin-perm@example.com', passwordHash, role: 'Admin', status: 'Active' });
  fx.other = await Admin.create({ name: 'Other', email: 'other-perm@example.com', passwordHash, role: 'Admin', status: 'Active' });
  fx.user = await User.create({ name: 'User', email: 'user-perm@example.com', passwordHash, status: 'Active', adminId: fx.admin._id });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.adminToken = tokenFor(fx.admin, 'Admin');
  fx.userToken = tokenFor(fx.user, 'User');

  const app = express();
  app.set('trust proxy', 2);
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use('/api/auth', authRoutes);
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
  await Admin.updateMany({ role: 'Admin' }, { $unset: { canManageWhatsAppTemplates: 1 } });
  await AuditLog.deleteMany({});
});

describe('granting and revoking', () => {
  test('a Super Admin grants and revokes; each change is audited', async () => {
    const granted = await grant(fx.admin._id, true);
    assert.equal(granted.status, 200);
    assert.deepEqual(granted.body, { id: String(fx.admin._id), canManageWhatsAppTemplates: true, changed: true });
    assert.equal((await Admin.findById(fx.admin._id).lean()).canManageWhatsAppTemplates, true);

    const revoked = await grant(fx.admin._id, false);
    assert.deepEqual(revoked.body, { id: String(fx.admin._id), canManageWhatsAppTemplates: false, changed: true });
    assert.equal((await Admin.findById(fx.admin._id).lean()).canManageWhatsAppTemplates, false);

    const entries = await AuditLog.find({ collectionName: 'admins' }).sort({ timestamp: 1 }).lean();
    assert.deepEqual(entries.map((e: any) => e.action), ['WHATSAPP_TEMPLATE_ACCESS_GRANTED', 'WHATSAPP_TEMPLATE_ACCESS_REVOKED']);
    assert.equal(entries[0].actor.role, 'SuperAdmin');
    assert.deepEqual(entries[0].changes.changedFields.filter((f: string) => f === 'canManageWhatsAppTemplates'), ['canManageWhatsAppTemplates']);
    assert.equal(JSON.stringify(entries).includes('$2b$'), false, 'no password hash in the audit snapshots');
  });

  test('a request that changes nothing is answered but not logged as a change', async () => {
    const res = await grant(fx.admin._id, false);
    assert.deepEqual(res.body, { id: String(fx.admin._id), canManageWhatsAppTemplates: false, changed: false });
    assert.equal(await AuditLog.countDocuments({}), 0);
  });

  test('only a Super Admin may grant or revoke', async () => {
    assert.equal((await grant(fx.other._id, true, fx.adminToken)).status, 403, 'an Admin, even for another Admin');
    assert.equal((await grant(fx.admin._id, true, fx.adminToken)).status, 403, 'an Admin, for themselves');
    assert.equal((await grant(fx.admin._id, true, fx.userToken)).status, 403, 'a User');
    assert.equal((await grant(fx.admin._id, true, null)).status, 401, 'nobody');
    assert.equal((await Admin.findById(fx.admin._id).lean()).canManageWhatsAppTemplates, undefined);
  });

  test('an Admin whose grant was given still cannot grant it to others', async () => {
    await Admin.updateOne({ _id: fx.admin._id }, { $set: { canManageWhatsAppTemplates: true } });
    assert.equal((await grant(fx.other._id, true, fx.adminToken)).status, 403);
  });

  test('only Admin accounts can be targeted, and input is validated', async () => {
    assert.equal((await grant(fx.superAdmin._id, false)).status, 400, 'a Super Admin has nothing to grant or revoke');
    assert.equal((await grant(fx.user._id, true)).status, 404, 'a User account is not an Admin');
    assert.equal((await grant(new mongoose.Types.ObjectId(), true)).status, 404);
    assert.equal((await grant('not-an-id', true)).status, 400);
    for (const bad of ['true', 1, null, undefined]) {
      assert.equal((await grant(fx.admin._id, bad)).status, 400, `enabled=${JSON.stringify(bad)}`);
    }
    const extra = await call('PUT', `/api/admin/admins/${fx.admin._id}/whatsapp-template-access`, fx.super, { enabled: true, role: 'SuperAdmin' });
    assert.equal(extra.status, 400, 'no other field is accepted');
    assert.equal((await Admin.findById(fx.admin._id).lean()).role, 'Admin');
  });
});

describe('the flag in the signed-in profile', () => {
  const me = async (token: string) => (await call('GET', '/api/auth/me', token)).body.user;

  test('a Super Admin always has it; an Admin only with the grant; a User never', async () => {
    assert.equal((await me(fx.super)).canManageWhatsAppTemplates, true);
    assert.equal((await me(fx.adminToken)).canManageWhatsAppTemplates, false);
    await Admin.updateOne({ _id: fx.admin._id }, { $set: { canManageWhatsAppTemplates: true } });
    assert.equal((await me(fx.adminToken)).canManageWhatsAppTemplates, true);
    assert.equal((await me(fx.userToken)).canManageWhatsAppTemplates, false);
  });

  test('login returns it too', async () => {
    await Admin.updateOne({ _id: fx.admin._id }, { $set: { canManageWhatsAppTemplates: true } });
    const res = await call('POST', '/api/auth/login', null, { email: 'admin-perm@example.com', password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.canManageWhatsAppTemplates, true);
  });

  test('a User document carrying the field never gains it', async () => {
    await User.collection.updateOne({ _id: fx.user._id }, { $set: { canManageWhatsAppTemplates: true } });
    assert.equal((await me(fx.userToken)).canManageWhatsAppTemplates, false);
    await User.collection.updateOne({ _id: fx.user._id }, { $unset: { canManageWhatsAppTemplates: 1 } });
  });
});
