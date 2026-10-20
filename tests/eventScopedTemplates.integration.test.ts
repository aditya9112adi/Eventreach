import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Event-specific WhatsApp templates, end to end against the REAL compiled backend
 * (backend/dist - run `npm run build` in backend/ first) on a throwaway database.
 *
 *   Templates tab   POST/PATCH /api/whatsapp/templates     the template is tied to an event by its
 *                                                          business Event ID, resolved from the database
 *   Message tab     GET  /api/whatsapp/event-templates     only this event's approved templates
 *                   GET  /api/whatsapp/event-template-preview
 *                   POST /api/whatsapp/event-template      re-checks event, association and approval
 *
 * Meta is never reached: sends go through an injected sender, and the Meta status
 * synchronisation runs on injected adapters. No real WhatsApp message is sent.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_scoped_tpl_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
const WABA = '102290129340398';
process.env.WHATSAPP_WABA_ID = WABA;
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_ID;

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const { requireAuth } = require('../backend/dist/middleware/authMiddleware');
const controller = require('../backend/dist/controllers/whatsappController');
const svc = require('../backend/dist/services/templateService');
const links = require('../backend/dist/services/templateEventLinks');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { EventMember } = require('../backend/dist/models/EventMember');
const { Contact } = require('../backend/dist/models/Contact');
const { WhatsAppTemplate } = require('../backend/dist/models/WhatsAppTemplate');
const { AuditLog } = require('../backend/dist/models/AuditLog');

const FAKE_TOKEN = 'EAAG-FAKE-SENTINEL-TOKEN-never-real-7f3a9c';
const CONNECTION = { accessToken: FAKE_TOKEN, wabaId: WABA, phoneNumberId: '1407379562449786', apiVersion: 'v22.0' };

let realServer: any;
let mockServer: any;
let realUrl = '';
let mockUrl = '';
let sent: any[] = [];
let clock = 1_000_000;
const fx: any = {};
let seq = 0;

const fakeSend = async (input: any) => {
  sent.push(input);
  return { success: true, messageId: `wamid.TEST${sent.length}`, status: 'accepted', recipient: input.to.replace('+', '') };
};

type Res = { status: number; body: any };
const call = async (method: string, url: string, token?: string, body?: unknown): Promise<Res> => {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed };
};

const tokenFor = (account: any, role: string) => jwt.sign({ id: String(account._id), email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });
const actorOf = (account: any, role: string) => ({ id: String(account._id), email: account.email, role });

const mkAdmin = (name: string, role = 'Admin', grant = true) =>
  Admin.create({
    name, email: `${name.toLowerCase().replace(/\W/g, '')}@scoped.example.com`, passwordHash: 'x'.repeat(20), role, status: 'Active',
    accessGrantedOn: new Date(), accessExpiryDate: new Date(Date.now() + 86_400_000),
    ...(grant && role === 'Admin' ? { canManageWhatsAppTemplates: true } : {}),
  });

const mkEvent = (eventName: string, adminId: any, extra: Record<string, any> = {}) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: new Date('2030-06-01T00:00:00.000Z'), eventTime: new Date('2030-06-01T13:30:00.000Z'),
    eventVenue: 'Grand Palace, Pune', eventStatus: 'Upcoming', adminId, createdBy: adminId, ...extra,
  });

