import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * WhatsApp campaign reporting, end to end against the REAL compiled backend
 * (routes, controllers, services, Mongoose models from backend/dist) on a
 * throwaway local database.
 *
 * Covers the full lifecycle a recipient goes through:
 *   Pending -> Sent (accepted by WhatsApp) -> Delivered -> Read
 *   Pending -> Failed              (Meta rejected the send call outright)
 *   Sent    -> Failed              (Meta reported an async failure later)
 *
 * The distinction that matters throughout: a 2xx from the send call means
 * WhatsApp ACCEPTED the message, never that a handset received it. Delivery
 * is only ever known from the webhook.
 *
 * Meta is never contacted — axios is stubbed at the module object, the same
 * singleton instance the compiled service holds.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_wareport_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.FRONTEND_URL = 'http://localhost:5173';
// Force the service into PRODUCTION mode so the real Meta code path runs
// (against a stubbed axios), not the mock sender.
process.env.WHATSAPP_TOKEN = 'test-token-not-a-real-secret';
process.env.WHATSAPP_PHONE_ID = '111111111111111';
process.env.WHATSAPP_API_VERSION = 'v25.0';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
delete process.env.WHATSAPP_APP_SECRET; // signature checking covered separately

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const axios = require('axios');

const reportRoutes = require('../backend/dist/routes/reportRoutes').default;
const webhookRoutes = require('../backend/dist/routes/webhookRoutes').default;
const { MessageLog } = require('../backend/dist/models/MessageLog');
const { Campaign } = require('../backend/dist/models/Campaign');
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { Admin } = require('../backend/dist/models/Admin');
const { queueService } = require('../backend/dist/services/QueueService');
const jwt = require('jsonwebtoken');

let server: any;
let baseUrl = '';
let adminToken = '';
let eventId: any;

const originalAxiosPost = axios.post;

const call = (
  method: string,
  path: string,
  opts: { body?: any; token?: string; raw?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; text: string }> =>
  new Promise((resolve, reject) => {
    const payload = opts.raw !== undefined ? opts.raw : opts.body ? JSON.stringify(opts.body) : null;
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (payload !== null) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
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
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
          resolve({ status: res.statusCode || 0, body: parsed, text: data });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });

/** Makes the next N Meta send calls succeed, returning sequential wamids. */
const stubMetaAccepts = () => {
  const issued: string[] = [];
  axios.post = async (_url: string, body: any) => {
    const wamid = `wamid.TEST${issued.length + 1}`;
    issued.push(wamid);
    return {
      data: {
        messaging_product: 'whatsapp',
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: wamid, message_status: 'accepted' }],
      },
    };
  };
  return issued;
};

/** Makes every Meta send call fail the way Meta actually reports a rejection. */
const stubMetaRejects = (code: number, message: string) => {
  axios.post = async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { status: 400, data: { error: { message, code, type: 'OAuthException' } } };
    throw err;
  };
};

const seedCampaignWithContacts = async (names: string[]) => {
  const campaign = await Campaign.create({ eventId, messageText: 'Hi {{fullName}}, see you at {{eventName}}!', status: 'Draft' });
  for (const [i, name] of names.entries()) {
    await Contact.create({
      fullName: name,
      phoneNumber: `+9199999900${String(i).padStart(2, '0')}`,
      countryCode: 'IN',
      eventId,
      source: 'Manual',
      status: 'Valid',
    });
  }
  return campaign;
};

/** Runs a campaign and waits for the detached batch processing to finish. */
const runCampaign = async (campaign: any) => {
  await queueService.processCampaign(String(campaign._id), undefined, campaign.messageText, []);
  // processBatch is intentionally fire-and-forget; poll until it settles.
  for (let i = 0; i < 60; i++) {
    const pending = await MessageLog.countDocuments({ campaignId: campaign._id, status: 'Pending' });
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('campaign did not finish processing in time');
};

const webhookStatus = (wamid: string, status: string, extra: Record<string, any> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA_ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }],
      },
    }],
  }],
});

