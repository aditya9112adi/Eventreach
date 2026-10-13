import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * WhatsApp credentials and the Settings page (Stage 1 audit, F-1):
 *  - GET /api/settings never returns a stored or configured credential, only
 *    whether each one is configured;
 *  - PUT /api/settings refuses a credential instead of storing it in plain text;
 *  - audit snapshots redact a secret held in a field named `value`, both when
 *    written and when read back (entries stored before the fix);
 *  - the cleanup service finds and removes stored credentials by id, never
 *    exposing a value.
 *
 * Every token here is fake. Over real HTTP against the REAL compiled backend
 * (backend/dist) on a throwaway database. Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_settingssecrets_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const FAKE_STORED_TOKEN = 'EAAFAKESTOREDTOKEN0123456789abcdef';
const FAKE_ENV_TOKEN = 'EAAFAKEENVTOKEN9876543210fedcba';
const FAKE_VERIFY = 'fake-verify-token-1234';
const FAKE_APP_SECRET = 'fake-app-secret-5678';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const settingsRoutes = require('../backend/dist/routes/settingsRoutes').default;
const auditRoutes = require('../backend/dist/routes/auditRoutes').default;
const { Admin } = require('../backend/dist/models/Admin');
const { Settings } = require('../backend/dist/models/Settings');
const { AuditLog } = require('../backend/dist/models/AuditLog');
const { AuditService, sanitizeObject } = require('../backend/dist/services/AuditService');
const { findLegacySecrets, removeLegacySecrets } = require('../backend/dist/services/legacySettingsSecrets');

let server: any;
let baseUrl = '';
const fx: any = {};