let phoneSeq = 0;
const mkGuest = (event: any, fullName: string) =>
  Contact.create({ fullName, phoneNumber: `+9198111${String(10000 + phoneSeq++)}`, countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid' });

const body = (extra: Record<string, any> = {}) => ({
  displayName: 'Wedding invitation',
  name: `scoped_${++seq}`,
  language: 'en',
  category: 'UTILITY',
  body: 'Dear {{1}}, you are invited to {{2}} at {{3}}.',
  variables: [
    { position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' },
    { position: 2, label: 'Event', source: 'event.name', sample: 'Sharma Wedding' },
    { position: 3, label: 'Venue', source: 'event.venue', sample: 'Pune' },
  ],
  ...extra,
});

/** A template of this event that Meta has approved (set the way a Meta confirmation sets it). */
const approved = async (owner: any, event: any, over: Record<string, any> = {}, state: Record<string, any> = {}) => {
  const t = await svc.createTemplateDraft(actorOf(owner, 'Admin'), body({ eventId: event.eventId, ...over }), { connection: CONNECTION });
  await WhatsAppTemplate.updateOne(
    { _id: t.id },
    { $set: { localState: 'Approved', metaStatus: 'APPROVED', metaTemplateId: String(700000 + ++seq), ...state } },
    { overwriteImmutable: true }
  );
  return t;
};

before(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([WhatsAppTemplate.init(), Event.init(), Contact.init(), EventMember.init()]);

  fx.super = await mkAdmin('Super', 'SuperAdmin');
  fx.adminA = await mkAdmin('Admin A');
  fx.adminB = await mkAdmin('Admin B');
  fx.eventA1 = await mkEvent('A One', fx.adminA._id);
  fx.eventA2 = await mkEvent('A Two', fx.adminA._id);
  fx.subA1 = await mkEvent('A One Haldi', fx.adminA._id, { parentEventId: fx.eventA1._id });
  fx.eventB = await mkEvent('B One', fx.adminB._id);
  fx.userA = await User.create({ name: 'Helper A', email: 'helpera@scoped.example.com', passwordHash: 'x'.repeat(20), status: 'Active', adminId: fx.adminA._id, assignedEventId: fx.eventA1._id });
  fx.userB = await User.create({ name: 'Helper B', email: 'helperb@scoped.example.com', passwordHash: 'x'.repeat(20), status: 'Active', adminId: fx.adminB._id, assignedEventId: fx.eventB._id });

  fx.tSuper = tokenFor(fx.super, 'SuperAdmin');
  fx.tA = tokenFor(fx.adminA, 'Admin');
  fx.tB = tokenFor(fx.adminB, 'Admin');
  fx.tUserA = tokenFor(fx.userA, 'User');
  fx.tUserB = tokenFor(fx.userB, 'User');
  fx.S = actorOf(fx.super, 'SuperAdmin');
  fx.A = actorOf(fx.adminA, 'Admin');
  fx.B = actorOf(fx.adminB, 'Admin');

  const realApp = express();
  realApp.use(express.json());
  realApp.use('/api/whatsapp', whatsappRoutes);
  realServer = http.createServer(realApp);
  await new Promise<void>((r) => realServer.listen(0, '127.0.0.1', () => r()));
  realUrl = `http://127.0.0.1:${realServer.address().port}/api/whatsapp`;

  const mockApp = express();
  mockApp.use(express.json());
  mockApp.use(requireAuth);
  mockApp.post('/send', controller.buildEventTemplateHandler(fakeSend, () => clock));
  mockServer = http.createServer(mockApp);
  await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', () => r()));
  mockUrl = `http://127.0.0.1:${mockServer.address().port}/send`;
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => realServer.close(() => r()));
  await new Promise<void>((r) => mockServer.close(() => r()));
});

beforeEach(async () => {
  sent = [];
  clock += 120_000; // clear the per-guest duplicate window between tests
  process.env.WHATSAPP_WABA_ID = WABA;
  await WhatsAppTemplate.deleteMany({});
  await AuditLog.deleteMany({});
});

const create = (token: string, extra: Record<string, any>) => call('POST', `${realUrl}/templates`, token, body(extra));
const send = (token: string, payload: Record<string, any>) => call('POST', mockUrl, token, payload);
const listFor = (token: string, event: any) => call('GET', `${realUrl}/event-templates?eventId=${event._id}`, token);

describe('Create Template: the Event ID', () => {
  test('a valid business Event ID saves both the event\'s ObjectId and its Event ID, and keeps the template\'s own fields', async () => {
    const res = await create(fx.tA, { eventId: fx.eventA1.eventId, displayName: 'Keep me', category: 'MARKETING', language: 'hi' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const stored = await WhatsAppTemplate.findById(res.body.template.id).lean();
    assert.equal(String(stored.eventObjectId), String(fx.eventA1._id));
    assert.equal(stored.eventId, fx.eventA1.eventId);
    assert.match(stored.eventId, /^EVT-\d{6,}$/);
    // The template's own identity and Meta fields are as they always were.
    assert.ok(stored._id && String(stored._id) === res.body.template.id);
    assert.equal(stored.name, res.body.template.name);
    assert.equal(stored.language, 'hi');
    assert.equal(stored.category, 'MARKETING');
    assert.equal(stored.localState, 'Draft');
    assert.equal(stored.metaTemplateId, null);
    assert.equal(stored.wabaId, WABA);
    // ...and the API returns both.
    assert.equal(res.body.template.eventId, fx.eventA1.eventId);
    assert.equal(res.body.template.eventObjectId, String(fx.eventA1._id));
  });

  test('leading and trailing whitespace is trimmed before the lookup', async () => {
    for (const typed of [`  ${fx.eventA1.eventId}`, `${fx.eventA1.eventId}  `, `\t ${fx.eventA1.eventId} \n`]) {
      const res = await create(fx.tA, { eventId: typed });
      assert.equal(res.status, 201, `${JSON.stringify(typed)} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.template.eventId, fx.eventA1.eventId);
    }
  });

  test('a missing or blank Event ID is refused, and nothing is created', async () => {
    for (const eventId of [undefined, '', '   ', null]) {
      const res = await create(fx.tA, { eventId });
      assert.equal(res.status, 400, JSON.stringify(eventId));
      assert.ok(res.body.error.errors.some((e: any) => e.field === 'eventId' && /required/i.test(e.message)));
    }
    assert.equal(await WhatsAppTemplate.countDocuments(), 0);
  });

  test('malformed Event IDs are refused with a message naming the format, and nothing is created', async () => {
    const malformed = [
      'evt-0000017', 'EVT0000017', 'EVT-17', 'EVT-12345', 'EVT-00000A7', 'EVT-0000017x', 'XEVT-0000017', 'EVT- 0000017',
      String(fx.eventA1._id), '<script>alert(1)</script>', '{"$ne":null}', 'EVT-0000017\nEVT-0000018', 17, true,
      { $ne: null }, ['EVT-0000017'],
    ];
    for (const eventId of malformed) {
      const res = await create(fx.tA, { eventId });
      assert.equal(res.status, 400, JSON.stringify(eventId));
      const problem = res.body.error.errors.find((e: any) => e.field === 'eventId');
      assert.ok(problem, JSON.stringify(eventId));
      assert.match(problem.message, /EVT-|required/);
    }
    assert.equal(await WhatsAppTemplate.countDocuments(), 0);
  });

  test('an ID that matches the format but does not exist is refused', async () => {
    const res = await create(fx.tA, { eventId: 'EVT-9999999' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.errors.some((e: any) => e.field === 'eventId' && /No event with that Event ID/.test(e.message)));
    assert.equal(await WhatsAppTemplate.countDocuments(), 0);
  });

  test("another Admin's event is refused with the same words as a missing one, so its existence is not revealed", async () => {
    const missing = await create(fx.tA, { eventId: 'EVT-9999999' });
    const foreign = await create(fx.tA, { eventId: fx.eventB.eventId });
    assert.equal(foreign.status, 400);
    assert.deepEqual(foreign.body.error.errors, missing.body.error.errors);
    assert.equal(await WhatsAppTemplate.countDocuments(), 0);
  });

  test("a User (not a template manager) cannot create at all, whatever event they name", async () => {
    const res = await create(fx.tUserA, { eventId: fx.eventA1.eventId });
    assert.equal(res.status, 403);
    assert.equal(await WhatsAppTemplate.countDocuments(), 0);
  });

  test('a client-supplied eventObjectId (or an ObjectId in eventId) is never trusted: the database-resolved event wins', async () => {
    const res = await create(fx.tA, { eventId: fx.eventA1.eventId, eventObjectId: String(fx.eventB._id) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const stored = await WhatsAppTemplate.findById(res.body.template.id).lean();
    assert.equal(String(stored.eventObjectId), String(fx.eventA1._id), "not the foreign event's id");
    assert.equal(stored.eventId, fx.eventA1.eventId);
    // Naming an event only by its ObjectId is not a business Event ID.
    const byObjectId = await create(fx.tA, { eventId: String(fx.eventA1._id) });
    assert.equal(byObjectId.status, 400);
  });

  test('a sub-event is an event with its own Event ID, and may have templates of its own', async () => {
    const res = await create(fx.tA, { eventId: fx.subA1.eventId });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.template.eventObjectId, String(fx.subA1._id));
  });

  test('a Super Admin may use any event for a shared template; with an owner chosen, the event must be that owner\'s', async () => {
    assert.equal((await create(fx.tSuper, { eventId: fx.eventB.eventId })).status, 201);
    assert.equal((await create(fx.tSuper, { eventId: fx.eventB.eventId, ownerAdminId: String(fx.adminA._id) })).status, 400);
    assert.equal((await create(fx.tSuper, { eventId: fx.eventA1.eventId, ownerAdminId: String(fx.adminA._id) })).status, 201);
  });
});

describe('editing a draft keeps or changes the event only through the same lookup', () => {
  test('leaving the Event ID out keeps both stored ids; changing it re-resolves; a bad one changes nothing', async () => {
    const t = (await create(fx.tA, { eventId: fx.eventA1.eventId })).body.template;
    const kept = await call('PATCH', `${realUrl}/templates/${t.id}`, fx.tA, { displayName: 'Renamed' });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.template.eventId, fx.eventA1.eventId);
    assert.equal(kept.body.template.eventObjectId, String(fx.eventA1._id));

    const moved = await call('PATCH', `${realUrl}/templates/${t.id}`, fx.tA, { eventId: `  ${fx.eventA2.eventId} ` });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.template.eventId, fx.eventA2.eventId);
    assert.equal(moved.body.template.eventObjectId, String(fx.eventA2._id));

    for (const eventId of ['EVT-9999999', fx.eventB.eventId, 'nope', '']) {
      const refused = await call('PATCH', `${realUrl}/templates/${t.id}`, fx.tA, { eventId });
      assert.equal(refused.status, 400, eventId);
    }
    const stored = await WhatsAppTemplate.findById(t.id).lean();
    assert.equal(stored.eventId, fx.eventA2.eventId, 'unchanged by the refused edits');
    assert.equal(String(stored.eventObjectId), String(fx.eventA2._id));
  });
});

describe('Meta approval synchronisation keeps the event association', () => {
  const metaMock = (answer: (id: string) => any) => ({
    connection: CONNECTION,
    now: () => new Date(),
    meta: {
      connection: CONNECTION,
      post: async () => ({ data: { id: String(900000 + ++seq), status: 'PENDING', category: 'UTILITY' } }),
      get: async (url: string) => (url.endsWith('/message_templates') ? { data: { data: [] } } : answer(url.split('/').pop()!)),
    },
  });

  for (const [metaStatus, localState] of [['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['PAUSED', 'Paused'], ['PENDING', 'Pending']] as const) {
    test(`submit, then Meta says ${metaStatus}: the template is ${localState} and still tied to the same event`, async () => {
      const created = await svc.createTemplateDraft(fx.A, body({ eventId: fx.eventA1.eventId }), { connection: CONNECTION });
      const before = await WhatsAppTemplate.findById(created.id).lean();
      const deps = metaMock((id) => ({ data: { id, name: created.name, language: 'en', status: metaStatus, category: 'UTILITY', ...(metaStatus === 'REJECTED' ? { rejected_reason: 'INVALID_FORMAT' } : {}) } }));
      const submitted = await svc.submitTemplate(fx.A, created.id, deps);
      assert.equal(submitted.template.localState, 'Pending');
      const refreshed = await svc.refreshTemplateStatus(fx.A, created.id, { ...deps, now: () => new Date(Date.now() + 3_600_000) });
      assert.equal(refreshed.template.localState, localState);
      const after = await WhatsAppTemplate.findById(created.id).lean();
      assert.equal(String(after.eventObjectId), String(fx.eventA1._id));
      assert.equal(after.eventId, fx.eventA1.eventId);
      assert.equal(String(after._id), String(before._id));
      assert.equal(after.name, before.name);
      assert.equal(after.language, before.language);
      assert.equal(after.category, before.category);
      assert.equal(refreshed.template.eventId, fx.eventA1.eventId);
      assert.equal(refreshed.template.eventObjectId, String(fx.eventA1._id));
    });
  }
});

describe('Message tab: the templates offered for an event', () => {
  test('only this event\'s approved templates are listed, with nothing from another event', async () => {
    const mine = await approved(fx.adminA, fx.eventA1, { displayName: 'Mine' });
    await approved(fx.adminA, fx.eventA2, { displayName: 'Other event of the same Admin' });
    await approved(fx.adminB, fx.eventB, { displayName: "Another Admin's" });
    const res = await listFor(fx.tA, fx.eventA1);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.templates.map((t: any) => t.displayName), ['Mine']);
    assert.equal(res.body.templates[0].id, mine.id);
    assert.equal(res.body.event.eventId, fx.eventA1.eventId);
    assert.deepEqual(Object.keys(res.body.templates[0]).sort(), ['body', 'category', 'displayName', 'footer', 'headerText', 'id', 'language', 'name', 'variableCount']);
  });

  test('a template that is pending, rejected, paused, a draft, or approved locally but not by Meta is not listed', async () => {
    await approved(fx.adminA, fx.eventA1, { displayName: 'Approved' });
    await approved(fx.adminA, fx.eventA1, { displayName: 'Pending' }, { localState: 'Pending', metaStatus: 'PENDING' });
    await approved(fx.adminA, fx.eventA1, { displayName: 'Rejected' }, { localState: 'Rejected', metaStatus: 'REJECTED' });
    await approved(fx.adminA, fx.eventA1, { displayName: 'Paused' }, { localState: 'Paused', metaStatus: 'PAUSED' });
    await approved(fx.adminA, fx.eventA1, { displayName: 'Draft' }, { localState: 'Draft', metaStatus: null });
    await approved(fx.adminA, fx.eventA1, { displayName: 'Approved locally only' }, { metaStatus: 'PAUSED' });
    const res = await listFor(fx.tA, fx.eventA1);
    assert.deepEqual(res.body.templates.map((t: any) => t.displayName), ['Approved']);
  });

  test('a sub-event lists its own templates, not its main event\'s, and the main event does not list the sub-event\'s', async () => {
    await approved(fx.adminA, fx.eventA1, { displayName: 'Main' });
    await approved(fx.adminA, fx.subA1, { displayName: 'Haldi only' });
    assert.deepEqual((await listFor(fx.tA, fx.subA1)).body.templates.map((t: any) => t.displayName), ['Haldi only']);
    assert.deepEqual((await listFor(fx.tA, fx.eventA1)).body.templates.map((t: any) => t.displayName), ['Main']);
  });

  test('a template with no event association (made before templates were tied to events) is never listed or assigned', async () => {
    const legacy = await approved(fx.adminA, fx.eventA1, { displayName: 'Legacy' });
    await WhatsAppTemplate.collection.updateOne({ _id: new mongoose.Types.ObjectId(legacy.id) }, { $set: { eventObjectId: null, eventId: null } });
    assert.deepEqual((await listFor(fx.tA, fx.eventA1)).body.templates, []);
    const stored = await WhatsAppTemplate.findById(legacy.id).lean();
    assert.equal(stored.eventObjectId, null, 'and listing did not assign it to an event');
  });

  test('the caller needs access to the event; no event, a malformed id, an unknown event or no sign-in list nothing', async () => {
    await approved(fx.adminA, fx.eventA1);
    assert.equal((await listFor(fx.tB, fx.eventA1)).status, 403);
    assert.equal((await listFor(fx.tUserB, fx.eventA1)).status, 403);
    assert.equal((await call('GET', `${realUrl}/event-templates`, fx.tA)).status, 400, 'no event selected');
    assert.equal((await call('GET', `${realUrl}/event-templates?eventId=nope`, fx.tA)).status, 400);
    assert.equal((await call('GET', `${realUrl}/event-templates?eventId=${new mongoose.Types.ObjectId()}`, fx.tA)).status, 403);
    assert.equal((await call('GET', `${realUrl}/event-templates?eventId=${fx.eventA1._id}`)).status, 401);
  });

  test('a User assigned to the event, who may send but not manage templates, sees them', async () => {
    await approved(fx.adminA, fx.eventA1, { displayName: 'For the helper' });
    const res = await listFor(fx.tUserA, fx.eventA1);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.templates.map((t: any) => t.displayName), ['For the helper']);
  });
});

describe('sending: the association and approval are checked again on the server', () => {
  beforeEach(async () => {
    fx.g1 = await mkGuest(fx.eventA1, 'Riya');
    fx.g2 = await mkGuest(fx.eventA1, 'Meera');
  });

  test('an approved template of the event is sent to every selected guest, filled from the stored event and guest', async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    const res = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id), String(fx.g2._id)], templateId: t.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sent.length, 2);
    for (const message of sent) {
      assert.equal(message.templateName, t.name);
      assert.equal(message.languageCode, 'en');
      assert.equal(message.variables[1], 'A One');
      assert.equal(message.variables[2], 'Grand Palace, Pune');
    }
    assert.deepEqual(sent.map((m) => m.variables[0]).sort(), ['Meera', 'Riya']);
    const audit = await AuditLog.findOne({ action: 'WHATSAPP_TEMPLATE_SENT' }).lean();
    assert.equal(audit.metadata.templateId, t.id);
  });

  test("another event's template is refused for this event - the same Admin's, another Admin's, or a sub-event's", async () => {
    const sameAdminOtherEvent = await approved(fx.adminA, fx.eventA2);
    const otherAdmin = await approved(fx.adminB, fx.eventB);
    const subEventOnly = await approved(fx.adminA, fx.subA1);
    for (const t of [sameAdminOtherEvent, otherAdmin, subEventOnly]) {
      const res = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'TEMPLATE_NOT_FOR_EVENT');
    }
    assert.equal(sent.length, 0);
  });

  test('a template that is not approved by Meta is refused, whatever its local state or listing said', async () => {
    const states: [string, Record<string, any>][] = [
      ['draft', { localState: 'Draft', metaStatus: null }],
      ['pending', { localState: 'Pending', metaStatus: 'PENDING' }],
      ['rejected', { localState: 'Rejected', metaStatus: 'REJECTED' }],
      ['paused', { localState: 'Paused', metaStatus: 'PAUSED' }],
      ['unknown', { localState: 'Unknown', metaStatus: null }],
      ['approved locally, paused at Meta', { localState: 'Approved', metaStatus: 'PAUSED' }],
    ];
    for (const [label, state] of states) {
      const t = await approved(fx.adminA, fx.eventA1, {}, state);
      const res = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id });
      assert.equal(res.status, 409, `${label}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'TEMPLATE_NOT_APPROVED', label);
    }
    assert.equal(sent.length, 0);
  });

  test('a template that was listed and then paused or re-pointed is refused at send time', async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    assert.equal((await listFor(fx.tA, fx.eventA1)).body.templates.length, 1);
    await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: 'Paused', metaStatus: 'PAUSED' } });
    assert.equal((await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id })).status, 409);
    await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: 'Approved', metaStatus: 'APPROVED', eventObjectId: fx.eventA2._id, eventId: fx.eventA2.eventId } });
    assert.equal((await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id })).status, 403);
    assert.equal(sent.length, 0);
  });

  test('both stored ids must agree with the event: a mismatched business id or a missing association is refused', async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { eventId: fx.eventA2.eventId } });
    assert.equal((await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id })).status, 403);
    await WhatsAppTemplate.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.id) }, { $set: { eventObjectId: null, eventId: null } });
    assert.equal((await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id })).status, 403);
    assert.equal(sent.length, 0);
  });

  test('a malformed, unknown or ambiguous template choice is refused', async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    const base = { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)] };
    assert.equal((await send(fx.tA, { ...base, templateId: 'not-an-id' })).status, 400);
    assert.equal((await send(fx.tA, { ...base, templateId: String(new mongoose.Types.ObjectId()) })).status, 403);
    assert.equal((await send(fx.tA, { ...base, templateId: t.id, templateName: 'event_reminder' })).status, 400, 'a name and an id together');
    assert.equal((await send(fx.tA, { ...base })).status, 400, 'neither');
    assert.equal(sent.length, 0);
  });

  test('the caller must still have access to the event; a User of another event cannot use its template', async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    const payload = { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id };
    assert.equal((await send(fx.tB, payload)).status, 403);
    assert.equal((await send(fx.tUserB, payload)).status, 403);
    assert.equal((await send(fx.tUserA, payload)).status, 200, 'the assigned User may');
    assert.equal(sent.length, 1);
  });

  test("a guest of another event is still refused through this event's template", async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    const stranger = await mkGuest(fx.eventA2, 'Stranger');
    const res = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(stranger._id)], templateId: t.id });
    assert.notEqual(res.status, 200);
    assert.equal(sent.length, 0);
  });

  test('a sub-event sends its own template to the guests on its member list only', async () => {
    const t = await approved(fx.adminA, fx.subA1);
    await EventMember.create({ eventId: fx.subA1._id, contactId: fx.g1._id });
    const ok = await send(fx.tA, { eventId: String(fx.subA1._id), contactIds: [String(fx.g1._id)], templateId: t.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const notMember = await send(fx.tA, { eventId: String(fx.subA1._id), contactIds: [String(fx.g2._id)], templateId: t.id });
    assert.notEqual(notMember.status, 200);
    assert.equal(sent.length, 1);
  });

  test('a template of another WhatsApp Business Account than the sender\'s is refused', async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    process.env.WHATSAPP_WABA_ID = '999999999999999';
    const res = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(sent.length, 0);
  });

  test('the built-in templates still send by name, unchanged and unaffected by event templates', async () => {
    await approved(fx.adminA, fx.eventA1);
    const res = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id), String(fx.g2._id)], templateName: 'event_reminder' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].templateName, 'event_reminder');
    assert.equal(sent[0].variables.length, 5);
    assert.equal((await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateName: 'not_a_template' })).status, 400);
  });

  test('a built-in media template still needs its file, and event templates take none', async () => {
    const t = await approved(fx.adminA, fx.eventA1);
    const media = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateName: 'event_image' });
    assert.notEqual(media.status, 200, 'the image template cannot be sent without its image');
    assert.equal(sent.length, 0);
    const plain = await send(fx.tA, { eventId: String(fx.eventA1._id), contactIds: [String(fx.g1._id)], templateId: t.id });
    assert.equal(plain.status, 200);
    assert.equal(sent[0].headerMedia, undefined);
  });
});