before(async () => {
  await mongoose.connect(TEST_DB);

  const admin = await Admin.create({
    name: 'Admin', email: 'wa-admin@example.com',
    passwordHash: await bcrypt.hash('TestPass123', 10),
    role: 'SuperAdmin', status: 'Active', accessGrantedOn: new Date(),
  });
  adminToken = jwt.sign({ id: admin._id, email: admin.email, role: 'SuperAdmin' }, process.env.JWT_SECRET, { expiresIn: '1d' });

  const event = await Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'),
    eventName: 'Gala', eventType: 'Party',
    eventDate: new Date('2026-12-01T00:00:00.000Z'),
    eventTime: new Date('2026-12-01T18:30:00+05:30'),
    eventVenue: 'Hall', eventStatus: 'Upcoming',
  });
  eventId = event._id;

  const app = express();
  app.set('trust proxy', 1);
  // Mirrors server.ts: the webhook is mounted with a raw body parser, ahead
  // of express.json(), because the signature is computed over raw bytes.
  app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
  app.use(express.json());
  app.use('/api/reports', reportRoutes);

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  axios.post = originalAxiosPost;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  axios.post = originalAxiosPost;
  await Promise.all([MessageLog.deleteMany({}), Campaign.deleteMany({}), Contact.deleteMany({})]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MessageLog creation', () => {
  test('every recipient gets a log row, with name and phone recorded', async () => {
    stubMetaAccepts();
    const campaign = await seedCampaignWithContacts(['Asha', 'Ravi', 'Neha']);
    await runCampaign(campaign);

    const logs = await MessageLog.find({ campaignId: campaign._id }).lean();
    assert.equal(logs.length, 3, 'one row per recipient');
    for (const log of logs) {
      assert.ok(log.contactName, 'recipient name is denormalised onto the log');
      assert.ok(log.phoneNumber, 'phone recorded');
      assert.ok(log.contactId, 'contact linked');
      assert.ok(log.createdAt instanceof Date);
    }
  });

  test('the personalised message text is stored per recipient', async () => {
    stubMetaAccepts();
    const campaign = await seedCampaignWithContacts(['Asha']);
    await runCampaign(campaign);

    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    assert.match(log.messageText, /Hi Asha/, 'variables are interpolated per recipient');
    assert.match(log.messageText, /Gala/);
  });
});

describe('Successful acceptance by Meta', () => {
  test('stores the wamid and sentAt, and marks Sent — not Delivered', async () => {
    stubMetaAccepts();
    const campaign = await seedCampaignWithContacts(['Asha']);
    await runCampaign(campaign);

    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    assert.equal(log.status, 'Sent', "'Sent' is the accepted state");
    assert.match(log.wamid, /^wamid\./, 'wamid stored for webhook correlation');
    assert.ok(log.sentAt instanceof Date);
    assert.equal(log.deliveredAt, undefined, 'HTTP 200 must NOT imply delivery');
    assert.equal(log.readAt, undefined);
    assert.equal(log.failedAt, undefined);
    assert.equal(log.errorCode, undefined);
  });
});

describe('Synchronous Meta failure', () => {
  test('records Meta error code and reason, and marks Failed', async () => {
    // 131047 is what Meta returns for a free-form message outside the
    // 24-hour customer service window.
    stubMetaRejects(131047, 'Message failed to send because more than 24 hours have passed since the customer last replied');
    const campaign = await seedCampaignWithContacts(['Asha']);
    await runCampaign(campaign);

    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    assert.equal(log.status, 'Failed');
    assert.equal(log.errorCode, 131047, "Meta's numeric code is preserved");
    assert.match(log.errorReason, /24 hours/);
    assert.ok(log.failedAt instanceof Date);
    assert.equal(log.wamid, undefined, 'a rejected send never gets a wamid');
  });
});

describe('Webhook verification (GET)', () => {
  test('echoes the challenge when the verify token matches', async () => {
    const res = await call('GET', '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123');
    assert.equal(res.status, 200);
    assert.equal(res.text, 'abc123', 'must be the bare challenge, not JSON');
  });

  test('rejects a wrong verify token', async () => {
    const res = await call('GET', '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123');
    assert.equal(res.status, 403);
    assert.notEqual(res.text, 'abc123');
  });

  test('rejects a wrong mode', async () => {
    const res = await call('GET', '/api/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=abc123');
    assert.equal(res.status, 403);
  });
});

