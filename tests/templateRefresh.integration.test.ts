import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Manual status refresh of a Pending WhatsApp template - against the REAL
 * compiled backend (backend/dist) and a throwaway MongoDB database.
 *
 * Meta is mocked at the adapter boundary (injected get/post), and a tripwire
 * on the axios instance the adapter would otherwise use fails the suite if any
 * call is not mocked. The token is fake.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_templaterefresh_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const distAxios = createRequire(require.resolve('../backend/dist/services/metaTemplateApi'))('axios');
const realHttp = { post: distAxios.post, get: distAxios.get, request: distAxios.request };
const unmockedCalls: string[] = [];
for (const method of ['post', 'get', 'request'] as const) {
  distAxios[method] = () => {
    unmockedCalls.push(method);
    return Promise.reject(new Error('tripwire: un-mocked Meta HTTP call'));
  };
}

const mongoose = require('mongoose');
const svc = require('../backend/dist/services/templateService');
const { WhatsAppTemplate } = require('../backend/dist/models/WhatsAppTemplate');
const { Admin } = require('../backend/dist/models/Admin');
const { AuditLog } = require('../backend/dist/models/AuditLog');

const FAKE_TOKEN = 'EAAG-FAKE-SENTINEL-TOKEN-never-real-7f3a9c';
const WABA = '102290129340398';
const CONNECTION = { accessToken: FAKE_TOKEN, wabaId: WABA, phoneNumberId: '1407379562449786', apiVersion: 'v22.0' };
const fx: any = {};
let seq = 0;
let clock = new Date('2026-10-12T10:00:00Z').getTime();
const later = (ms: number) => { clock += ms; };

/** Meta, mocked. byId answers GET /{id}; list answers GET /{waba}/message_templates. */
const meta = (handlers: { byId?: (id: string) => any; list?: (params: any) => any; delayMs?: number; onById?: () => Promise<void> } = {}) => {
  const calls = { byId: [] as any[], list: [] as any[], post: 0 };
  return {
    calls,
    deps: {
      connection: CONNECTION,
      now: () => new Date(clock),
      meta: {
        connection: CONNECTION,
        post: async () => { calls.post++; throw new Error('refresh must never POST'); },
        get: async (url: string, options: any) => {
          if (url.endsWith('/message_templates')) {
            calls.list.push({ url, params: options.params });
            return handlers.list ? handlers.list(options.params) : { data: { data: [] } };
          }
          const id = url.split('/').pop()!;
          calls.byId.push({ url, params: options.params, headers: options.headers });
          if (handlers.onById) await handlers.onById();
          if (handlers.delayMs) await new Promise((r) => setTimeout(r, handlers.delayMs));
          return handlers.byId ? handlers.byId(id) : { data: {} };
        },
      },
    },
  };
};

const node = (t: any, status: string, extra: Record<string, any> = {}) => ({
  data: { id: t.metaTemplateId, name: t.name, language: t.language, status, category: 'MARKETING', ...extra },
});

/** A template submitted to (mocked) Meta and now Pending. */
const pending = async (owner = fx.A) => {
  const name = `refresh_${++seq}`;
  const t = await svc.createTemplateDraft(owner, {
    displayName: 'Invitation', name, language: 'en', category: 'MARKETING',
    body: 'Dear {{1}}, you are invited.', variables: [{ position: 1, label: 'Guest', source: 'guest.name', sample: 'Riya' }],
  }, { connection: CONNECTION });
  const metaId = String(500000 + seq);
  const submitted = await svc.submitTemplate(owner, t.id, {
    connection: CONNECTION, now: () => new Date(clock),
    meta: { connection: CONNECTION, post: async () => ({ data: { id: metaId, status: 'PENDING', category: 'MARKETING' } }) },
  });
  assert.equal(submitted.template.localState, 'Pending');
  return submitted.template;
};

const stored = async (id: string) => WhatsAppTemplate.findById(id).lean();
const code = async (p: Promise<any>) => { try { await p; return 'resolved'; } catch (e: any) { return `${e.httpStatus}:${e.code}`; } };