describe('previewing an event template', () => {
  test('shows the stored wording and the values for the first guest, and applies the same event/association/approval checks', async () => {
    const g = await mkGuest(fx.eventA1, 'Preview Guest');
    const t = await approved(fx.adminA, fx.eventA1);
    const url = (tpl: string, event = fx.eventA1) => `${realUrl}/event-template-preview?eventId=${event._id}&contactId=${g._id}&templateId=${tpl}`;
    const ok = await call('GET', url(t.id), fx.tA);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.bodySource, 'template');
    assert.equal(ok.body.bodyText, 'Dear {{1}}, you are invited to {{2}} at {{3}}.');
    assert.deepEqual(ok.body.variables.map((v: any) => v.value), ['Preview Guest', 'A One', 'Grand Palace, Pune']);
    assert.equal(ok.body.placeholderMismatch, false);
    assert.equal(ok.body.header, null);

    const other = await approved(fx.adminA, fx.eventA2);
    assert.equal((await call('GET', url(other.id), fx.tA)).status, 403);
    await WhatsAppTemplate.updateOne({ _id: t.id }, { $set: { localState: 'Rejected', metaStatus: 'REJECTED' } });
    assert.equal((await call('GET', url(t.id), fx.tA)).status, 409);
    assert.equal((await call('GET', url(t.id), fx.tB)).status, 403);
  });
});