describe('Webhook status updates (POST)', () => {
  const waitFor = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  };

  const sendOneAndGetWamid = async () => {
    stubMetaAccepts();
    const campaign = await seedCampaignWithContacts(['Asha']);
    await runCampaign(campaign);
    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    return { campaign, wamid: log.wamid, logId: log._id };
  };

  test('delivered: sets Delivered and deliveredAt, correlated by wamid', async () => {
    const { wamid, logId } = await sendOneAndGetWamid();

    const res = await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus(wamid, 'delivered') });
    assert.equal(res.status, 200, 'must ack quickly so Meta does not retry');

    const applied = await waitFor(async () => {
      const l = await MessageLog.findById(logId).lean();
      return l.status === 'Delivered' && !!l.deliveredAt;
    });
    assert.ok(applied, 'delivery must be recorded');

    const log = await MessageLog.findById(logId).lean();
    assert.ok(log.deliveredAt instanceof Date);
    assert.equal(log.readAt, undefined, 'delivered is not read');
  });

  test('read: sets readAt and implies delivered', async () => {
    const { wamid, logId } = await sendOneAndGetWamid();
    await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus(wamid, 'read') });

    const applied = await waitFor(async () => !!(await MessageLog.findById(logId).lean()).readAt);
    assert.ok(applied, 'read receipt must be recorded');

    const log = await MessageLog.findById(logId).lean();
    assert.ok(log.readAt instanceof Date);
    assert.ok(log.deliveredAt instanceof Date, 'a read message is necessarily delivered');
    assert.equal(log.status, 'Delivered');
  });

  test('failed: records Meta error code and reason on an already-accepted message', async () => {
    const { wamid, logId } = await sendOneAndGetWamid();
    assert.equal((await MessageLog.findById(logId).lean()).status, 'Sent');

    await call('POST', '/api/webhooks/whatsapp', {
      body: webhookStatus(wamid, 'failed', {
        errors: [{ code: 131047, title: 'Re-engagement message', message: 'Outside the 24 hour window' }],
      }),
    });

    const applied = await waitFor(async () => (await MessageLog.findById(logId).lean()).status === 'Failed');
    assert.ok(applied, 'an async failure must override the accepted state');

    const log = await MessageLog.findById(logId).lean();
    assert.equal(log.errorCode, 131047);
    assert.match(log.errorReason, /Re-engagement/);
    assert.ok(log.failedAt instanceof Date);
  });

  test('a late out-of-order callback never walks the status backwards', async () => {
    const { wamid, logId } = await sendOneAndGetWamid();

    await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus(wamid, 'delivered') });
    await waitFor(async () => (await MessageLog.findById(logId).lean()).status === 'Delivered');

    // Meta does not guarantee ordering: a 'sent' can arrive after 'delivered'.
    await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus(wamid, 'sent') });
    await new Promise((r) => setTimeout(r, 300));

    const log = await MessageLog.findById(logId).lean();
    assert.equal(log.status, 'Delivered', 'must not regress to Sent');
  });

  /**
   * A 'failed' callback may overtake an accepted message — that is the real
   * 131047 case — but must never overturn a confirmed delivery. Once WhatsApp
   * has said the message reached the device it cannot subsequently have
   * failed, so a late or replayed 'failed' there is spurious and would
   * misreport a message the recipient received, or had already opened.
   */
  describe('a late failed callback cannot overturn a confirmed delivery', () => {
    const failedEvent = (wamid: string) =>
      webhookStatus(wamid, 'failed', { errors: [{ code: 131047, title: 'Re-engagement message' }] });

    test('Sent -> Failed is allowed', async () => {
      const { wamid, logId } = await sendOneAndGetWamid();
      assert.equal((await MessageLog.findById(logId).lean()).status, 'Sent');

      await call('POST', '/api/webhooks/whatsapp', { body: failedEvent(wamid) });
      const applied = await waitFor(async () => (await MessageLog.findById(logId).lean()).status === 'Failed');

      assert.ok(applied, 'an async failure must still override a merely accepted message');
      const log = await MessageLog.findById(logId).lean();
      assert.equal(log.errorCode, 131047);
      assert.ok(log.failedAt instanceof Date);
    });

    test('Delivered -> Failed is ignored, and deliveredAt is preserved', async () => {
      const { wamid, logId } = await sendOneAndGetWamid();
      await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus(wamid, 'delivered') });
      await waitFor(async () => (await MessageLog.findById(logId).lean()).status === 'Delivered');
      const beforeDeliveredAt = (await MessageLog.findById(logId).lean()).deliveredAt;

      await call('POST', '/api/webhooks/whatsapp', { body: failedEvent(wamid) });
      await new Promise((r) => setTimeout(r, 300));

      const log = await MessageLog.findById(logId).lean();
      assert.equal(log.status, 'Delivered', 'a delivered message must not be reported as failed');
      assert.equal(log.deliveredAt.getTime(), beforeDeliveredAt.getTime(), 'deliveredAt preserved');
      // Ignored outright, not merely blocked from changing the status: a
      // failure stamp beside a delivered message would contradict itself.
      assert.equal(log.failedAt, undefined, 'no failure timestamp is recorded');
      assert.equal(log.errorCode, undefined, 'no error code is recorded');
      assert.equal(log.errorReason, undefined);
    });

    test('Read -> Failed is ignored, and readAt is preserved', async () => {
      const { wamid, logId } = await sendOneAndGetWamid();
      await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus(wamid, 'read') });
      await waitFor(async () => !!(await MessageLog.findById(logId).lean()).readAt);
      const before = await MessageLog.findById(logId).lean();

      await call('POST', '/api/webhooks/whatsapp', { body: failedEvent(wamid) });
      await new Promise((r) => setTimeout(r, 300));

      const log = await MessageLog.findById(logId).lean();
      assert.equal(log.status, 'Delivered', 'a read message must not be reported as failed');
      assert.equal(log.readAt.getTime(), before.readAt.getTime(), 'readAt preserved');
      assert.equal(log.deliveredAt.getTime(), before.deliveredAt.getTime(), 'deliveredAt preserved');
      assert.equal(log.failedAt, undefined);
      assert.equal(log.errorCode, undefined);
    });

    test('a duplicate failed callback stays idempotent', async () => {
      const { wamid, logId } = await sendOneAndGetWamid();

      await call('POST', '/api/webhooks/whatsapp', { body: failedEvent(wamid) });
      await waitFor(async () => (await MessageLog.findById(logId).lean()).status === 'Failed');
      const first = await MessageLog.findById(logId).lean();

      await new Promise((r) => setTimeout(r, 40));
      await call('POST', '/api/webhooks/whatsapp', { body: failedEvent(wamid) });
      await new Promise((r) => setTimeout(r, 300));
      const second = await MessageLog.findById(logId).lean();

      assert.equal(second.status, 'Failed');
      assert.equal(second.failedAt.getTime(), first.failedAt.getTime(), 'failedAt is not rewritten');
      assert.equal(second.updatedAt.getTime(), first.updatedAt.getTime(), 'no redundant write at all');
    });
  });

  test('an unknown wamid is ignored without error', async () => {
    const res = await call('POST', '/api/webhooks/whatsapp', { body: webhookStatus('wamid.NOT_OURS', 'delivered') });
    assert.equal(res.status, 200, 'still acked, so Meta does not retry forever');
  });

  test('malformed JSON is rejected, not crashed on', async () => {
    const res = await call('POST', '/api/webhooks/whatsapp', { raw: '{not json' });
    assert.equal(res.status, 400);
  });
});

