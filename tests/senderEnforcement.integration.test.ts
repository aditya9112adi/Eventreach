import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Stage 6b: the WhatsApp sender is enforced on every send, over real HTTP,
 * against the REAL compiled backend (backend/dist) on a throwaway local
 * MongoDB database.
 *
 *  - Composer (POST /api/whatsapp/event-template) and the legacy campaign
 *    (POST /api/campaigns/event/:id/send, and its queue) send only from the
 *    event's effective sender, checked at the moment of sending;
 *  - decision A: the event's owning Admin must be on the sender's allowlist;
 *  - decision B: only the owning Admin or a Super Admin edits contact
 *    settings;
 *  - the Senders page's manual status refresh reports what really happened.
 *
 * Meta is faked on the shared axios instance: message and media POSTs and
 * status GETs are answered here and recorded, and anything else fails the
 * suite. The token is fake; nothing can leave this process.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_senderenforce_${Date.now()}`;
const FAKE_TOKEN = 'EAAG-FAKE-STAGE6B-TOKEN-never-real-3d7e';
const WABA = '900000000000777';
const ENV_PHONE = '111000000000777';
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
  messages: [] as { phone: string; to: string }[],
  media: [] as string[],
  statusCalls: [] as string[],
  unexpected: [] as string[],
  status: new Map<string, string | Error>(),
  onMessage: null as null | ((count: number) => Promise<void> | void),
  messageDelayMs: 0,
};
let wamidSeq = 0;
axios.post = async (url: string, body: any) => {
  const u = new URL(url);
  const [, , phone, edge] = u.pathname.split('/');
  if (u.hostname === 'graph.facebook.com' && edge === 'messages') {
    meta.messages.push({ phone, to: body?.to });
    if (meta.messageDelayMs) await new Promise((r) => setTimeout(r, meta.messageDelayMs));
    if (meta.onMessage) await meta.onMessage(meta.messages.length);
    return { data: { messages: [{ id: `wamid.TEST${++wamidSeq}` }], contacts: [{ wa_id: String(body?.to).replace('+', '') }] } };
  }
  if (u.hostname === 'graph.facebook.com' && edge === 'media') {
    meta.media.push(phone);
    return { data: { id: `media-${meta.media.length}` } };
  }
  meta.unexpected.push(`POST ${url}`);
  throw new Error('unexpected POST');
};
axios.get = async (url: string) => {
  const u = new URL(url);
  const id = u.pathname.split('/').pop()!;
  if (u.hostname === 'graph.facebook.com' && u.searchParams.get('fields') === 'status' && meta.status.has(id)) {
    meta.statusCalls.push(id);
    const answer = meta.status.get(id)!;
    if (answer instanceof Error) throw answer;
    return { data: { status: answer } };
  }
  if (u.hostname === 'graph.facebook.com' && u.pathname.endsWith('/message_templates')) return { data: { data: [] } };
  meta.unexpected.push(`GET ${url}`);
  throw new Error('unexpected GET');
};

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const campaignRoutes = require('../backend/dist/routes/campaignRoutes').default;
const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const senderRoutes = require('../backend/dist/routes/whatsappSenderRoutes').default;
const whatsappController = require('../backend/dist/controllers/whatsappController');
const { whatsappService } = require('../backend/dist/services/WhatsAppService');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');
const { Campaign } = require('../backend/dist/models/Campaign');
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
const guests = async (event: any, count: number) => {
  const docs = [];
  for (let i = 0; i < count; i++) {
    docs.push(await Contact.create({ fullName: `Guest ${++phoneSeq}`, phoneNumber: `+9198${String(70000000 + phoneSeq).padStart(8, '0')}`, countryCode: '+91', eventId: event._id, status: 'Valid' }));
  }
  return docs;
};

/** A Sub-Event's guests are its members: contacts of the Main Event, added to it. */
const subGuests = async (sub: any, main: any, count: number) => {
  const contacts = await guests(main, count);
  for (const c of contacts) await EventMember.create({ eventId: sub._id, contactId: c._id });
  return contacts;
};

let senderSeq = 300000000000000;
const mkSender = (overrides: Record<string, any> = {}) =>
  WhatsAppSender.create({
    phoneNumberId: String(++senderSeq), wabaId: WABA, displayPhoneNumber: `+91 90000 ${String(senderSeq).slice(-5)}`,
    verifiedName: `Sender ${senderSeq}`, metaStatus: 'CONNECTED', statusCheckedAt: new Date(), listedInMeta: true,
    enabled: true, allowedAdminIds: [fx.adminA._id], ...overrides,
  });

const assign = (event: any, sender: any) => Event.updateOne({ _id: event._id }, { $set: { whatsappSenderId: sender ? sender._id : null } });

const compose = (event: any, contacts: any[], token = fx.a, extra: Record<string, any> = {}) =>
  call('POST', '/api/whatsapp/event-template', token, { eventId: String(event._id), contactIds: contacts.map((c) => String(c._id)), templateName: 'event_reminder', ...extra });

const sendCampaign = async (event: any, contacts: any[], token = fx.a, extra: Record<string, any> = {}) => {
  await Campaign.deleteMany({ eventId: event._id });
  const campaign = await Campaign.create({ eventId: event._id, messageText: 'Hello {{fullName}}', status: 'Draft' });
  const res = await call('POST', `/api/campaigns/event/${event._id}/send`, token, { recipientIds: contacts.map((c) => String(c._id)), ...extra });
  return { res, campaign };
};

/** Waits for the campaign queue to finish with every log. */
const settled = async (campaign: any, expected: number) => {
  for (let i = 0; i < 100; i++) {
    const logs = await MessageLog.find({ campaignId: campaign._id }).lean();
    if (logs.length === expected && logs.every((l: any) => l.status !== 'Pending')) {
      if ((await Campaign.findById(campaign._id).lean()).status === 'Completed') return logs;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('campaign did not settle');
};

before(async () => {
  await mongoose.connect(TEST_DB);
  fx.superAdmin = await Admin.create({ name: 'Super', email: 'super-6b@example.com', passwordHash: 'x', role: 'SuperAdmin', status: 'Active' });
  fx.adminA = await Admin.create({ name: 'Admin A', email: 'a-6b@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });
  fx.adminB = await Admin.create({ name: 'Admin B', email: 'b-6b@example.com', passwordHash: 'x', role: 'Admin', status: 'Active' });

  fx.mainA = await mkEvent('A Wedding', { adminId: fx.adminA._id, createdBy: fx.adminA._id });
  fx.subA = await mkEvent('A Haldi', { adminId: fx.adminA._id, createdBy: fx.adminA._id, parentEventId: fx.mainA._id });
  fx.superEvent = await mkEvent('Platform Gala', { createdBy: fx.superAdmin._id });
  fx.orphanEvent = await mkEvent('Orphan Event', { adminId: new mongoose.Types.ObjectId(), createdBy: new mongoose.Types.ObjectId() });
  fx.mismatchSub = await mkEvent('Odd Sub', { adminId: fx.adminB._id, createdBy: fx.adminB._id, parentEventId: fx.mainA._id });

  // Admin B can SEE A's wedding only because one of B's Users is assigned to it.
  fx.userA = await User.create({ name: 'User A', email: 'ua-6b@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminA._id, assignedEventId: fx.mainA._id });
  fx.userB = await User.create({ name: 'User B', email: 'ub-6b@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminB._id, assignedEventId: fx.mainA._id });
  fx.userOut = await User.create({ name: 'User Out', email: 'uo-6b@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminB._id, assignedEventId: fx.superEvent._id });

  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');
  fx.uA = tokenFor(fx.userA, 'User');
  fx.uB = tokenFor(fx.userB, 'User');
  fx.uOut = tokenFor(fx.userOut, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/campaigns', campaignRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/whatsapp-senders', senderRoutes);
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
  meta.messages.length = 0;
  meta.media.length = 0;
  meta.statusCalls.length = 0;
  meta.status.clear();
  meta.onMessage = null;
  meta.messageDelayMs = 0;
});

const phonesUsed = () => [...new Set(meta.messages.map((m) => m.phone))];

describe('Composer: the event decides the sender', () => {
  test('an eligible assigned sender is used - not the environment number', async () => {
    const s = await mkSender();
    await assign(fx.mainA, s);
    const res = await compose(fx.mainA, await guests(fx.mainA, 2));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(phonesUsed(), [s.phoneNumberId]);
    assert.equal(res.raw.includes(FAKE_TOKEN), false);
  });

  test('an event with no assignment sends from the environment sender, as before', async () => {
    const res = await compose(fx.mainA, await guests(fx.mainA, 1));
    assert.equal(res.status, 200);
    assert.deepEqual(phonesUsed(), [ENV_PHONE]);
  });

  test('disabled, unlisted, wrong account, missing, disconnected or unverifiable: refused, nothing sent, nothing logged', async () => {
    const stale = () => new Date(Date.now() - 16 * 60 * 1000);
    const cases: [string, () => Promise<any>, number, string][] = [
      ['disabled', () => mkSender({ enabled: false }), 409, 'SENDER_UNAVAILABLE'],
      ['unlisted', () => mkSender({ listedInMeta: false }), 409, 'SENDER_UNAVAILABLE'],
      ['other WABA', () => mkSender({ wabaId: '900000000000999' }), 409, 'SENDER_UNAVAILABLE'],
      ['stale, Meta says DISCONNECTED', async () => { const s = await mkSender({ statusCheckedAt: stale() }); meta.status.set(s.phoneNumberId, 'DISCONNECTED'); return s; }, 409, 'SENDER_UNAVAILABLE'],
      ['stale, Meta unreachable', async () => { const s = await mkSender({ statusCheckedAt: stale() }); meta.status.set(s.phoneNumberId, Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })); return s; }, 502, 'SENDER_STATUS_UNVERIFIED'],
      ['fresh but not CONNECTED', () => mkSender({ metaStatus: 'FLAGGED' }), 409, 'SENDER_UNAVAILABLE'],
    ];
    for (const [label, make, status, code] of cases) {
      const s = await make();
      await assign(fx.mainA, s);
      const res = await compose(fx.mainA, await guests(fx.mainA, 1));
      assert.equal(res.status, status, label);
      assert.equal(res.body.error.code, code, label);
      assert.match(res.body.error.message, /Nothing was sent/, label);
    }
    const ghost = { _id: new mongoose.Types.ObjectId() };
    await assign(fx.mainA, ghost);
    const missing = await compose(fx.mainA, await guests(fx.mainA, 1));
    assert.deepEqual([missing.status, missing.body.error.code], [409, 'SENDER_UNAVAILABLE'], 'missing record');
    assert.equal(meta.messages.length, 0);
    assert.equal(await MessageLog.countDocuments({}), 0);
  });

  test("decision A: the event OWNER's Admin must be allowlisted - the caller's rights do not count", async () => {
    const onlyB = await mkSender({ allowedAdminIds: [fx.adminB._id] });
    await assign(fx.mainA, onlyB);
    for (const token of [fx.a, fx.super]) {
      const res = await compose(fx.mainA, await guests(fx.mainA, 1), token);
      assert.deepEqual([res.status, res.body.error.code], [409, 'SENDER_NOT_ALLOWED']);
    }
    assert.equal(meta.messages.length, 0);
  });

  test("removing the owner's Admin from the allowlist blocks the next send", async () => {
    const s = await mkSender();
    await assign(fx.mainA, s);
    assert.equal((await compose(fx.mainA, await guests(fx.mainA, 1))).status, 200);
    await WhatsAppSender.updateOne({ _id: s._id }, { $set: { allowedAdminIds: [] } });
    const res = await compose(fx.mainA, await guests(fx.mainA, 1), fx.super);
    assert.deepEqual([res.status, res.body.error.code], [409, 'SENDER_NOT_ALLOWED']);
    assert.equal(meta.messages.length, 1);
  });

  test('a Super Admin cannot use an assigned sender on a Super Admin-owned event (no Admin can be allowlisted for it)', async () => {
    const s = await mkSender({ allowedAdminIds: [fx.adminA._id, fx.adminB._id] });
    await assign(fx.superEvent, s);
    const res = await compose(fx.superEvent, await guests(fx.superEvent, 1), fx.super);
    assert.deepEqual([res.status, res.body.error.code], [409, 'SENDER_NOT_ALLOWED']);
    await assign(fx.superEvent, null);
    assert.equal((await compose(fx.superEvent, await guests(fx.superEvent, 1), fx.super)).status, 200, 'the environment sender still works for it');
    assert.deepEqual(phonesUsed(), [ENV_PHONE]);
  });

  test('missing or ambiguous ownership rejects a send through an assigned sender', async () => {
    const s = await mkSender();
    for (const event of [fx.orphanEvent, fx.mismatchSub]) {
      await assign(event, s);
      const res = await compose(event, await guests(event, 1), fx.super);
      assert.deepEqual([res.status, res.body.error.code], [409, 'EVENT_OWNER_UNVERIFIED'], event.eventName);
    }
    assert.equal(meta.messages.length, 0);
  });

  test('the request cannot choose the sender', async () => {
    const mine = await mkSender();
    const other = await mkSender();
    await assign(fx.mainA, mine);
    const res = await compose(fx.mainA, await guests(fx.mainA, 1), fx.a, {
      phoneNumberId: other.phoneNumberId, senderId: String(other._id), whatsappSenderId: String(other._id), senderPhoneNumberId: other.phoneNumberId,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(phonesUsed(), [mine.phoneNumberId]);
  });

  test('unauthorized callers cannot send through an eligible sender', async () => {
    const s = await mkSender();
    await assign(fx.mainA, s);
    assert.equal((await compose(fx.mainA, await guests(fx.mainA, 1), fx.uOut)).status, 403);
    assert.equal((await compose(fx.mainA, await guests(fx.mainA, 1), null)).status, 401);
    assert.equal(meta.messages.length, 0);
  });

  test('if the sender is disabled part-way through, the remaining recipients are not sent', async () => {
    const s = await mkSender();
    await assign(fx.mainA, s);
    meta.messageDelayMs = 50;
    // The first message disables the sender, and every message already in flight
    // waits until that write has committed. Without the wait, the other in-flight
    // messages could finish and start the next recipients before the write landed,
    // so the outcome depended on database timing (it failed under load).
    let disabling: Promise<unknown> | null = null;
    meta.onMessage = async () => {
      if (!disabling) disabling = WhatsAppSender.updateOne({ _id: s._id }, { $set: { enabled: false } }).exec();
      await disabling;
    };
    const res = await compose(fx.mainA, await guests(fx.mainA, 8));
    const failed = res.body.failed ?? [];
    assert.ok(meta.messages.length <= 5, `at most the in-flight first wave was sent (${meta.messages.length})`);
    assert.ok(failed.length >= 3, 'later recipients were refused');
    assert.ok(failed.every((f: any) => /disabled|Nothing was sent/.test(JSON.stringify(f))), JSON.stringify(failed[0]));
  });
});

describe('Sub-Events: own sender, then the Main Event, then the environment - never a silent fallback', () => {
  test('resolution order', async () => {
    const mainSender = await mkSender();
    const subSender = await mkSender();
    await assign(fx.mainA, mainSender);
    await assign(fx.subA, subSender);
    assert.equal((await compose(fx.subA, await subGuests(fx.subA, fx.mainA, 1))).status, 200);
    await assign(fx.subA, null);
    assert.equal((await compose(fx.subA, await subGuests(fx.subA, fx.mainA, 1))).status, 200);
    await assign(fx.mainA, null);
    assert.equal((await compose(fx.subA, await subGuests(fx.subA, fx.mainA, 1))).status, 200);
    assert.deepEqual(meta.messages.map((m) => m.phone), [subSender.phoneNumberId, mainSender.phoneNumberId, ENV_PHONE]);
  });

  test("an invalid own sender fails - it does not fall back to the Main Event's or the environment sender", async () => {
    await assign(fx.mainA, await mkSender());
    await assign(fx.subA, await mkSender({ enabled: false }));
    const res = await compose(fx.subA, await subGuests(fx.subA, fx.mainA, 1));
    assert.deepEqual([res.status, res.body.error.code], [409, 'SENDER_UNAVAILABLE']);
    assert.equal(meta.messages.length, 0);
  });

  test('an invalid inherited sender fails - it does not fall back to the environment sender', async () => {
    await assign(fx.mainA, await mkSender({ listedInMeta: false }));
    const res = await compose(fx.subA, await subGuests(fx.subA, fx.mainA, 1));
    assert.deepEqual([res.status, res.body.error.code], [409, 'SENDER_UNAVAILABLE']);
    assert.match(res.body.error.message, /Main Event's WhatsApp sender/);
    assert.equal(meta.messages.length, 0);
  });
});

describe('Legacy campaigns go through the same checks', () => {
  test('an event campaign sends from the effective sender', async () => {
    const s = await mkSender();
    await assign(fx.mainA, s);
    const contacts = await guests(fx.mainA, 3);
    const { res, campaign } = await sendCampaign(fx.mainA, contacts);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const logs = await settled(campaign, 3);
    assert.ok(logs.every((l: any) => l.status === 'Sent'));
    assert.deepEqual(phonesUsed(), [s.phoneNumberId]);
  });

  test('an unassigned event campaign still uses the environment sender', async () => {
    const { res, campaign } = await sendCampaign(fx.mainA, await guests(fx.mainA, 2));
    assert.equal(res.status, 200);
    await settled(campaign, 2);
    assert.deepEqual(phonesUsed(), [ENV_PHONE]);
  });

  test('an ineligible assigned sender blocks the campaign before it is changed', async () => {
    await assign(fx.mainA, await mkSender({ enabled: false }));
    const { res, campaign } = await sendCampaign(fx.mainA, await guests(fx.mainA, 2));
    assert.deepEqual([res.status, res.body.code], [409, 'SENDER_UNAVAILABLE']);
    assert.match(res.body.error, /disabled/);
    const after: any = await Campaign.findById(campaign._id).lean();
    assert.deepEqual([after.status, after.messageText, after.history.length], ['Draft', 'Hello {{fullName}}', 0], 'the campaign keeps its message');
    assert.equal(await MessageLog.countDocuments({ campaignId: campaign._id }), 0);
    assert.equal(meta.messages.length, 0);
  });

  test("decision A applies to campaigns: the owner's Admin must be allowlisted", async () => {
    await assign(fx.mainA, await mkSender({ allowedAdminIds: [fx.adminB._id] }));
    const { res } = await sendCampaign(fx.mainA, await guests(fx.mainA, 1), fx.super);
    assert.deepEqual([res.status, res.body.code], [409, 'SENDER_NOT_ALLOWED']);
  });

  test('a campaign request cannot choose a different sender', async () => {
    const mine = await mkSender();
    const other = await mkSender();
    await assign(fx.mainA, mine);
    const { res, campaign } = await sendCampaign(fx.mainA, await guests(fx.mainA, 1), fx.a, { phoneNumberId: other.phoneNumberId, senderId: String(other._id) });
    assert.equal(res.status, 200);
    await settled(campaign, 1);
    assert.deepEqual(phonesUsed(), [mine.phoneNumberId]);
  });

  test('a sender disabled after queueing stops the remaining batches at the send boundary', async () => {
    const s = await mkSender();
    await assign(fx.mainA, s);
    meta.onMessage = async (count) => { if (count === 10) await WhatsAppSender.updateOne({ _id: s._id }, { $set: { enabled: false } }); };
    const { res, campaign } = await sendCampaign(fx.mainA, await guests(fx.mainA, 12));
    assert.equal(res.status, 200);
    const logs = await settled(campaign, 12);
    assert.equal(logs.filter((l: any) => l.status === 'Sent').length, 10, 'the first batch went out');
    const failed = logs.filter((l: any) => l.status === 'Failed');
    assert.equal(failed.length, 2, 'the second batch did not');
    assert.ok(failed.every((l: any) => /disabled/.test(l.errorReason)));
    assert.equal(meta.messages.length, 10);
  });

  test('a sender reassigned after queueing also stops the remaining batches', async () => {
    const first = await mkSender();
    const second = await mkSender();
    await assign(fx.mainA, first);
    meta.onMessage = async (count) => { if (count === 10) await assign(fx.mainA, second); };
    const { campaign } = await sendCampaign(fx.mainA, await guests(fx.mainA, 12));
    const logs = await settled(campaign, 12);
    const failed = logs.filter((l: any) => l.status === 'Failed');
    assert.equal(failed.length, 2);
    assert.ok(failed.every((l: any) => /changed while messages were being sent/.test(l.errorReason)));
    assert.deepEqual(phonesUsed(), [first.phoneNumberId], 'never switched to the new sender mid-campaign');
  });
});

describe('media is uploaded through the sender that sends it', () => {
  test('uploadMediaToMeta and sendMessage use the given phone number id, else the environment one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er6b-'));
    const file = path.join(dir, 'pic.png');
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    try {
      await whatsappService.uploadMediaToMeta(file, 'image/png', 'pic.png', '222000000000001');
      await whatsappService.uploadMediaToMeta(file, 'image/png', 'pic.png');
      await whatsappService.sendMessage('+919876500001', 'Hi', [], '222000000000001');
      await whatsappService.sendMessage('+919876500002', 'Hi', []);
      await whatsappService.sendMessage('+919876500003', 'Hi', [], undefined);
      assert.deepEqual(meta.media, ['222000000000001', ENV_PHONE]);
      assert.deepEqual(meta.messages.map((m) => m.phone), ['222000000000001', ENV_PHONE, ENV_PHONE]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('decision B: who may edit contact settings', () => {
  const put = (event: any, token: string, body: any = { poc: { name: 'Riya', mobile: '+919876543210' } }) => call('PUT', `/api/events/${event._id}/contact`, token, body);
  const get = (event: any, token: string) => call('GET', `/api/events/${event._id}/contact`, token);

  test('the owning Admin and a Super Admin may edit, on the Main Event and its Sub-Events', async () => {
    for (const event of [fx.mainA, fx.subA]) {
      assert.equal((await put(event, fx.a)).status, 200, `owner on ${event.eventName}`);
      assert.equal((await put(event, fx.super)).status, 200, `Super Admin on ${event.eventName}`);
    }
  });

  test("another Admin who sees the event only through their assigned User can read it but not edit it", async () => {
    for (const event of [fx.mainA, fx.subA]) {
      assert.equal((await get(event, fx.b)).status, 200, `B can read ${event.eventName}`);
      const res = await put(event, fx.b);
      assert.equal(res.status, 403, `B cannot edit ${event.eventName}`);
      assert.match(res.body.error, /owning Admin or a Super Admin/);
    }
    const s = await mkSender({ allowedAdminIds: [fx.adminB._id] });
    assert.equal((await put(fx.mainA, fx.b, { whatsappSenderId: String(s._id) })).status, 403, "B cannot attach B's sender to A's event");
    assert.equal((await Event.findById(fx.mainA._id).lean()).whatsappSenderId, null);
  });

  test('assigned Users can still read the POC; they never edit', async () => {
    await put(fx.mainA, fx.a);
    for (const token of [fx.uA, fx.uB]) {
      const res = await get(fx.mainA, token);
      assert.equal(res.status, 200);
      assert.equal(res.body.poc.name, 'Riya');
      assert.equal((await put(fx.mainA, token)).status, 403);
    }
  });

  test('when the owner cannot be verified, only a Super Admin edits', async () => {
    assert.equal((await put(fx.mismatchSub, fx.a)).status, 403);
    assert.equal((await put(fx.mismatchSub, fx.super)).status, 200);
  });
});

describe('manual "Refresh status" reports what really happened', () => {
  const refresh = (s: any) => call('POST', `/api/whatsapp-senders/${s._id}/refresh-status`, fx.super);

  test('it asks Meta even when the stored status is fresh', async () => {
    const s = await mkSender({ metaStatus: 'CONNECTED' });
    meta.status.set(s.phoneNumberId, 'FLAGGED');
    const res = await refresh(s);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.refreshed, res.body.metaStatus], [true, 'FLAGGED']);
    assert.deepEqual(meta.statusCalls, [s.phoneNumberId]);
    assert.equal((await WhatsAppSender.findById(s._id).lean()).metaStatus, 'FLAGGED');
  });

  test('a second refresh within a minute does not ask Meta, and says the stored status is shown', async () => {
    const s = await mkSender();
    meta.status.set(s.phoneNumberId, 'CONNECTED');
    await refresh(s);
    const again = await refresh(s);
    assert.equal(again.status, 429);
    assert.equal(again.body.refreshed, false);
    assert.match(again.body.error, /stored status is shown/);
    assert.equal(meta.statusCalls.length, 1);
  });

  test('a failed refresh says so and leaves the stored status unchanged', async () => {
    const s = await mkSender({ metaStatus: 'CONNECTED' });
    meta.status.set(s.phoneNumberId, Object.assign(new Error('Request failed'), { response: { status: 500, data: { error: { message: 'internal detail' } } } }));
    const res = await refresh(s);
    assert.equal(res.status, 502);
    assert.equal(res.body.refreshed, false);
    assert.match(res.body.error, /stored status was not changed/);
    assert.equal(res.raw.includes('internal detail'), false);
    assert.equal((await WhatsAppSender.findById(s._id).lean()).metaStatus, 'CONNECTED');
  });

  test('two refreshes at once ask Meta once', async () => {
    const s = await mkSender();
    meta.status.set(s.phoneNumberId, 'CONNECTED');
    const results = await Promise.all([refresh(s), refresh(s)]);
    assert.equal(meta.statusCalls.length, 1);
    assert.ok(results.every((r) => r.status === 200 || r.status === 429));
    assert.ok(results.some((r) => r.body.refreshed === true));
  });

  test('only a Super Admin can refresh', async () => {
    const s = await mkSender();
    assert.equal((await call('POST', `/api/whatsapp-senders/${s._id}/refresh-status`, fx.a)).status, 403);
    assert.equal(meta.statusCalls.length, 0);
  });
});
