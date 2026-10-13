import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * WhatsApp template management - the persistent workflow and its
 * authorization, against the REAL compiled backend (backend/dist) and a
 * throwaway MongoDB database. Meta is ALWAYS mocked (injected post/get): no
 * real template is created and no real token exists - the fake one is checked
 * for in everything stored.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_templates_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const mongoose = require('mongoose');
const svc = require('../backend/dist/services/templateService');
const { WhatsAppTemplate } = require('../backend/dist/models/WhatsAppTemplate');
const { Admin } = require('../backend/dist/models/Admin');
const { Event } = require('../backend/dist/models/Event');
const { AuditLog } = require('../backend/dist/models/AuditLog');

/**
 * Tripwire on the adapter's real HTTP path. Every test injects Meta at the
 * adapter boundary (deps.meta.post/get); the axios instance the compiled
 * adapter would fall back to is replaced so that any call reaching it fails
 * the test and is counted. after() asserts it was never reached.
 */
const distAxios = createRequire(require.resolve('../backend/dist/services/metaTemplateApi'))('axios');
const realHttp = { post: distAxios.post, get: distAxios.get, request: distAxios.request };
const unmockedCalls: string[] = [];
for (const method of ['post', 'get', 'request'] as const) {
  distAxios[method] = (url: any) => {
    unmockedCalls.push(`${method} ${typeof url === 'string' ? new URL(url).hostname : 'request'}`);
    return Promise.reject(new Error('tripwire: un-mocked Meta HTTP call'));
  };
}

const FAKE_TOKEN = 'EAAG-FAKE-SENTINEL-TOKEN-never-real-7f3a9c';
const WABA = '102290129340398';
const CONNECTION = { accessToken: FAKE_TOKEN, wabaId: WABA, phoneNumberId: '1407379562449786', apiVersion: 'v22.0' };

const fx: any = {};

const actor = (account: any, role: string) => ({ id: String(account._id), email: account.email, role });

const mkEvent = (eventName: string, adminId: any) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', adminId, createdBy: adminId,
  });

