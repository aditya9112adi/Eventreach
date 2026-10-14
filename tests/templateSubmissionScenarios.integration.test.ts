import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Template submission to Meta - the scenarios the existing suites
 * (whatsappTemplateService, whatsappTemplateRoutes, templateRefresh) do not
 * already cover, against the REAL compiled backend (backend/dist) on a
 * throwaway local MongoDB database:
 *
 *  - Meta's rate limit (80008, HTTP 429) and a Meta server error at submit;
 *  - a repeated submit after success never reaches Meta again;
 *  - submitting only ever talks to the template endpoint - never /messages;
 *  - a stored template - Pending, Rejected, even Approved - is not something
 *    the Composer can send; only its fixed allowlist can be, and the approved
 *    wedding template is unchanged (no guest name).
 *
 * Meta is always mocked: injected at the template adapter, and faked on the
 * shared axios instance for the Composer. A tripwire fails the suite if any
 * call reaches the real HTTP path. The token is fake.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_tplsubmit_${Date.now()}`;
const FAKE_TOKEN = 'EAAG-FAKE-SUBMISSION-TOKEN-never-real-0c41';
const WABA = '102290129340398';
const ENV_PHONE = '1407379562449786';
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = FAKE_TOKEN;
process.env.WHATSAPP_PHONE_ID = ENV_PHONE;
process.env.WHATSAPP_WABA_ID = WABA;
process.env.WHATSAPP_API_VERSION = 'v22.0';

// ── the shared axios instance: tripwire + the Composer's fake Meta ──────────
const axios = createRequire(require.resolve('../backend/dist/services/metaTemplateApi'))('axios');
const real = { post: axios.post, get: axios.get, request: axios.request };
const wire = { messages: [] as string[], unexpected: [] as string[] };
axios.post = async (url: string, body: any) => {
  const u = new URL(url);
  if (u.hostname === 'graph.facebook.com' && u.pathname.endsWith('/messages')) {
    wire.messages.push(String(body?.template?.name));
    return { data: { messages: [{ id: `wamid.SUB${wire.messages.length}` }], contacts: [{ wa_id: String(body?.to).replace('+', '') }] } };
  }
  wire.unexpected.push(`POST ${u.hostname}${u.pathname}`);
  throw new Error('tripwire: un-mocked POST');
};
axios.get = async (url: string) => {
  const u = new URL(url);
  if (u.hostname === 'graph.facebook.com' && u.pathname.endsWith('/message_templates')) return { data: { data: [] } };
  wire.unexpected.push(`GET ${u.hostname}${u.pathname}`);
  throw new Error('tripwire: un-mocked GET');
};
axios.request = async (config: any) => {
  wire.unexpected.push(`REQUEST ${config?.url}`);
  throw new Error('tripwire: un-mocked request');
};

const CONNECTION = { accessToken: FAKE_TOKEN, wabaId: WABA, phoneNumberId: ENV_PHONE, apiVersion: 'v22.0' };

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const svc = require('../backend/dist/services/templateService');
const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const whatsappController = require('../backend/dist/controllers/whatsappController');
const { EVENT_TEMPLATES } = require('../backend/dist/services/eventTemplateMessage');
const { WhatsAppTemplate } = require('../backend/dist/models/WhatsAppTemplate');
const { Admin } = require('../backend/dist/models/Admin');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');

const fx: any = {};
let server: any;
let baseUrl = '';
let ip = 0;

const actor = (account: any, role: string) => ({ id: String(account._id), email: account.email, role });

let nameSeq = 0;
const draft = (overrides: Record<string, any> = {}) => ({
  displayName: 'Reminder',
  name: `scenario_${++nameSeq}`,
  language: 'en',
  category: 'UTILITY',
  body: 'Hello {{1}}, your event is coming up.',
  variables: [{ position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' }],
  ...overrides,
});

/** Meta injected at the template adapter: records every call, answers as told. */
const metaMock = (opts: { post?: (n: number) => any; get?: () => any } = {}) => {
  const calls = { post: [] as { url: string; body: any }[], get: [] as any[] };
  return {
    calls,
    deps: {
      connection: CONNECTION,
      meta: {
        connection: CONNECTION,
        post: async (url: string, body: any) => {
          calls.post.push({ url, body });
          return opts.post ? opts.post(calls.post.length) : { data: { id: `${7000 + calls.post.length}`, status: 'PENDING', category: 'UTILITY' } };
        },
        get: async (url: string, options: any) => {
          calls.get.push({ url, params: options?.params });
          return opts.get ? opts.get() : { data: { data: [] } };
        },
      },
    },
  };
};

const code = async (promise: Promise<any>) => {
  try { await promise; return 'resolved'; } catch (e: any) { return `${e.httpStatus}:${e.code}`; }
};

const call = (method: string, p: string, token: string, body?: any): Promise<{ status: number; body: any; raw: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}`, Authorization: `Bearer ${token}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(baseUrl + p);
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

before(async () => {
  await mongoose.connect(TEST_DB);
  await WhatsAppTemplate.init();
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-ts@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminA = await Admin.create({ name: 'Admin A', email: 'a-ts@example.com', passwordHash: 'x', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: true });
  fx.A = actor(fx.adminA, 'Admin');
  fx.tokenA = jwt.sign({ id: fx.adminA._id, email: fx.adminA.email, role: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });
  fx.event = await Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName: 'A Wedding', eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', adminId: fx.adminA._id, createdBy: fx.adminA._id,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', whatsappRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(axios, real);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(wire.unexpected, [], 'no call reached the real HTTP path');
});

beforeEach(async () => {
  await WhatsAppTemplate.deleteMany({});
  whatsappController.clearRecentEventTemplateSends();
  wire.messages.length = 0;
});

describe("Meta's answers at submission that the other suites do not cover", () => {
  for (const [label, failure] of [
    ['WABA rate limit (80008)', () => { throw { response: { status: 400, data: { error: { code: 80008, message: 'Too many calls' } } } }; }],
    ['HTTP 429', () => { throw { response: { status: 429, data: {} } }; }],
  ] as const) {
    test(`${label}: nothing was created - SubmissionFailed, retryable, Meta asked once`, async () => {
      const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
      const limited = metaMock({ post: failure });
      const result = await svc.submitTemplate(fx.A, t.id, limited.deps);
      assert.equal(result.outcome, 'rejected');
      assert.equal(result.template.localState, 'SubmissionFailed');
      assert.match(result.template.rejectionReason, /rate limit/i);
      assert.equal(result.template.metaTemplateId, null);
      assert.equal(limited.calls.post.length, 1);

      const retry = await svc.submitTemplate(fx.A, t.id, metaMock().deps);
      assert.equal(retry.template.localState, 'Pending', 'a later retry goes through, and is Pending - not approved');
    });
  }

  test('a Meta server error is treated as "may have been created": checked, never blindly resubmitted', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const failing = metaMock({ post: () => { throw { response: { status: 500, data: { error: { code: 2, message: 'Service temporarily unavailable' } } } }; } });
    const result = await svc.submitTemplate(fx.A, t.id, failing.deps);
    assert.equal(failing.calls.post.length, 1, 'never resubmitted automatically');
    assert.equal(failing.calls.get.length, 1, 'Meta is asked whether it has the template');
    assert.equal(result.template.localState, 'SubmissionFailed', 'Meta has no record, so it was not created');
    assert.match(result.template.rejectionReason, /no record/);
  });

  test('a repeated submit after success is refused without reaching Meta', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const meta = metaMock();
    assert.equal((await svc.submitTemplate(fx.A, t.id, meta.deps)).template.localState, 'Pending');
    assert.equal(await code(svc.submitTemplate(fx.A, t.id, meta.deps)), '409:ALREADY_SUBMITTED');
    assert.equal(meta.calls.post.length, 1);
  });

  test('submitting talks only to the template endpoint: no message, no recipient', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
    const meta = metaMock();
    await svc.submitTemplate(fx.A, t.id, meta.deps);
    assert.equal(meta.calls.post.length, 1);
    assert.equal(meta.calls.post[0].url, `https://graph.facebook.com/v22.0/${WABA}/message_templates`);
    assert.equal('to' in meta.calls.post[0].body, false);
    assert.equal('messaging_product' in meta.calls.post[0].body, false);
    assert.deepEqual(wire.messages, [], 'nothing was sent to anyone');
  });
});