before(async () => {
  await mongoose.connect(TEST_DB);
  await WhatsAppTemplate.init();
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-refresh@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminA = await Admin.create({ name: 'A', email: 'a-refresh@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.adminB = await Admin.create({ name: 'B', email: 'b-refresh@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.adminC = await Admin.create({ name: 'C', email: 'c-refresh@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.S = { id: String(fx.superAdmin._id), role: 'SuperAdmin' };
  fx.A = { id: String(fx.adminA._id), role: 'Admin' };
  fx.B = { id: String(fx.adminB._id), role: 'Admin' };
  fx.C = { id: String(fx.adminC._id), role: 'Admin' };
  fx.U = { id: String(new mongoose.Types.ObjectId()), role: 'User' };
});

after(async () => {
  Object.assign(distAxios, realHttp);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  assert.deepEqual(unmockedCalls, [], 'no test reached the real HTTP path');
});

beforeEach(async () => {
  await AuditLog.deleteMany({});
  later(60 * 60 * 1000);
});

describe("Meta's answer is recorded", () => {
  test('APPROVED: approved because Meta says so, with the time it was checked', async () => {
    const t = await pending();
    const m = meta({ byId: () => node(t, 'APPROVED') });
    const result = await svc.refreshTemplateStatus(fx.A, t.id, m.deps);
    assert.equal(result.outcome, 'approved');
    assert.equal(result.template.localState, 'Approved');
    assert.equal(result.template.metaStatus, 'APPROVED');
    assert.equal(new Date(result.template.lastSyncedAt).getTime(), clock);
    assert.equal(result.template.history.at(-1).type, 'refreshed');
    assert.equal(m.calls.byId.length, 1);
    assert.equal(m.calls.byId[0].url, `https://graph.facebook.com/v22.0/${t.metaTemplateId}`);
    assert.equal(m.calls.byId[0].params.fields, 'id,name,language,status,category,rejected_reason');
    assert.equal(m.calls.byId[0].headers.Authorization, `Bearer ${FAKE_TOKEN}`);
    assert.equal(m.calls.post, 0, 'nothing is created, edited or resubmitted');
    assert.equal(await AuditLog.countDocuments({ action: 'WHATSAPP_TEMPLATE_STATUS_REFRESHED' }), 1);
  });

  test("REJECTED: with Meta's reason", async () => {
    const t = await pending();
    const result = await svc.refreshTemplateStatus(fx.A, t.id, meta({ byId: () => node(t, 'REJECTED', { rejected_reason: 'INVALID_FORMAT' }) }).deps);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.template.localState, 'Rejected');
    assert.equal(result.template.rejectionReason, 'Rejected by Meta (reason: INVALID_FORMAT).');
    const none = await pending();
    const r2 = await svc.refreshTemplateStatus(fx.A, none.id, meta({ byId: () => node(none, 'REJECTED', { rejected_reason: 'NONE' }) }).deps);
    assert.equal(r2.template.rejectionReason, 'Rejected by Meta.');
  });

  test('PENDING: still pending, checked time updated, no audit noise', async () => {
    const t = await pending();
    const result = await svc.refreshTemplateStatus(fx.A, t.id, meta({ byId: () => node(t, 'PENDING') }).deps);
    assert.equal(result.outcome, 'pending');
    assert.equal(result.template.localState, 'Pending');
    assert.ok(result.template.lastSyncedAt);
    assert.equal(await AuditLog.countDocuments({ action: 'WHATSAPP_TEMPLATE_STATUS_REFRESHED' }), 0);
  });

  test('IN_APPEAL stays pending; LIMIT_EXCEEDED is a pause, as Meta documents it', async () => {
    const appeal = await pending();
    const r1 = await svc.refreshTemplateStatus(fx.A, appeal.id, meta({ byId: () => node(appeal, 'IN_APPEAL') }).deps);
    assert.deepEqual([r1.outcome, r1.template.localState, r1.template.metaStatus], ['pending', 'Pending', 'IN_APPEAL']);
    const paced = await pending();
    const r2 = await svc.refreshTemplateStatus(fx.A, paced.id, meta({ byId: () => node(paced, 'LIMIT_EXCEEDED') }).deps);
    assert.deepEqual([r2.outcome, r2.template.localState], ['updated', 'Paused']);
  });

  test("Meta's category is kept beside the one requested", async () => {
    const t = await pending();
    const r = await svc.refreshTemplateStatus(fx.A, t.id, meta({ byId: () => node(t, 'APPROVED', { category: 'UTILITY' }) }).deps);
    assert.equal(r.template.metaCategory, 'UTILITY');
    assert.equal(r.template.category, 'MARKETING');
  });
});

describe('a template Meta no longer has', () => {
  test('not found by id and not listed: reported, status left as it was', async () => {
    const t = await pending();
    const m = meta({
      byId: () => { throw { response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter' } } } }; },
      list: () => ({ data: { data: [{ id: '1', name: t.name, language: 'hi', status: 'APPROVED' }] } }),
    });
    const result = await svc.refreshTemplateStatus(fx.A, t.id, m.deps);
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.template.localState, 'Pending', 'never marked deleted on a guess');
    assert.equal(new Date(result.template.lastSyncedAt).getTime(), new Date(t.lastSyncedAt).getTime(), 'no status was confirmed');
    assert.equal(result.template.history.at(-1).type, 'refresh_not_found');
    assert.equal(m.calls.list[0].params.name, t.name);
  });

  test('not readable by id but still listed: nothing changes', async () => {
    const t = await pending();
    const m = meta({
      byId: () => { throw { response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter' } } } }; },
      list: () => ({ data: { data: [{ id: '999', name: t.name, language: 'en', status: 'APPROVED' }] } }),
    });
    assert.equal(await code(svc.refreshTemplateStatus(fx.A, t.id, m.deps)), '502:META_RESPONSE_INVALID');
    assert.equal((await stored(t.id)).localState, 'Pending');
  });
});

describe('who may refresh, and what', () => {
  test('a User, an Admin without the grant and another Admin are refused before Meta is asked', async () => {
    const t = await pending();
    const m = meta({ byId: () => node(t, 'APPROVED') });
    assert.equal(await code(svc.refreshTemplateStatus(fx.U, t.id, m.deps)), '403:ACCESS_DENIED');
    assert.equal(await code(svc.refreshTemplateStatus(fx.C, t.id, m.deps)), '403:ACCESS_DENIED');
    assert.equal(await code(svc.refreshTemplateStatus(fx.B, t.id, m.deps)), '404:TEMPLATE_NOT_FOUND');
    assert.equal(m.calls.byId.length, 0);
    assert.equal((await svc.refreshTemplateStatus(fx.S, t.id, m.deps)).outcome, 'approved', 'a Super Admin may');
  });

  test('only a Pending template with a valid Meta id in the configured account', async () => {
    const m = meta();
    const draft = await svc.createTemplateDraft(fx.A, {
      displayName: 'D', name: `draft_${++seq}`, language: 'en', category: 'UTILITY', body: 'Hello there.', variables: [],
    }, { connection: CONNECTION });
    assert.equal(await code(svc.refreshTemplateStatus(fx.A, draft.id, m.deps)), '409:NOT_REFRESHABLE');

    const badId = await pending();
    await WhatsAppTemplate.collection.updateOne({ _id: new mongoose.Types.ObjectId(badId.id) }, { $set: { metaTemplateId: '../../me' } });
    assert.equal(await code(svc.refreshTemplateStatus(fx.A, badId.id, m.deps)), '409:NOT_REFRESHABLE');
    const noId = await pending();
    await WhatsAppTemplate.collection.updateOne({ _id: new mongoose.Types.ObjectId(noId.id) }, { $set: { metaTemplateId: null } });
    assert.equal(await code(svc.refreshTemplateStatus(fx.A, noId.id, m.deps)), '409:NOT_REFRESHABLE');

    const other = await pending();
    const otherConnection = { ...CONNECTION, wabaId: '999999999999999' };
    assert.equal(await code(svc.refreshTemplateStatus(fx.A, other.id, { ...m.deps, connection: otherConnection, meta: { ...m.deps.meta, connection: otherConnection } })), '409:ACCOUNT_MISMATCH');
    const noToken = { ...CONNECTION, accessToken: undefined };
    assert.equal(await code(svc.refreshTemplateStatus(fx.A, other.id, { ...m.deps, connection: noToken, meta: { ...m.deps.meta, connection: noToken } })), '503:CONFIGURATION_ERROR');
    assert.equal(m.calls.byId.length, 0, 'Meta is never asked about an invalid id or another account');
  });
});

describe('Meta failures never change the status', () => {
  const cases: [string, () => never, string][] = [
    ['HTTP 401', () => { throw { response: { status: 401, data: {} } }; }, '502:META_AUTH_ERROR'],
    ['HTTP 403', () => { throw { response: { status: 403, data: {} } }; }, '502:META_AUTH_ERROR'],
    ['token rejected (190)', () => { throw { response: { status: 400, data: { error: { code: 190, message: 'Invalid OAuth access token' } } } }; }, '502:META_AUTH_ERROR'],
    ['permission error (200)', () => { throw { response: { status: 400, data: { error: { code: 200, message: 'Permissions error' } } } }; }, '502:META_AUTH_ERROR'],
    ['WABA rate limit (80008)', () => { throw { response: { status: 400, data: { error: { code: 80008, message: 'Too many calls' } } } }; }, '429:RATE_LIMITED'],
    ['HTTP 429', () => { throw { response: { status: 429, data: {} } }; }, '429:RATE_LIMITED'],
    ['HTTP 500', () => { throw { response: { status: 500, data: { error: { code: 1, message: 'Unknown error' } } } }; }, '502:META_UNAVAILABLE'],
    ['timeout', () => { throw { code: 'ECONNABORTED' }; }, '502:META_UNAVAILABLE'],
    ['connection reset', () => { throw { code: 'ECONNRESET' }; }, '502:META_UNAVAILABLE'],
  ];
  for (const [label, fail, expected] of cases) {
    test(label, async () => {
      const t = await pending();
      assert.equal(await code(svc.refreshTemplateStatus(fx.A, t.id, meta({ byId: fail }).deps)), expected);
      const after = await stored(t.id);
      assert.deepEqual([after.localState, after.metaStatus, String(after.lastSyncedAt)], ['Pending', 'PENDING', String(new Date(t.lastSyncedAt))]);
    });
  }

  test('a success response that is not this template, or not a documented status, is not trusted', async () => {
    for (const [label, answer] of [
      ['empty body', (t: any) => ({ data: {} })],
      ['no status', (t: any) => ({ data: { id: t.metaTemplateId, name: t.name, language: t.language } })],
      ['another id', (t: any) => node({ ...t, metaTemplateId: '1' }, 'APPROVED')],
      ['another name', (t: any) => node({ ...t, name: 'other_name' }, 'APPROVED')],
      ['another language', (t: any) => node({ ...t, language: 'hi' }, 'APPROVED')],
      ['undocumented status', (t: any) => node(t, 'APPROVED_ISH')],
      ['lowercase status', (t: any) => node(t, 'approved')],
    ] as const) {
      const t = await pending();
      assert.equal(await code(svc.refreshTemplateStatus(fx.A, t.id, meta({ byId: () => answer(t) }).deps)), '502:META_RESPONSE_INVALID', label);
      assert.equal((await stored(t.id)).localState, 'Pending', label);
    }
  });
});

describe('refreshes are spaced out and never overwrite newer state', () => {
  test('a second refresh within the cooldown is refused without asking Meta', async () => {
    const t = await pending();
    const m = meta({ byId: () => node(t, 'PENDING') });
    await svc.refreshTemplateStatus(fx.A, t.id, m.deps);
    later(5_000);
    const error = await svc.refreshTemplateStatus(fx.A, t.id, m.deps).catch((e: any) => e);
    assert.equal(`${error.httpStatus}:${error.code}`, '429:REFRESH_TOO_SOON');
    assert.match(error.message, /Try again in 25s/);
    assert.equal(m.calls.byId.length, 1);
    later(svc.REFRESH_COOLDOWN_MS);
    await svc.refreshTemplateStatus(fx.A, t.id, m.deps);
    assert.equal(m.calls.byId.length, 2);
  });

  test('two refreshes at once reach Meta once', async () => {
    const t = await pending();
    const m = meta({ byId: () => node(t, 'APPROVED'), delayMs: 100 });
    const outcomes = await Promise.allSettled([svc.refreshTemplateStatus(fx.A, t.id, m.deps), svc.refreshTemplateStatus(fx.A, t.id, m.deps)]);
    assert.equal(m.calls.byId.length, 1);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.equal((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason.code, 'REFRESH_TOO_SOON');
  });

  test('a slow answer never overwrites a state that changed meanwhile', async () => {
    const t = await pending();
    // While Meta is being asked, another writer (a future status webhook, an
    // operator) records Meta's newer decision.
    const m = meta({
      onById: async () => {
        await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: 'Rejected', metaStatus: 'REJECTED' } });
      },
      byId: () => node(t, 'APPROVED'),
    });
    const result = await svc.refreshTemplateStatus(fx.A, t.id, m.deps);
    assert.equal(result.outcome, 'superseded');
    const after = await stored(t.id);
    assert.deepEqual([after.localState, after.metaStatus], ['Rejected', 'REJECTED'], 'the stale APPROVED answer was not written');
    assert.equal(after.history.filter((h: any) => h.type === 'refreshed').length, 0);
  });

  test('a template that left Pending before the refresh began is shown as it is', async () => {
    const t = await pending();
    const m = meta({ byId: () => node(t, 'APPROVED') });
    // Read as Pending, but changed before the claim.
    const original = WhatsAppTemplate.findOneAndUpdate.bind(WhatsAppTemplate);
    WhatsAppTemplate.findOneAndUpdate = async (...args: any[]) => {
      await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: 'Paused', metaStatus: 'PAUSED' } });
      return original(...args);
    };
    try {
      const result = await svc.refreshTemplateStatus(fx.A, t.id, m.deps);
      assert.equal(result.outcome, 'superseded');
      assert.equal(result.template.localState, 'Paused');
      assert.equal(m.calls.byId.length, 0);
    } finally {
      WhatsAppTemplate.findOneAndUpdate = original;
    }
  });

  test('refresh never resubmits or edits: no POST, and the definition is untouched', async () => {
    const t = await pending();
    const before = await stored(t.id);
    const m = meta({ byId: () => node(t, 'REJECTED', { rejected_reason: 'PROMOTIONAL' }) });
    await svc.refreshTemplateStatus(fx.A, t.id, m.deps);
    const after = await stored(t.id);
    assert.equal(m.calls.post, 0);
    for (const field of ['body', 'name', 'language', 'category', 'allowCategoryChange', 'variables', 'metaTemplateId', 'wabaId']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.equal(after.submission.attempts, before.submission.attempts);
  });
});