let nameSeq = 0;
const draft = (overrides: Record<string, any> = {}) => ({
  displayName: 'Wedding invitation',
  name: `invite_${++nameSeq}`,
  language: 'en',
  category: 'MARKETING',
  body: 'Dear {{1}}, you are invited to the wedding of Pranjali & Ankit.',
  variables: [{ position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' }],
  ...overrides,
});

/** A mocked Meta. Records every call; answers as told. */
const metaMock = (opts: { post?: (body: any) => any; get?: (params: any) => any; delayMs?: number } = {}) => {
  const calls = { post: [] as any[], get: [] as any[] };
  return {
    calls,
    deps: {
      connection: CONNECTION,
      meta: {
        connection: CONNECTION,
        post: async (url: string, body: any, options: any) => {
          calls.post.push({ url, body, options });
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          return opts.post ? opts.post(body) : { data: { id: `${9000 + calls.post.length}`, status: 'PENDING', category: 'MARKETING' } };
        },
        get: async (url: string, options: any) => {
          calls.get.push({ url, params: options.params });
          return opts.get ? opts.get(options.params) : { data: { data: [] } };
        },
      },
    },
  };
};

const timeout = () => { throw { code: 'ECONNABORTED' }; };

before(async () => {
  await mongoose.connect(TEST_DB);
  await WhatsAppTemplate.init();
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-tpl@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  // A and B hold the explicit grant; C is an Admin without it.
  fx.adminA = await Admin.create({ name: 'Admin A', email: 'a-tpl@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.adminB = await Admin.create({ name: 'Admin B', email: 'b-tpl@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.adminC = await Admin.create({ name: 'Admin C', email: 'c-tpl@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.eventA = await mkEvent('A Wedding', fx.adminA._id);
  fx.eventB = await mkEvent('B Wedding', fx.adminB._id);
  fx.S = actor(fx.superAdmin, 'SuperAdmin');
  fx.A = actor(fx.adminA, 'Admin');
  fx.B = actor(fx.adminB, 'Admin');
  fx.C = actor(fx.adminC, 'Admin');
  fx.U = { id: String(new mongoose.Types.ObjectId()), role: 'User' };
});

after(async () => {
  Object.assign(distAxios, realHttp);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  assert.deepEqual(unmockedCalls, [], 'no test reached the real HTTP path');
});

beforeEach(async () => {
  await WhatsAppTemplate.deleteMany({});
  await AuditLog.deleteMany({});
});

const code = async (promise: Promise<any>) => {
  try { await promise; return 'resolved'; } catch (e: any) { return `${e.httpStatus}:${e.code}`; }
};

describe('Meta is mocked at the adapter boundary', () => {
  test('the tripwire catches a call that is not injected', async () => {
    const { createMetaTemplate } = require('../backend/dist/services/metaTemplateApi');
    const error = await createMetaTemplate({}, { connection: CONNECTION }).catch((e: any) => e);
    assert.equal(error.kind, 'AMBIGUOUS', 'the rejected call surfaces as no answer');
    assert.deepEqual(unmockedCalls.splice(0), ['post graph.facebook.com'], 'caught, then cleared for the real assertion');
  });
});

describe('who can manage templates', () => {
  test('a User cannot create, list or read templates', async () => {
    assert.equal(await code(svc.createTemplateDraft(fx.U, draft(), { connection: CONNECTION })), '403:ACCESS_DENIED');
    assert.equal(await code(svc.listTemplates(fx.U)), '403:ACCESS_DENIED');
  });

  test('an Admin without the grant is refused on every operation', async () => {
    const shared = await svc.createTemplateDraft(fx.S, draft(), { connection: CONNECTION });
    const ofA = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const { deps, calls } = metaMock();
    for (const [label, attempt] of [
      ['create', () => svc.createTemplateDraft(fx.C, draft(), { connection: CONNECTION })],
      ['list', () => svc.listTemplates(fx.C)],
      ['read shared', () => svc.getTemplate(fx.C, shared.id)],
      ['read private', () => svc.getTemplate(fx.C, ofA.id)],
      ['update', () => svc.updateTemplateDraft(fx.C, ofA.id, { displayName: 'x' })],
      ['submit', () => svc.submitTemplate(fx.C, ofA.id, deps)],
      ['reconcile', () => svc.reconcileTemplate(fx.C, ofA.id, deps)],
    ] as const) {
      assert.equal(await code(attempt()), '403:ACCESS_DENIED', label);
    }
    assert.equal(calls.post.length + calls.get.length, 0);
  });

  test('a grant or revocation applies on the very next call; templates are kept', async () => {
    await Admin.updateOne({ _id: fx.adminC._id }, { $set: { canManageWhatsAppTemplates: true } });
    const t = await svc.createTemplateDraft(fx.C, draft(), { connection: CONNECTION });

    await Admin.updateOne({ _id: fx.adminC._id }, { $set: { canManageWhatsAppTemplates: false } });
    assert.equal(await code(svc.updateTemplateDraft(fx.C, t.id, { displayName: 'after revoke' })), '403:ACCESS_DENIED');
    assert.equal(await WhatsAppTemplate.countDocuments({ _id: t.id }), 1, 'the template is kept');
    assert.equal((await svc.getTemplate(fx.S, t.id)).ownerAdminId, String(fx.adminC._id), 'a Super Admin can still manage it');

    await Admin.updateOne({ _id: fx.adminC._id }, { $unset: { canManageWhatsAppTemplates: 1 } });
    assert.equal(await code(svc.listTemplates(fx.C)), '403:ACCESS_DENIED', 'absent means no grant');
  });

  test('a claimed role is never trusted: the database decides', async () => {
    assert.equal(await code(svc.listTemplates({ ...fx.C, role: 'SuperAdmin' })), '403:ACCESS_DENIED', 'an ungranted Admin claiming Super Admin');
    assert.equal(await code(svc.listTemplates({ ...fx.U, role: 'SuperAdmin' })), '403:ACCESS_DENIED', 'an id that is not an Admin account');
    const ofB = await svc.createTemplateDraft(fx.B, draft(), { connection: CONNECTION });
    // A real Super Admin is one even if the caller says Admin.
    assert.equal((await svc.getTemplate({ ...fx.S, role: 'Admin' }, ofB.id)).id, ofB.id);
  });

  test('an Admin always owns what they create, whatever the request says', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ ownerAdminId: String(fx.adminB._id) }), { connection: CONNECTION });
    assert.equal(t.ownerAdminId, String(fx.adminA._id));
    assert.equal(t.localState, 'Draft');
    assert.equal('wabaId' in t, false, 'not shown to an Admin');
    assert.equal((await WhatsAppTemplate.findById(t.id).lean()).wabaId, WABA, 'but scoped to the configured account');
  });

  test('a Super Admin creates shared templates, or templates for an Admin', async () => {
    const shared = await svc.createTemplateDraft(fx.S, draft(), { connection: CONNECTION });
    const forA = await svc.createTemplateDraft(fx.S, draft({ ownerAdminId: String(fx.adminA._id) }), { connection: CONNECTION });
    assert.equal(shared.ownerAdminId, null);
    assert.equal(forA.ownerAdminId, String(fx.adminA._id));
    assert.equal(await code(svc.createTemplateDraft(fx.S, draft({ ownerAdminId: String(fx.superAdmin._id) }), { connection: CONNECTION })), '400:VALIDATION_ERROR', 'an owner must be an Admin');
  });

  test("another client's template is invisible; a shared one is read-only", async () => {
    const ofB = await svc.createTemplateDraft(fx.B, draft(), { connection: CONNECTION });
    const shared = await svc.createTemplateDraft(fx.S, draft(), { connection: CONNECTION });
    const { deps, calls } = metaMock();

    assert.equal(await code(svc.getTemplate(fx.A, ofB.id)), '404:TEMPLATE_NOT_FOUND');
    assert.equal(await code(svc.updateTemplateDraft(fx.A, ofB.id, { displayName: 'Mine now' })), '404:TEMPLATE_NOT_FOUND');
    assert.equal(await code(svc.submitTemplate(fx.A, ofB.id, deps)), '404:TEMPLATE_NOT_FOUND');
    assert.equal((await svc.getTemplate(fx.A, shared.id)).id, shared.id);
    assert.equal(await code(svc.updateTemplateDraft(fx.A, shared.id, { displayName: 'x' })), '403:ACCESS_DENIED');
    assert.equal(await code(svc.submitTemplate(fx.A, shared.id, deps)), '403:ACCESS_DENIED');
    assert.equal(calls.post.length, 0, 'Meta is never called for a refused request');
  });

  test('lists are scoped: own and shared for an Admin, everything for a Super Admin', async () => {
    const ofA = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const ofB = await svc.createTemplateDraft(fx.B, draft(), { connection: CONNECTION });
    const shared = await svc.createTemplateDraft(fx.S, draft(), { connection: CONNECTION });
    const ids = (page: any) => page.data.map((t: any) => t.id).sort();
    assert.deepEqual(ids(await svc.listTemplates(fx.A)), [ofA.id, shared.id].sort());
    assert.deepEqual(ids(await svc.listTemplates(fx.B)), [ofB.id, shared.id].sort());
    assert.deepEqual(ids(await svc.listTemplates(fx.S)), [ofA.id, ofB.id, shared.id].sort());
  });

  test("an event-specific template must use the owner's own event", async () => {
    assert.equal(await code(svc.createTemplateDraft(fx.A, draft({ eventId: String(fx.eventB._id) }), { connection: CONNECTION })), '403:ACCESS_DENIED');
    const t = await svc.createTemplateDraft(fx.A, draft({ eventId: String(fx.eventA._id) }), { connection: CONNECTION });
    assert.equal(t.eventId, String(fx.eventA._id));
    assert.equal(
      await code(svc.createTemplateDraft(fx.S, draft({ ownerAdminId: String(fx.adminA._id), eventId: String(fx.eventB._id) }), { connection: CONNECTION })),
      '400:VALIDATION_ERROR'
    );
  });

  test('list filters: search, category, language, event and state', async () => {
    await svc.createTemplateDraft(fx.A, draft({ displayName: 'Haldi reminder', name: 'haldi_reminder', category: 'UTILITY', eventId: String(fx.eventA._id) }), { connection: CONNECTION });
    await svc.createTemplateDraft(fx.A, draft({ displayName: 'Invitation', language: 'hi' }), { connection: CONNECTION });
    const names = async (filters: any) => (await svc.listTemplates(fx.A, filters)).data.map((t: any) => t.displayName);
    assert.deepEqual(await names({ q: 'haldi' }), ['Haldi reminder']);
    assert.deepEqual(await names({ category: 'utility' }), ['Haldi reminder']);
    assert.deepEqual(await names({ language: 'hi' }), ['Invitation']);
    assert.deepEqual(await names({ eventId: String(fx.eventA._id) }), ['Haldi reminder']);
    assert.equal((await names({ state: 'Draft' })).length, 2);
    assert.deepEqual(await names({ q: '.*' }), [], 'search text is not a regular expression');
  });
});

describe('lists, views and deletion', () => {
  test('lists are paginated, newest first, with no overlap between pages', async () => {
    for (let i = 0; i < 5; i++) await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const first = await svc.listTemplates(fx.A, { page: '1', limit: '2' });
    const second = await svc.listTemplates(fx.A, { page: '2', limit: '2' });
    const third = await svc.listTemplates(fx.A, { page: '3', limit: '2' });
    assert.deepEqual(first.pagination, { total: 5, page: 1, limit: 2, totalPages: 3 });
    const all = [...first.data, ...second.data, ...third.data].map((t: any) => t.id);
    assert.equal(new Set(all).size, 5);
    assert.equal((await svc.listTemplates(fx.A, { limit: '1000' })).pagination.limit, 100, 'capped');
    assert.equal((await svc.listTemplates(fx.A, { page: '-3', limit: 'abc' })).pagination.page, 1, 'nonsense falls back');
  });

  test('the WhatsApp Business Account id is shown to a Super Admin only', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    assert.equal('wabaId' in t, false);
    assert.equal('wabaId' in (await svc.getTemplate(fx.A, t.id)), false);
    assert.equal((await svc.listTemplates(fx.A)).data.some((v: any) => 'wabaId' in v), false);
    assert.equal((await svc.getTemplate(fx.S, t.id)).wabaId, WABA);
  });

  test('a draft never sent to Meta can be deleted, locally only', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const { deps, calls } = metaMock();
    await svc.deleteTemplateDraft(fx.A, t.id);
    assert.equal(await WhatsAppTemplate.countDocuments({ _id: t.id }), 0);
    assert.equal(calls.post.length + calls.get.length, 0, 'nothing is deleted at Meta');
    assert.equal(await AuditLog.countDocuments({ action: 'WHATSAPP_TEMPLATE_DELETED' }), 1);
    void deps;
  });

  test('anything that reached Meta, or might have, cannot be deleted', async () => {
    const submitted = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    await svc.submitTemplate(fx.A, submitted.id, metaMock().deps);
    const failed = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    await svc.submitTemplate(fx.A, failed.id, metaMock({ post: () => { throw { response: { status: 400, data: { error: { code: 100, message: 'bad' } } } }; } }).deps);
    for (const t of [submitted, failed]) {
      assert.equal(await code(svc.deleteTemplateDraft(fx.A, t.id)), '409:TEMPLATE_LOCKED');
      assert.equal(await WhatsAppTemplate.countDocuments({ _id: t.id }), 1);
    }
  });

  test('deletion follows the same permissions', async () => {
    const ofA = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const shared = await svc.createTemplateDraft(fx.S, draft(), { connection: CONNECTION });
    assert.equal(await code(svc.deleteTemplateDraft(fx.B, ofA.id)), '404:TEMPLATE_NOT_FOUND');
    assert.equal(await code(svc.deleteTemplateDraft(fx.C, ofA.id)), '403:ACCESS_DENIED');
    assert.equal(await code(svc.deleteTemplateDraft(fx.A, shared.id)), '403:ACCESS_DENIED');
    await svc.deleteTemplateDraft(fx.S, ofA.id);
  });

  test('category changes cannot be requested by anyone; Meta always gets false', async () => {
    for (const who of [fx.S, fx.A]) {
      const error = await svc.createTemplateDraft(who, draft({ allowCategoryChange: true }), { connection: CONNECTION }).catch((e: any) => e);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.ok(error.errors.some((e: any) => e.field === 'allowCategoryChange'));
    }
    const t = await svc.createTemplateDraft(fx.A, draft({ allowCategoryChange: false }), { connection: CONNECTION });
    assert.equal(await code(svc.updateTemplateDraft(fx.A, t.id, { allowCategoryChange: true })), '400:VALIDATION_ERROR');
    // Even a stored true (written outside the API) is never sent.
    await WhatsAppTemplate.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.id) }, { $set: { allowCategoryChange: true } });
    const { deps, calls } = metaMock();
    await svc.submitTemplate(fx.A, t.id, deps);
    assert.equal(calls.post[0].body.allow_category_change, false);
  });
});

