import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * pranjali_ankit_wedding_invite from the Campaign Composer, over real HTTP,
 * against the REAL compiled backend (backend/dist) on a throwaway local
 * MongoDB database.
 *
 *  - it is sent exactly as approved, for ANY event: the template by name,
 *    in "en", with no body parameters - no guest name ever reaches Meta;
 *  - the approved body is read through the existing catalog lookup and shown
 *    unmodified; a body that does take values, numbered or named, is flagged
 *    (placeholderMismatch), which keeps the Composer's Send disabled;
 *  - the Stage 6b sender rules and event authorization still apply;
 *  - the existing templates are unaffected.
 *
 * Meta is faked on the shared axios instance. The catalog answer is a MOCK
 * whose body text is invented for the test - only its placeholders matter -
 * and anything unexpected fails the suite. The token is fake; nothing can
 * leave this process.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_weddingtpl_${Date.now()}`;
const FAKE_TOKEN = 'EAAG-FAKE-WEDDING-TEMPLATE-TOKEN-never-real-51c2';
const WABA = '900000000000555';
const ENV_PHONE = '111000000000555';
const NAME = 'pranjali_ankit_wedding_invite';
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = FAKE_TOKEN;
process.env.WHATSAPP_PHONE_ID = ENV_PHONE;
process.env.WHATSAPP_WABA_ID = WABA;
process.env.WHATSAPP_API_VERSION = 'v22.0';

// ── fake Meta on the axios instance every backend module uses ───────────────
const axios = createRequire(require.resolve('../backend/dist/services/WhatsAppService'))('axios');
const real = { post: axios.post, get: axios.get };
const meta = {
  messages: [] as { phone: string; body: any }[],
  catalogLookups: [] as string[],
  unexpected: [] as string[],
  /** The mocked catalog entries for the template, by language. */
  catalog: [] as any[],
};
let wamidSeq = 0;
axios.post = async (url: string, body: any) => {
  const u = new URL(url);
  const [, , phone, edge] = u.pathname.split('/');
  if (u.hostname === 'graph.facebook.com' && edge === 'messages') {
    meta.messages.push({ phone, body });
    return { data: { messages: [{ id: `wamid.WEDDING${++wamidSeq}` }], contacts: [{ wa_id: String(body?.to).replace('+', '') }] } };
  }
  meta.unexpected.push(`POST ${url}`);
  throw new Error('unexpected POST');
};
axios.get = async (url: string, options: any) => {
  const u = new URL(url);
  if (u.hostname === 'graph.facebook.com' && u.pathname === `/v22.0/${WABA}/message_templates`) {
    const name = options?.params?.name;
    meta.catalogLookups.push(name);
    return { data: { data: name === NAME ? meta.catalog : [] } };
  }
  meta.unexpected.push(`GET ${url}`);
  throw new Error('unexpected GET');
};

/** A mocked approved definition: Meta's shape, with an invented body. */
const approved = (body: string, extra: Record<string, unknown> = {}) => ({
  name: NAME, language: 'en', status: 'APPROVED', category: 'MARKETING', id: '1129562792755797',
  components: [{ type: 'BODY', text: body }], ...extra,
});
const AS_APPROVED_BODY = 'You are warmly invited to celebrate with us. [mocked body for the test]';
const NO_VALUES = approved(AS_APPROVED_BODY);

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const whatsappController = require('../backend/dist/controllers/whatsappController');
const { clearTemplateCatalogCache } = require('../backend/dist/services/whatsappTemplateCatalog');
const { Admin } = require('../backend/dist/models/Admin');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');
const { MessageLog } = require('../backend/dist/models/MessageLog');
const { EventMember } = require('../backend/dist/models/EventMember');
const { WhatsAppSender } = require('../backend/dist/models/WhatsAppSender');

let server: any;
let baseUrl = '';
let ip = 0;
const fx: any = {};

const call = (method: string, p: string, token: string | null, body?: any): Promise<{ status: number; body: any; raw: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
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

const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

const mkEvent = (eventName: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: new Date('2027-01-30T00:00:00.000Z'), eventTime: new Date('2027-01-30T13:30:00.000Z'),
    eventVenue: 'Pune', eventStatus: 'Upcoming', ...extra,
  });

let phoneSeq = 0;
const guest = (event: any, fullName: string) =>
  Contact.create({ fullName, phoneNumber: `+9197${String(10000000 + ++phoneSeq).padStart(8, '0')}`, countryCode: '+91', eventId: event._id, status: 'Valid' });

/** A Sub-Event's guests are its members: contacts of the Main Event, added to it. */
const subGuest = async (sub: any, main: any, fullName: string) => {
  const contact = await guest(main, fullName);
  await EventMember.create({ eventId: sub._id, contactId: contact._id });
  return contact;
};

let senderSeq = 400000000000000;
const mkSender = (overrides: Record<string, any> = {}) =>
  WhatsAppSender.create({
    phoneNumberId: String(++senderSeq), wabaId: WABA, displayPhoneNumber: `+91 90000 ${String(senderSeq).slice(-5)}`,
    verifiedName: `Sender ${senderSeq}`, metaStatus: 'CONNECTED', statusCheckedAt: new Date(), listedInMeta: true,
    enabled: true, allowedAdminIds: [fx.adminA._id], ...overrides,
  });
const assign = (event: any, sender: any) => Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: sender._id } });

const preview = (event: any, contact: any, token: string, templateName = NAME) =>
  call('GET', `/api/whatsapp/event-template-preview?eventId=${event._id}&contactId=${contact._id}&templateName=${templateName}`, token);
const send = (event: any, contacts: any[], token: string, templateName = NAME) =>
  call('POST', '/api/whatsapp/event-template', token, { eventId: String(event._id), contactIds: contacts.map((c) => String(c._id)), templateName });

/** The Meta payload's single body component values, as sent (event_reminder). */
const bodyParams = (message: { body: any }) => {
  const components = message.body.template.components;
  assert.equal(components.length, 1, 'only a body component');
  assert.equal(components[0].type, 'body');
  return components[0].parameters.map((p: any) => { assert.equal(p.type, 'text'); return p.text; });
};

/** The wedding template as sent: by name, in "en", and nothing else. */
const assertSentAsApproved = (message: { body: any }, guestName: string, phone: string) => {
  assert.equal(message.body.type, 'template');
  assert.equal(message.body.to, phone);
  assert.deepEqual(message.body.template, { name: NAME, language: { code: 'en' } }, 'no components: no body parameters, header or buttons');
  assert.equal(JSON.stringify(message.body).includes(guestName), false, 'the guest name never reaches Meta');
};

before(async () => {
  await mongoose.connect(TEST_DB);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-wt@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminA = await Admin.create({ name: 'Admin A', email: 'a-wt@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.adminB = await Admin.create({ name: 'Admin B', email: 'b-wt@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });

  fx.mainA = await mkEvent('A Wedding', { adminId: fx.adminA._id, createdBy: fx.adminA._id });
  fx.subA = await mkEvent('A Haldi', { adminId: fx.adminA._id, createdBy: fx.adminA._id, parentEventId: fx.mainA._id });
  fx.mainB = await mkEvent('B Corporate Gala', { adminId: fx.adminB._id, createdBy: fx.adminB._id, eventType: 'Corporate' });
  fx.superEvent = await mkEvent('Platform Launch', { createdBy: fx.superAdmin._id, eventType: 'Launch' });

  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');

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
  assert.deepEqual(meta.unexpected, [], 'no unexpected request was made');
});

beforeEach(async () => {
  await Event.updateMany({}, { $set: { whatsappSenderId: null } });
  await WhatsAppSender.deleteMany({});
  await MessageLog.deleteMany({});
  whatsappController.clearRecentEventTemplateSends();
  clearTemplateCatalogCache();
  meta.messages.length = 0;
  meta.catalogLookups.length = 0;
  meta.catalog = [NO_VALUES];
});

describe('sent exactly as approved, for any event', () => {
  const cases = () => [
    { label: "Admin A's Main Event", event: fx.mainA, token: fx.a, make: (n: string) => guest(fx.mainA, n) },
    { label: "Admin A's Sub-Event", event: fx.subA, token: fx.a, make: (n: string) => subGuest(fx.subA, fx.mainA, n) },
    { label: "Admin B's unrelated event", event: fx.mainB, token: fx.b, make: (n: string) => guest(fx.mainB, n) },
    { label: "a Super Admin's event", event: fx.superEvent, token: fx.super, make: (n: string) => guest(fx.superEvent, n) },
  ];

  test('the preview shows the approved body unmodified, fills nothing, and finds no mismatch', async () => {
    for (const c of cases()) {
      const contact = await c.make(`Preview Guest ${c.label}`);
      const res = await preview(c.event, contact, c.token);
      assert.equal(res.status, 200, `${c.label}: ${res.raw}`);
      assert.equal(res.body.templateName, NAME);
      assert.equal(res.body.languageCode, 'en');
      assert.equal(res.body.bodySource, 'meta', 'the approved definition is read from Meta, not written locally');
      assert.equal(res.body.bodyText, AS_APPROVED_BODY, 'the approved wording, exactly');
      assert.equal(res.body.templateStatus, 'APPROVED');
      assert.deepEqual(res.body.variables, [], 'nothing is filled in');
      assert.equal(res.body.placeholderMismatch, false, c.label);
      assert.equal(res.body.header, null, c.label);
    }
    assert.ok(meta.catalogLookups.every((n) => n === NAME));
  });

  test('Meta receives the template by name, in "en", with no parameters - and never the guest name', async () => {
    for (const c of cases()) {
      meta.messages.length = 0;
      const people = [await c.make(`Riya ${c.label}`), await c.make(`Kabir ${c.label}`)];
      const res = await send(c.event, people, c.token);
      assert.equal(res.status, 200, `${c.label}: ${res.raw}`);
      assert.equal(meta.messages.length, 2, c.label);
      const byPhone = new Map(meta.messages.map((m) => [m.body.to, m]));
      for (const person of people) {
        const message = byPhone.get(person.phoneNumber);
        assert.ok(message, `${c.label}: ${person.fullName} was messaged`);
        assertSentAsApproved(message, person.fullName, person.phoneNumber);
        assert.equal(message.phone, ENV_PHONE, 'no sender assigned: the environment sender, as before');
      }
      assert.equal(res.raw.includes(FAKE_TOKEN), false);
    }
  });

  test('each send is recorded against the wedding template', async () => {
    const contact = await guest(fx.mainB, 'Logged Guest');
    assert.equal((await send(fx.mainB, [contact], fx.b)).status, 200);
    const logs = await MessageLog.find({ contactId: contact._id }).lean();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].templateName, NAME);
    assert.equal(logs[0].status, 'Sent');
  });
});

describe('a body that takes values is flagged, so Send stays disabled', () => {
  for (const [label, body] of [
    ['a numbered value', 'Dear {{1}}, you are invited. [mock]'],
    ['a named value', 'Dear {{guest_name}}, you are invited. [mock]'],
    ['several values', '{{1}}, join us on {{2}} at {{venue}}. [mock]'],
  ] as const) {
    test(`${label} is a mismatch`, async () => {
      meta.catalog = [approved(body)];
      const res = await preview(fx.mainA, await guest(fx.mainA, `Mismatch ${label}`), fx.a);
      assert.equal(res.status, 200);
      assert.equal(res.body.placeholderMismatch, true, body);
      assert.deepEqual(res.body.variables, []);
      assert.equal(meta.messages.length, 0, 'a preview never sends');
    });
  }

  test('the "en" version is the one checked', async () => {
    meta.catalog = [approved('{{1}} {{2}} {{3}} [mock]', { language: 'hi' }), NO_VALUES];
    const res = await preview(fx.mainA, await guest(fx.mainA, 'Language Guest'), fx.a);
    assert.equal(res.body.languageCode, 'en');
    assert.equal(res.body.placeholderMismatch, false);
  });
});

describe('Stage 6b sender rules and event authorization still apply', () => {
  test("an eligible assigned sender is used, and a Sub-Event uses its Main Event's", async () => {
    const s = await mkSender();
    await assign(fx.mainA, s);
    assert.equal((await send(fx.mainA, [await guest(fx.mainA, 'Assigned Main')], fx.a)).status, 200);
    assert.equal((await send(fx.subA, [await subGuest(fx.subA, fx.mainA, 'Assigned Sub')], fx.a)).status, 200);
    assert.deepEqual(meta.messages.map((m) => m.phone), [s.phoneNumberId, s.phoneNumberId]);
  });

  test('a disabled assigned sender refuses the send - no fallback to the environment sender', async () => {
    await assign(fx.mainA, await mkSender({ enabled: false }));
    const res = await send(fx.mainA, [await guest(fx.mainA, 'Disabled Sender')], fx.a);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SENDER_UNAVAILABLE');
    assert.equal(meta.messages.length, 0);
  });

  test("an owner not on the sender's allowlist refuses the send", async () => {
    await assign(fx.mainB, await mkSender({ allowedAdminIds: [fx.adminA._id] }));
    const res = await send(fx.mainB, [await guest(fx.mainB, 'Not Allowed')], fx.b);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SENDER_NOT_ALLOWED');
    assert.equal(meta.messages.length, 0);
  });

  test("another Admin's event is refused, for the preview and the send", async () => {
    const contact = await guest(fx.mainA, 'Not Yours');
    const p = await preview(fx.mainA, contact, fx.b);
    const s = await send(fx.mainA, [contact], fx.b);
    assert.ok([403, 404].includes(p.status), `preview ${p.status}`);
    assert.ok([403, 404].includes(s.status), `send ${s.status}`);
    assert.equal(meta.messages.length, 0);
  });

  test('no token is refused', async () => {
    const res = await send(fx.mainA, [await guest(fx.mainA, 'No Token')], null as any);
    assert.equal(res.status, 401);
    assert.equal(meta.messages.length, 0);
  });
});

describe('the existing templates are unaffected', () => {
  test('event_reminder still sends its five values', async () => {
    const contact = await guest(fx.mainA, 'Reminder Guest');
    const res = await send(fx.mainA, [contact], fx.a, 'event_reminder');
    assert.equal(res.status, 200, res.raw);
    assert.equal(meta.messages.length, 1);
    assert.equal(meta.messages[0].body.template.name, 'event_reminder');
    assert.deepEqual(bodyParams(meta.messages[0]), ['Reminder Guest', 'A Wedding', '30 January 2027', '7:00 PM', 'Pune']);
  });

  test('an unknown template is still refused', async () => {
    const res = await send(fx.mainA, [await guest(fx.mainA, 'Unknown')], fx.a, 'pranjali_ankit_wedding_invite_v2');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNKNOWN_TEMPLATE');
    assert.ok(res.body.error.message.includes(NAME), 'the refusal lists the wedding template among those available');
    assert.equal(meta.messages.length, 0);
  });
});