describe('templates made before templates were tied to events', () => {
  const legacyDoc = async (event: any | null, over: Record<string, any> = {}) => {
    const t = await svc.createTemplateDraft(fx.A, body({ eventId: fx.eventA1.eventId }), { connection: CONNECTION });
    await WhatsAppTemplate.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(t.id) },
      { $set: { eventId: event ? event._id : null, ...over }, $unset: { eventObjectId: '' } }
    );
    return t.id;
  };

  test('an old template that pointed at an event reads as unassociated until converted - never as a garbled Event ID', async () => {
    const id = await legacyDoc(fx.eventA1);
    const view = await svc.getTemplate(fx.A, id);
    assert.equal(view.eventId, null);
    assert.equal(view.eventObjectId, null);
    assert.deepEqual((await listFor(fx.tA, fx.eventA1)).body.templates, []);
  });

  test('the conversion carries each old association over from the event in the database, and only that', async () => {
    const withEvent = await legacyDoc(fx.eventA1);
    const withSub = await legacyDoc(fx.subA1);
    const reusable = await legacyDoc(null);
    const orphan = await legacyDoc({ _id: new mongoose.Types.ObjectId() });
    await WhatsAppTemplate.updateOne({ _id: withEvent }, { $set: { localState: 'Approved', metaStatus: 'APPROVED' } }, { overwriteImmutable: true });

    const found = await links.findLegacyTemplateLinks();
    assert.equal(found.length, 3, 'a template that never had an event is not listed');
    assert.equal(found.find((l: any) => l.templateId === orphan).eventBusinessId, null);

    const result = await links.migrateLegacyTemplateLinks();
    assert.equal(result.converted, 2);
    assert.equal(result.unresolved.length, 1);

    const a: any = await WhatsAppTemplate.findById(withEvent).lean();
    assert.equal(String(a.eventObjectId), String(fx.eventA1._id));
    assert.equal(a.eventId, fx.eventA1.eventId);
    const b: any = await WhatsAppTemplate.findById(withSub).lean();
    assert.equal(b.eventId, fx.subA1.eventId);
    assert.equal(b.name !== undefined && b.localState !== undefined, true, 'nothing else changed');
    const r: any = await WhatsAppTemplate.findById(reusable).lean();
    assert.equal(r.eventObjectId ?? null, null, 'never assigned to an event');
    assert.equal(r.eventId ?? null, null);

    // It is now exactly like a new template, and an approved one is offered for its event.
    assert.deepEqual((await listFor(fx.tA, fx.eventA1)).body.templates.map((t: any) => t.id), [withEvent]);
    // A second run changes nothing.
    assert.deepEqual(await links.migrateLegacyTemplateLinks().then((x: any) => x.converted), 0);
  });
});