describe('drafts', () => {
  test('an invalid definition is refused with every problem, and nothing is stored', async () => {
    const error = await svc.createTemplateDraft(fx.A, draft({ name: 'Bad Name', body: 'Hi {{2}}' }), { connection: CONNECTION }).catch((e: any) => e);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.ok(error.errors.some((e: any) => e.field === 'name'));
    assert.ok(error.errors.some((e: any) => e.field === 'body'));
    assert.equal(await WhatsAppTemplate.countDocuments({}), 0);
  });

  test('one name per language per account: a duplicate is refused, another language is not', async () => {
    await svc.createTemplateDraft(fx.A, draft({ name: 'event_invite' }), { connection: CONNECTION });
    assert.equal(await code(svc.createTemplateDraft(fx.B, draft({ name: 'event_invite' }), { connection: CONNECTION })), '409:TEMPLATE_NAME_TAKEN');
    await svc.createTemplateDraft(fx.A, draft({ name: 'event_invite', language: 'hi' }), { connection: CONNECTION });
  });

  test('without a WhatsApp Business Account configured, nothing can be created', async () => {
    assert.equal(await code(svc.createTemplateDraft(fx.A, draft(), { connection: { ...CONNECTION, wabaId: undefined } })), '503:CONFIGURATION_ERROR');
  });

  test('a draft can be edited; a submitted template cannot', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const edited = await svc.updateTemplateDraft(fx.A, t.id, { displayName: 'Invitation v2', footer: 'With love' });
    assert.equal(edited.displayName, 'Invitation v2');
    assert.equal(edited.footer, 'With love');
    assert.equal(edited.body, t.body, 'untouched fields are kept');
    assert.equal(await code(svc.updateTemplateDraft(fx.A, t.id, { body: 'Hi {{3}}' })), '400:VALIDATION_ERROR');

    await svc.submitTemplate(fx.A, t.id, metaMock().deps);
    assert.equal(await code(svc.updateTemplateDraft(fx.A, t.id, { displayName: 'Changed after submit' })), '409:TEMPLATE_LOCKED');
  });
});