/**
 * The webhook writes to MessageLog, so an unauthenticated version of it is an
 * open write surface. In production it therefore fails CLOSED: without an app
 * secret there is no way to tell Meta's callbacks from anyone else's.
 */
describe('Webhook signature enforcement', () => {
  const crypto = require('crypto');
  const APP_SECRET = 'test-app-secret-not-real';

  const seedAcceptedLog = async (wamid: string) => {
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Completed' });
    const contact = await Contact.create({
      fullName: 'Sig', phoneNumber: `+9166666${Math.floor(Math.random() * 90000 + 10000)}`,
      countryCode: 'IN', eventId, source: 'Manual', status: 'Valid',
    });
    return MessageLog.create({
      campaignId: campaign._id, contactId: contact._id, phoneNumber: contact.phoneNumber,
      wamid, status: 'Sent', sentAt: new Date(),
    });
  };

  const body = (wamid: string) => JSON.stringify(webhookStatus(wamid, 'delivered'));
  const sign = (raw: string, secret: string) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex');

  /** Runs fn with NODE_ENV/APP_SECRET set, always restoring them afterwards. */
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test('production without WHATSAPP_APP_SECRET refuses the callback and changes nothing', async () => {
    await withEnv({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: undefined }, async () => {
      const log = await seedAcceptedLog('wamid.PROD_NO_SECRET');
      const raw = body('wamid.PROD_NO_SECRET');

      const res = await call('POST', '/api/webhooks/whatsapp', { raw });
      assert.equal(res.status, 503, 'a missing app secret is a configuration fault, not a caller fault');

      await new Promise((r) => setTimeout(r, 250));
      const after = await MessageLog.findById(log._id).lean();
      assert.equal(after.status, 'Sent', 'MessageLog must not be updated');
      assert.equal(after.deliveredAt, undefined);
    });
  });

  test('production with the secret set rejects a missing or wrong signature', async () => {
    await withEnv({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: APP_SECRET }, async () => {
      const log = await seedAcceptedLog('wamid.PROD_BAD_SIG');
      const raw = body('wamid.PROD_BAD_SIG');

      assert.equal((await call('POST', '/api/webhooks/whatsapp', { raw })).status, 403, 'no signature');
      assert.equal(
        (await call('POST', '/api/webhooks/whatsapp', { raw, headers: { 'X-Hub-Signature-256': 'sha256=' + 'a'.repeat(64) } })).status,
        403, 'wrong signature'
      );
      assert.equal(
        (await call('POST', '/api/webhooks/whatsapp', { raw, headers: { 'X-Hub-Signature-256': sign(raw, 'the-wrong-secret') } })).status,
        403, 'signature computed with the wrong secret'
      );

      await new Promise((r) => setTimeout(r, 250));
      const after = await MessageLog.findById(log._id).lean();
      assert.equal(after.status, 'Sent', 'no rejected payload may update a MessageLog');
      assert.equal(after.deliveredAt, undefined);
    });
  });

  test('production with a valid signature processes normally', async () => {
    await withEnv({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: APP_SECRET }, async () => {
      const log = await seedAcceptedLog('wamid.PROD_GOOD_SIG');
      const raw = body('wamid.PROD_GOOD_SIG');

      const res = await call('POST', '/api/webhooks/whatsapp', {
        raw, headers: { 'X-Hub-Signature-256': sign(raw, APP_SECRET) },
      });
      assert.equal(res.status, 200);

      for (let i = 0; i < 50; i++) {
        const l = await MessageLog.findById(log._id).lean();
        if (l.status === 'Delivered' && l.deliveredAt) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.fail('a correctly signed payload must be applied');
    });
  });

  test('outside production it stays usable without an app secret, for local testing', async () => {
    await withEnv({ NODE_ENV: 'development', WHATSAPP_APP_SECRET: undefined }, async () => {
      const log = await seedAcceptedLog('wamid.DEV_NO_SECRET');
      const res = await call('POST', '/api/webhooks/whatsapp', { raw: body('wamid.DEV_NO_SECRET') });
      assert.equal(res.status, 200);

      for (let i = 0; i < 50; i++) {
        const l = await MessageLog.findById(log._id).lean();
        if (l.status === 'Delivered') return;
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.fail('development must not require the app secret');
    });
  });

  test('neither the secret nor the expected signature is ever echoed in a response', async () => {
    await withEnv({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: APP_SECRET }, async () => {
      const raw = body('wamid.LEAK_CHECK');
      const rejected = await call('POST', '/api/webhooks/whatsapp', { raw });
      assert.doesNotMatch(rejected.text, new RegExp(APP_SECRET));
      assert.doesNotMatch(rejected.text, /sha256=/);
    });

    await withEnv({ NODE_ENV: 'production', WHATSAPP_APP_SECRET: undefined }, async () => {
      const refused = await call('POST', '/api/webhooks/whatsapp', { raw: body('wamid.LEAK_CHECK2') });
      assert.doesNotMatch(refused.text, /SECRET|sha256=/i);
    });
  });
});

describe('Report aggregation', () => {
  test('summarises a campaign with mixed Pending/Sent/Delivered/Read/Failed', async () => {
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Completed' });
    const mk = async (over: Record<string, any>) => {
      const c = await Contact.create({
        fullName: `C${Math.random().toString(36).slice(2, 7)}`,
        phoneNumber: `+9188888${Math.floor(Math.random() * 90000 + 10000)}`,
        countryCode: 'IN', eventId, source: 'Manual', status: 'Valid',
      });
      return MessageLog.create({ campaignId: campaign._id, contactId: c._id, contactName: c.fullName, phoneNumber: c.phoneNumber, ...over });
    };

    await mk({ status: 'Pending' });
    await mk({ status: 'Sent', wamid: 'wamid.A', sentAt: new Date() });
    await mk({ status: 'Delivered', wamid: 'wamid.B', sentAt: new Date(), deliveredAt: new Date() });
    await mk({ status: 'Delivered', wamid: 'wamid.C', sentAt: new Date(), deliveredAt: new Date(), readAt: new Date() });
    await mk({ status: 'Failed', errorCode: 131047, errorReason: 'Outside window', failedAt: new Date() });

    const res = await call('GET', `/api/reports/campaign/${campaign._id}/stats`, { token: adminToken });
    assert.equal(res.status, 200);

    const s = res.body.summary;
    assert.equal(s.total, 5);
    assert.equal(s.pending, 1);
    assert.equal(s.accepted, 3, 'three messages reached WhatsApp');
    assert.equal(s.delivered, 2, 'delivered counts the read one too');
    assert.equal(s.read, 1);
    assert.equal(s.failed, 1);
    assert.equal(res.body.hasDeliveryData, true);
    // Accepted, not delivered, is what the send call can prove.
    assert.equal(res.body.successRate, 60);
    assert.equal(res.body.deliveryRate, 40);
  });

  test('per-recipient logs expose every milestone timestamp and the error code', async () => {
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Completed' });
    const c = await Contact.create({
      fullName: 'Asha', phoneNumber: '+919112472833', countryCode: 'IN',
      eventId, source: 'Manual', status: 'Valid',
    });
    await MessageLog.create({
      campaignId: campaign._id, contactId: c._id, contactName: 'Asha', phoneNumber: c.phoneNumber,
      status: 'Failed', wamid: 'wamid.X', errorCode: 131026, errorReason: 'Message undeliverable',
      sentAt: new Date(), failedAt: new Date(),
    });

    const res = await call('GET', `/api/reports/campaign/${campaign._id}/logs`, { token: adminToken });
    assert.equal(res.status, 200);
    const log = res.body.logs[0];
    assert.equal(log.contactName, 'Asha');
    assert.equal(log.errorCode, 131026);
    assert.equal(log.errorReason, 'Message undeliverable');
    assert.ok(log.sentAt);
    assert.ok(log.failedAt);
    assert.equal(log.deliveredAt, undefined);
  });

  test('filters by Read, which is a timestamp rather than a status value', async () => {
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Completed' });
    const mk = async (over: Record<string, any>) => {
      const c = await Contact.create({
        fullName: 'X', phoneNumber: `+9177777${Math.floor(Math.random() * 90000 + 10000)}`,
        countryCode: 'IN', eventId, source: 'Manual', status: 'Valid',
      });
      return MessageLog.create({ campaignId: campaign._id, contactId: c._id, phoneNumber: c.phoneNumber, ...over });
    };
    await mk({ status: 'Delivered', deliveredAt: new Date() });
    await mk({ status: 'Delivered', deliveredAt: new Date(), readAt: new Date() });

    const res = await call('GET', `/api/reports/campaign/${campaign._id}/logs?status=Read`, { token: adminToken });
    assert.equal(res.body.logs.length, 1, 'only the opened message');
    assert.ok(res.body.logs[0].readAt);
  });

  test('an empty campaign reports zeroes rather than failing', async () => {
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });

    const stats = await call('GET', `/api/reports/campaign/${campaign._id}/stats`, { token: adminToken });
    assert.equal(stats.status, 200);
    assert.equal(stats.body.total, 0);
    assert.equal(stats.body.summary.accepted, 0);
    assert.equal(stats.body.successRate, 0, 'no division by zero');
    assert.equal(stats.body.deliveryRate, 0);
    assert.equal(stats.body.hasDeliveryData, false);

    const logs = await call('GET', `/api/reports/campaign/${campaign._id}/logs`, { token: adminToken });
    assert.equal(logs.status, 200);
    assert.deepEqual(logs.body.logs, []);
    assert.equal(logs.body.pagination.total, 0);
  });
});