describe('unsupported structures are refused by name, never silently dropped', () => {
  const refusal = async (overrides: Record<string, any>) => {
    const error = await svc.createTemplateDraft(fx.A, draft(overrides), { connection: CONNECTION }).catch((e: any) => e);
    assert.equal(error.code, 'VALIDATION_ERROR', JSON.stringify(overrides));
    assert.equal(error.httpStatus, 400);
    return error.errors as { field: string; message: string }[];
  };

  for (const [field, value, pattern] of [
    ['headerFormat', 'IMAGE', /Image, video and document headers are not supported/],
    ['headerMedia', { id: 'x' }, /not supported/],
    ['components', [{ type: 'BODY', text: 'Hi' }], /raw components are not accepted/],
    ['parameter_format', 'NAMED', /Named placeholders are not supported/],
  ] as const) {
    test(`${field} is refused with a clear reason, and nothing is stored or sent`, async () => {
      const errors = await refusal({ [field]: value });
      const entry = errors.find((e) => e.field === field);
      assert.ok(entry, `an error names ${field}`);
      assert.match(entry!.message, pattern);
      assert.equal(await WhatsAppTemplate.countDocuments({}), 0);
    });
  }

  test('named placeholders in the body and Authentication templates are refused, as before', async () => {
    assert.ok((await refusal({ body: 'Dear {{guest_name}}', variables: [] })).some((e) => /Named placeholders are not supported/.test(e.message)));
    assert.ok((await refusal({ category: 'AUTHENTICATION' })).some((e) => e.field === 'category' && /cannot be created here/.test(e.message)));
  });

  test('a supported template is unaffected: text header, numbered body, footer', async () => {
    const t = await svc.createTemplateDraft(fx.A, draft({ headerText: 'Reminder', footer: 'EventReach' }), { connection: CONNECTION });
    assert.equal(t.localState, 'Draft');
  });
});

describe('stored templates are not sendable from the Composer', () => {
  test('Pending, Rejected and even Approved stored templates are refused by name; nothing is sent', async () => {
    const guest = await Contact.create({ fullName: 'Riya', phoneNumber: '+919711100001', countryCode: '+91', eventId: fx.event._id, status: 'Valid' });
    for (const state of ['Pending', 'Rejected', 'Approved']) {
      const t = await svc.createTemplateDraft(fx.A, draft(), { connection: CONNECTION });
      await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: state, metaStatus: state.toUpperCase(), metaTemplateId: `81${nameSeq}` } });
      const res = await call('POST', '/api/whatsapp/event-template', fx.tokenA, { eventId: String(fx.event._id), contactIds: [String(guest._id)], templateName: t.name });
      assert.equal(res.status, 400, `${state}: ${res.raw}`);
      assert.equal(res.body.error.code, 'UNKNOWN_TEMPLATE');
    }
    assert.deepEqual(wire.messages, []);
  });

  test('the approved wedding template is still sent as approved: no values filled in', () => {
    assert.deepEqual(EVENT_TEMPLATES.pranjali_ankit_wedding_invite, { languageCode: 'en', fields: [] });
  });
});