describe('submission to Meta (mocked)', () => {
  test('success: the WABA receives the definition; Meta id and status are stored; not approved', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ headerText: 'You are invited' }), { connection: CONNECTION });
    const { deps, calls } = metaMock();
    const result = await svc.submitTemplate(fx.A, t.id, deps);

    assert.equal(result.outcome, 'submitted');
    assert.equal(calls.post.length, 1);
    assert.equal(calls.post[0].url, `https://graph.facebook.com/v22.0/${WABA}/message_templates`);
    assert.deepEqual(calls.post[0].body.components[1].example, { body_text: [['Riya']] });
    assert.equal(result.template.localState, 'Pending');
    assert.equal(result.template.metaStatus, 'PENDING');
    assert.equal(result.template.metaTemplateId, '9001');
    assert.match(result.message, /Approval is decided by Meta/);
    assert.deepEqual(result.template.history.map((h: any) => h.type), ['created', 'submitting', 'submitted']);
    assert.equal(await AuditLog.countDocuments({ action: 'WHATSAPP_TEMPLATE_SUBMITTED' }), 1);
  });

  test('Approved only when Meta itself says APPROVED', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const { deps } = metaMock({ post: () => ({ data: { id: '777', status: 'APPROVED', category: 'UTILITY' } }) });
    const result = await svc.submitTemplate(fx.A, t.id, deps);
    assert.equal(result.template.localState, 'Approved');
    assert.equal(result.template.metaCategory, 'UTILITY', "Meta's category is kept beside the one requested");
  });

  test('a stored definition that is no longer valid is never sent', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    await WhatsAppTemplate.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.id) }, { $set: { body: 'Hi {{2}}' } });
    const { deps, calls } = metaMock();
    assert.equal(await code(svc.submitTemplate(fx.A, t.id, deps)), '400:VALIDATION_ERROR');
    assert.equal(calls.post.length, 0);
    assert.equal((await svc.getTemplate(fx.A, t.id)).localState, 'Draft');
  });

  test("Meta's rejection: SubmissionFailed with its reason, scrubbed; fix and submit again", async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const reject = metaMock({ post: () => { throw { response: { status: 400, data: { error: { code: 100, message: `Invalid parameter (token ${FAKE_TOKEN})`, error_data: { details: 'Body contains too many variables' } } } } }; } });
    const first = await svc.submitTemplate(fx.A, t.id, reject.deps);
    assert.equal(first.outcome, 'rejected');
    assert.equal(first.template.localState, 'SubmissionFailed');
    assert.match(first.template.rejectionReason, /too many variables/);
    assert.equal(first.template.rejectionReason.includes(FAKE_TOKEN), false);

    await svc.updateTemplateDraft(fx.A, t.id, { body: 'Dear {{1}}, you are invited.' });
    const ok = metaMock();
    const second = await svc.submitTemplate(fx.A, t.id, ok.deps);
    assert.equal(second.template.localState, 'Pending');
    assert.equal(second.template.submissionAttempts, 2);
    assert.equal(second.template.rejectionReason, null);
  });

  test('a credential failure is reported as such and can be retried', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const { deps } = metaMock({ post: () => { throw { response: { status: 401, data: { error: { code: 190, message: 'Error validating access token' } } } }; } });
    const result = await svc.submitTemplate(fx.A, t.id, deps);
    assert.equal(result.template.localState, 'SubmissionFailed');
    assert.match(result.template.rejectionReason, /credentials/);
  });

  test('two submissions at once: Meta is called exactly once', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const { deps, calls } = metaMock({ delayMs: 150 });
    const outcomes = await Promise.allSettled([svc.submitTemplate(fx.A, t.id, deps), svc.submitTemplate(fx.A, t.id, deps), svc.submitTemplate(fx.S, t.id, deps)]);
    assert.equal(calls.post.length, 1);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    for (const o of outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[]) {
      assert.match(o.reason.code, /SUBMISSION_IN_PROGRESS|ALREADY_SUBMITTED/);
    }
    assert.equal(await code(svc.submitTemplate(fx.A, t.id, deps)), '409:ALREADY_SUBMITTED', 'and never again once accepted');
    assert.equal(calls.post.length, 1);
  });

  test('timeout, then Meta has it: adopted with its id - not created twice', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ name: 'timeout_found' }), { connection: CONNECTION });
    const { deps, calls } = metaMock({
      post: timeout,
      get: () => ({ data: { data: [{ id: '5551', name: 'timeout_found', language: 'en', status: 'PENDING', category: 'MARKETING' }] } }),
    });
    const result = await svc.submitTemplate(fx.A, t.id, deps);
    assert.equal(result.outcome, 'reconciled');
    assert.equal(result.template.localState, 'Pending');
    assert.equal(result.template.metaTemplateId, '5551');
    assert.equal(calls.post.length, 1, 'no resubmission');
    assert.deepEqual(result.template.history.map((h: any) => h.type), ['created', 'submitting', 'uncertain', 'reconciled_found']);
  });

  test('timeout, then Meta does not have it: safe to submit again', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ name: 'timeout_absent' }), { connection: CONNECTION });
    const first = await svc.submitTemplate(fx.A, t.id, metaMock({ post: timeout, get: () => ({ data: { data: [] } }) }).deps);
    assert.equal(first.template.localState, 'SubmissionFailed');
    assert.match(first.template.rejectionReason, /was not created/);

    const retry = metaMock();
    const second = await svc.submitTemplate(fx.A, t.id, retry.deps);
    assert.equal(second.template.localState, 'Pending');
    assert.equal(retry.calls.post.length, 1);
  });

  test('a match in another language is not this template', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ name: 'lang_check' }), { connection: CONNECTION });
    const result = await svc.submitTemplate(fx.A, t.id, metaMock({
      post: timeout,
      get: () => ({ data: { data: [{ id: '1', name: 'lang_check', language: 'hi', status: 'APPROVED', category: 'MARKETING' }] } }),
    }).deps);
    assert.equal(result.template.localState, 'SubmissionFailed');
    assert.equal(result.template.metaTemplateId, null);
  });

  test('timeout and the lookup fails too: Unknown, blocked from resubmitting until checked', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ name: 'double_failure' }), { connection: CONNECTION });
    const down = metaMock({ post: timeout, get: () => { throw { code: 'ETIMEDOUT' }; } });
    const result = await svc.submitTemplate(fx.A, t.id, down.deps);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.template.localState, 'Unknown');

    assert.equal(await code(svc.submitTemplate(fx.A, t.id, down.deps)), '409:RECONCILE_REQUIRED');
    assert.equal(down.calls.post.length, 1, 'never resubmitted blindly');
    assert.equal(await code(svc.reconcileTemplate(fx.A, t.id, down.deps)), '502:META_UNAVAILABLE');
    assert.equal((await svc.getTemplate(fx.A, t.id)).localState, 'Unknown');

    const up = metaMock({ get: () => ({ data: { data: [{ id: '8080', name: 'double_failure', language: 'en', status: 'REJECTED', category: 'MARKETING' }] } }) });
    const settled = await svc.reconcileTemplate(fx.A, t.id, up.deps);
    assert.equal(settled.template.localState, 'Rejected');
    assert.equal(settled.template.metaTemplateId, '8080');
    assert.equal(up.calls.post.length, 0);
  });

  test('a Submitting claim left by a stopped process is reconciled only once it is stale', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ name: 'stale_claim' }), { connection: CONNECTION });
    const startedAt = new Date('2026-10-12T10:00:00Z');
    await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: 'Submitting', 'submission.attemptId': 'lost', 'submission.startedAt': startedAt } });
    const { deps } = metaMock();

    const soon = { ...deps, now: () => new Date(startedAt.getTime() + 30_000) };
    assert.equal(await code(svc.reconcileTemplate(fx.A, t.id, soon)), '409:SUBMISSION_IN_PROGRESS');
    assert.equal(await code(svc.submitTemplate(fx.A, t.id, soon)), '409:SUBMISSION_IN_PROGRESS');

    const later = { ...deps, now: () => new Date(startedAt.getTime() + svc.SUBMISSION_LEASE_MS + 1) };
    const result = await svc.reconcileTemplate(fx.A, t.id, later);
    assert.equal(result.template.localState, 'SubmissionFailed', 'Meta never received it');
  });

  test('a failed template that turns up at Meta later is adopted, not stuck', async () => {
    // The timed-out request completed at Meta after the first lookup found nothing.
    const t = await svc.createTemplateDraft(fx.A, draft({ name: 'late_arrival' }), { connection: CONNECTION });
    await svc.submitTemplate(fx.A, t.id, metaMock({ post: timeout, get: () => ({ data: { data: [] } }) }).deps);
    assert.equal((await svc.getTemplate(fx.A, t.id)).localState, 'SubmissionFailed');

    const still = await svc.reconcileTemplate(fx.A, t.id, metaMock().deps);
    assert.equal(still.template.localState, 'SubmissionFailed', 'still absent: unchanged');
    assert.ok(still.template.lastSyncedAt, 'with the time it was checked');

    const later = metaMock({ get: () => ({ data: { data: [{ id: '4242', name: 'late_arrival', language: 'en', status: 'PENDING', category: 'MARKETING' }] } }) });
    const adopted = await svc.reconcileTemplate(fx.A, t.id, later.deps);
    assert.equal(adopted.template.localState, 'Pending');
    assert.equal(adopted.template.metaTemplateId, '4242');
    assert.equal(adopted.template.rejectionReason, null);
    assert.equal(later.calls.post.length, 0);
  });

  test('a slow reconcile never overwrites a submission that started meanwhile', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ name: 'race_check' }), { connection: CONNECTION });
    await svc.submitTemplate(fx.A, t.id, metaMock({ post: timeout, get: () => ({ data: { data: [] } }) }).deps);

    const slowLookup = metaMock({ get: async () => { await new Promise((r) => setTimeout(r, 150)); return { data: { data: [] } }; } });
    const submit = metaMock({ delayMs: 300 });
    const [reconciled, submitted] = await Promise.all([
      svc.reconcileTemplate(fx.A, t.id, slowLookup.deps),
      new Promise((r) => setTimeout(r, 30)).then(() => svc.submitTemplate(fx.A, t.id, submit.deps)),
    ]);
    assert.equal((submitted as any).outcome, 'submitted');
    assert.equal(submit.calls.post.length, 1);
    const final = await svc.getTemplate(fx.A, t.id);
    assert.equal(final.localState, 'Pending', "the submission's result stands");
    assert.equal(final.metaTemplateId, '9001');
    assert.equal((reconciled as any).outcome, 'superseded', 'the reconcile saw the new submission and wrote nothing');
    assert.equal(final.history.filter((h: any) => h.type === 'reconciled_absent').length, 1, 'only the first, real check is recorded');
  });

  test('nothing to reconcile for a template with a clear state', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    assert.equal(await code(svc.reconcileTemplate(fx.A, t.id, metaMock().deps)), '409:NOTHING_TO_RECONCILE');
  });

  test("Meta's 100-per-hour limit is respected before calling Meta", async () => {
    const now = new Date();
    await WhatsAppTemplate.collection.insertMany(Array.from({ length: svc.SUBMISSIONS_PER_HOUR }, (_, i) => ({
      wabaId: WABA, name: `recent_${i}`, language: 'en', category: 'UTILITY', displayName: 'x', body: 'x',
      createdBy: fx.adminA._id, ownerAdminId: fx.adminA._id, localState: 'Pending', variables: [], history: [],
      submission: { attemptId: null, startedAt: new Date(now.getTime() - 10 * 60 * 1000), attempts: 1 },
    })));
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const { deps, calls } = metaMock();
    assert.equal(await code(svc.submitTemplate(fx.A, t.id, deps)), '429:RATE_LIMITED');
    assert.equal(calls.post.length, 0);
    assert.equal((await svc.getTemplate(fx.A, t.id)).localState, 'Draft');
  });

  test('a template from another WhatsApp Business Account is not submitted to this one', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const other = { ...CONNECTION, wabaId: '999999999999999' };
    let called = false;
    const deps = { connection: other, meta: { connection: other, post: async () => { called = true; return { data: { id: '1' } }; } } };
    assert.equal(await code(svc.submitTemplate(fx.A, t.id, deps)), '409:ACCOUNT_MISMATCH');
    assert.equal(called, false);
  });

  test('no token anywhere in stored templates or audit entries', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    await svc.submitTemplate(fx.A, t.id, metaMock({ post: () => { throw { response: { status: 400, data: { error: { code: 100, message: `bad ${FAKE_TOKEN}` } } } }; } }).deps);
    const stored = JSON.stringify([await WhatsAppTemplate.find({}).lean(), await AuditLog.find({}).lean()]);
    assert.equal(stored.includes(FAKE_TOKEN), false);
  });
});