const call = (method: string, path: string, token: string, body?: any): Promise<{ status: number; body: any; raw: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
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
        resolve({ status: res.statusCode || 0, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

before(async () => {
  await mongoose.connect(TEST_DB);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-settings@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.admin = await Admin.create({ name: 'Admin', email: 'admin-settings@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.adminToken = tokenFor(fx.admin, 'Admin');

  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
  app.use('/api/audit', auditRoutes);
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
  await Settings.deleteMany({});
  await AuditLog.deleteMany({});
});

describe('GET /api/settings reports the connection, never a credential', () => {
  test('a stored token and the configured credentials never appear in the response', async () => {
    await Settings.create({ key: 'whatsapp_token', value: FAKE_STORED_TOKEN });
    await Settings.create({ key: 'webhook_verify_token', value: 'stored-verify-value' });
    await Settings.create({ key: 'company_name', value: 'Elite Events' });

    await withEnv(
      { WHATSAPP_TOKEN: FAKE_ENV_TOKEN, WHATSAPP_PHONE_ID: '109876543210987', WHATSAPP_WABA_ID: '200000000004321', WHATSAPP_APP_SECRET: FAKE_APP_SECRET, WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY },
      async () => {
        const res = await call('GET', '/api/settings', fx.super);
        assert.equal(res.status, 200);
        for (const secret of [FAKE_STORED_TOKEN, FAKE_STORED_TOKEN.slice(-4), FAKE_ENV_TOKEN, FAKE_APP_SECRET, FAKE_VERIFY, 'stored-verify-value', '109876543210987']) {
          assert.equal(res.raw.includes(secret), false, 'no credential, or part of one, in the response');
        }
        for (const key of ['whatsapp_token', 'whatsapp_phone_id', 'webhook_verify_token']) {
          assert.equal(key in res.body, false, `${key} is no longer returned`);
        }
        assert.equal(res.body.company_name, 'Elite Events', 'editable settings are unchanged');
        const c = res.body.whatsappConnection;
        assert.equal(c.mode, 'live');
        assert.deepEqual(c.configured, { accessToken: true, phoneNumberId: true, wabaId: true, appSecret: true, verifyToken: true });
        assert.equal(c.phoneNumberIdHint, '…0987');
        assert.equal(c.wabaIdHint, '…4321');
        assert.deepEqual(c.legacyStoredSettings.sort(), ['webhook_verify_token', 'whatsapp_token'], 'says a credential is stored, not what it is');
      }
    );
  });

  test('without a token or phone id the connection is reported as simulated', async () => {
    await withEnv({ WHATSAPP_TOKEN: undefined, WHATSAPP_PHONE_ID: undefined, WHATSAPP_WABA_ID: undefined }, async () => {
      const res = await call('GET', '/api/settings', fx.super);
      assert.equal(res.body.whatsappConnection.mode, 'simulated');
      assert.equal(res.body.whatsappConnection.configured.accessToken, false);
      assert.deepEqual(res.body.whatsappConnection.legacyStoredSettings, []);
    });
  });

  test('only a Super Admin can read or change Settings', async () => {
    assert.equal((await call('GET', '/api/settings', fx.adminToken)).status, 403);
    assert.equal((await call('PUT', '/api/settings', fx.adminToken, { company_name: 'X' })).status, 403);
  });
});

describe('PUT /api/settings never stores a credential', () => {
  test('a credential is refused, and nothing else in the request is saved', async () => {
    const res = await call('PUT', '/api/settings', fx.super, { company_name: 'Should Not Save', whatsapp_token: FAKE_STORED_TOKEN });
    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'whatsapp_token');
    assert.match(res.body.error, /configured on the server/);
    assert.equal(await Settings.countDocuments({}), 0, 'no partial write');
    assert.equal(await AuditLog.countDocuments({}), 0);
  });

  for (const key of ['whatsapp_phone_id', 'webhook_verify_token']) {
    test(`${key} is refused too`, async () => {
      const res = await call('PUT', '/api/settings', fx.super, { [key]: 'some-value' });
      assert.equal(res.status, 400);
      assert.equal(await Settings.countDocuments({ key }), 0);
    });
  }

  test('empty or masked values from an older page are ignored, and the rest saves', async () => {
    const res = await call('PUT', '/api/settings', fx.super, {
      whatsapp_token: '••••••••abcd', whatsapp_phone_id: '', webhook_verify_token: '   ',
      company_name: 'Elite Events', default_country_code: 'IN',
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await Settings.find({}).lean()).map((s: any) => s.key).sort(), ['company_name', 'default_country_code']);
  });

  test('existing validation is unchanged', async () => {
    assert.equal((await call('PUT', '/api/settings', fx.super, { company_name: 42 })).status, 400);
    assert.equal((await call('PUT', '/api/settings', fx.super, { company_name: 'x'.repeat(2001) })).status, 400);
    assert.equal((await call('PUT', '/api/settings', fx.super, ['company_name'])).status, 400, 'not an object');
  });
});

describe('audit snapshots never hold a secret named `value`', () => {
  test('a Settings token is redacted when the entry is written', async () => {
    const before = await Settings.create({ key: 'whatsapp_token', value: 'old-' + FAKE_STORED_TOKEN });
    const afterDoc = await Settings.findOneAndUpdate({ key: 'whatsapp_token' }, { value: FAKE_STORED_TOKEN }, { new: true });
    await AuditService.log({ action: 'SETTINGS_UPDATED', collectionName: 'settings', documentId: String(before._id), before, after: afterDoc });

    const stored: any = await AuditLog.findOne({}).lean();
    assert.equal(stored.changes.before.value, '***REDACTED***');
    assert.equal(stored.changes.after.value, '***REDACTED***');
    assert.equal(stored.changes.after.key, 'whatsapp_token', 'which setting changed is kept');
    assert.equal(JSON.stringify(stored).includes(FAKE_STORED_TOKEN), false);
  });

  test('a non-secret setting keeps its value', () => {
    assert.deepEqual(sanitizeObject({ key: 'company_name', value: 'Elite Events' }), { key: 'company_name', value: 'Elite Events' });
    assert.deepEqual(sanitizeObject({ key: 'whatsapp_phone_id', value: '123' }), { key: 'whatsapp_phone_id', value: '123' });
  });

  test('the rule applies at any depth, and existing field-name redaction still works', () => {
    const out = sanitizeObject({ list: [{ key: 'webhook_verify_token', value: FAKE_VERIFY }], apiKey: 'k', passwordHash: 'h', name: 'n' });
    assert.equal(out.list[0].value, '***REDACTED***');
    assert.equal(out.apiKey, '***REDACTED***');
    assert.equal(out.passwordHash, '***REDACTED***');
    assert.equal(out.name, 'n');
  });

  test('an entry stored before the fix is redacted when it is read', async () => {
    await AuditLog.collection.insertOne({
      action: 'SETTINGS_UPDATED', collectionName: 'settings', timestamp: new Date(), description: 'Updated setting: whatsapp_token',
      actor: { userId: null, email: null, name: 'System', role: 'SYSTEM' },
      changes: { before: { key: 'whatsapp_token', value: 'old-' + FAKE_STORED_TOKEN }, after: { key: 'whatsapp_token', value: FAKE_STORED_TOKEN }, changedFields: ['value'] },
      bulk: { isBulk: false }, metadata: {}, success: true,
    });
    const res = await call('GET', '/api/audit', fx.super);
    assert.equal(res.status, 200);
    assert.equal(res.raw.includes(FAKE_STORED_TOKEN), false);
    assert.equal(res.body.logs[0].changes.after.value, '***REDACTED***');
    assert.equal(res.body.logs[0].changes.after.key, 'whatsapp_token');
    assert.deepEqual(res.body.logs[0].changes.changedFields, ['value']);
    assert.equal(res.body.logs[0].description, 'Updated setting: whatsapp_token');
  });
});

describe('cleanup of credentials stored by the old page', () => {
  const seedLegacy = async () => {
    await Settings.create({ key: 'whatsapp_token', value: FAKE_STORED_TOKEN });
    await Settings.create({ key: 'whatsapp_phone_id', value: '123456' });
    await Settings.create({ key: 'company_name', value: 'Elite Events' });
    const entry = await AuditLog.collection.insertOne({
      action: 'SETTINGS_UPDATED', collectionName: 'settings', timestamp: new Date('2026-01-01T00:00:00Z'),
      changes: { before: null, after: { key: 'whatsapp_token', value: FAKE_STORED_TOKEN }, changedFields: [] },
      bulk: { isBulk: false }, metadata: {}, success: true,
    });
    await AuditLog.collection.insertOne({
      action: 'SETTINGS_UPDATED', collectionName: 'settings', timestamp: new Date('2026-01-02T00:00:00Z'),
      changes: { before: { key: 'company_name', value: 'Old' }, after: { key: 'company_name', value: 'Elite Events' }, changedFields: ['value'] },
      bulk: { isBulk: false }, metadata: {}, success: true,
    });
    return String(entry.insertedId);
  };

  test('the report names records by id and time, never by value', async () => {
    const id = await seedLegacy();
    const report = await findLegacySecrets();
    assert.deepEqual(report.storedSettings.map((s: any) => s.key), ['whatsapp_token']);
    assert.deepEqual(report.auditEntries.map((a: any) => a.id), [id]);
    assert.equal(JSON.stringify(report).includes(FAKE_STORED_TOKEN), false);
  });

  test('removal blanks the stored credential and redacts the snapshot, keeping everything else', async () => {
    await seedLegacy();
    const result = await removeLegacySecrets();
    assert.deepEqual(result, { settingsCleared: 1, auditSnapshotsRedacted: 1 });

    assert.equal((await Settings.findOne({ key: 'whatsapp_token' }).lean() as any).value, '');
    assert.equal((await Settings.findOne({ key: 'whatsapp_phone_id' }).lean() as any).value, '123456', 'not a secret: left alone');
    assert.equal((await Settings.findOne({ key: 'company_name' }).lean() as any).value, 'Elite Events');
    assert.equal(await AuditLog.countDocuments({}), 2, 'no audit entry is deleted');
    const all = JSON.stringify(await AuditLog.find({}).lean());
    assert.equal(all.includes(FAKE_STORED_TOKEN), false);
    assert.ok(all.includes('"value":"Old"'), 'non-secret snapshots are untouched');

    assert.deepEqual(await removeLegacySecrets(), { settingsCleared: 0, auditSnapshotsRedacted: 0 }, 'safe to re-run');
    assert.deepEqual(await findLegacySecrets(), { storedSettings: [], auditEntries: [] });
  });
});
