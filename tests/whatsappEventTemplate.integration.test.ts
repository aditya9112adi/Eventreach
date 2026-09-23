import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Template sending from the Campaign Composer, over real HTTP.
 *
 * Two apps are mounted against the REAL compiled backend in backend/dist (run
 * `npm run build` in backend/ first):
 *   - the real router, for the guards that must hold regardless of anything
 *     else: no token, another admin's event, the Upcoming-only rule;
 *   - the same handler built with an INJECTED sender, for the multi-recipient
 *     behaviour — who was sent to, who failed, and the duplicate window.
 *
 * The WhatsApp environment variables are removed before the backend is loaded,
 * so nothing here can reach Meta even by accident. No automated test ever sends
 * a real WhatsApp message.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_wa_template_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_ID;
delete process.env.WHATSAPP_WABA_ID;

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const { requireAuth } = require('../backend/dist/middleware/authMiddleware');
const controller = require('../backend/dist/controllers/whatsappController');
const { WhatsAppTemplateError } = require('../backend/dist/services/whatsappTemplateService');
const { Admin } = require('../backend/dist/models/Admin');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');
const { AuditLog } = require('../backend/dist/models/AuditLog');

const PASSWORD_HASH = 'x'.repeat(20);
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let realServer: any;
let mockServer: any;
let realUrl = '';
let mockUrl = '';

/** Every message the injected sender was asked to send. */
let sent: any[] = [];
/** Recipients the injected sender should reject, keyed by phone number. */
let rejectPhones = new Map<string, Error>();
let clock = 1_000_000;

const fakeSend = async (input: any) => {
  const rejection = rejectPhones.get(input.to);
  if (rejection) throw rejection;
  sent.push(input);
  return {
    success: true,
    messageId: `wamid.TEST${sent.length}`,
    status: 'accepted',
    recipient: input.to.replace('+', ''),
  };
};

interface Res {
  status: number;
  body: any;
}

const call = async (
  url: string,
  opts: { method?: string; body?: any; token?: string } = {}
): Promise<Res> => {
  const response = await fetch(url, {
    method: opts.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
};

const makeAdmin = (email: string, role = 'Admin') =>
  Admin.create({
    name: email,
    email,
    passwordHash: PASSWORD_HASH,
    role,
    status: 'Active',
    accessGrantedOn: new Date(),
    accessExpiryDate: new Date(Date.now() + 86_400_000),
  });

const makeEvent = (createdBy: any, overrides: any = {}) =>
  Event.create({
    eventName: 'Wedding',
    eventType: 'wedding',
    eventDate: new Date('2026-09-25T00:00:00.000Z'),
    eventTime: new Date(new Date('2026-09-25T19:00:00.000Z').getTime() - IST_OFFSET_MS),
    eventVenue: 'Grand Palace, Pune',
    organizerName: 'Organizer',
    organizerMobile: 9876543210n,
    eventStatus: 'Upcoming',
    createdBy,
    ...overrides,
  });

const makeGuest = (event: any, createdBy: any, fullName: string, phoneNumber: string, status = 'Valid') =>
  Contact.create({ fullName, phoneNumber, countryCode: '+91', eventId: event._id, status, createdBy });

const sign = (account: any, role: string) =>
  jwt.sign({ id: account._id.toString(), email: account.email, role }, process.env.JWT_SECRET);

before(async () => {
  await mongoose.connect(TEST_DB);

  const realApp = express();
  realApp.use(express.json());
  realApp.use('/api/whatsapp', whatsappRoutes);
  realServer = http.createServer(realApp);
  await new Promise<void>((r) => realServer.listen(0, '127.0.0.1', () => r()));
  realUrl = `http://127.0.0.1:${realServer.address().port}/api/whatsapp/event-template`;

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
  await Promise.all([
    Admin.deleteMany({}),
    Event.deleteMany({}),
    Contact.deleteMany({}),
    AuditLog.deleteMany({}),
  ]);
  controller.clearRecentEventTemplateSends();
  sent = [];
  rejectPhones = new Map();
});

/** An owner, their Upcoming event and three guests of it. */
const fixture = async () => {
  const owner = await makeAdmin('owner@test.test');
  const event = await makeEvent(owner._id);
  const guests = [
    await makeGuest(event, owner._id, 'Shubham Suryavanshi', '+918530808862'),
    await makeGuest(event, owner._id, 'Aditya Kshirsagar', '+919112472833'),
    await makeGuest(event, owner._id, 'Riya Patil', '+919812345678'),
  ];
  return {
    owner,
    event,
    guests,
    token: sign(owner, 'Admin'),
    body: (contactIds: string[]) => ({
      eventId: event._id.toString(),
      contactIds,
      templateName: 'event_reminder',
    }),
  };
};

describe('multiple recipients', () => {
  test('every selected guest is sent to, once each', async () => {
    const f = await fixture();
    const ids = f.guests.map((g: any) => g._id.toString());

    const res = await call(mockUrl, { token: f.token, body: f.body(ids) });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.requestedCount, 3);
    assert.equal(res.body.sentCount, 3);
    assert.equal(res.body.failedCount, 0);
    assert.deepEqual(
      res.body.sent.map((r: any) => r.fullName),
      ['Shubham Suryavanshi', 'Aditya Kshirsagar', 'Riya Patil']
    );
    assert.equal(sent.length, 3);
    assert.deepEqual(
      sent.map((m) => m.to).sort(),
      ['+918530808862', '+919112472833', '+919812345678']
    );
  });

  test('each message carries that guest\'s own values, taken from the database', async () => {
    const f = await fixture();
    const ids = f.guests.map((g: any) => g._id.toString());

    await call(mockUrl, {
      token: f.token,
      // Values in the body must be ignored entirely.
      body: { ...f.body(ids), recipientName: 'HACKED', variables: ['a', 'b', 'c', 'd', 'e'] },
    });

    const byPhone = new Map(sent.map((m) => [m.to, m.variables]));
    assert.deepEqual(byPhone.get('+918530808862'), [
      'Shubham Suryavanshi',
      'Wedding',
      '25 September 2026',
      '7:00 PM',
      'Grand Palace, Pune',
    ]);
    assert.equal(byPhone.get('+919112472833')![0], 'Aditya Kshirsagar');
    assert.equal(byPhone.get('+919812345678')![0], 'Riya Patil');
  });

  test('the same guest listed twice is sent to once', async () => {
    const f = await fixture();
    const id = f.guests[0]._id.toString();

    const res = await call(mockUrl, { token: f.token, body: f.body([id, id, id]) });

    assert.equal(res.status, 200);
    assert.equal(res.body.requestedCount, 1);
    assert.equal(sent.length, 1);
  });

  test('one guest still works, and keeps the single-recipient fields', async () => {
    const f = await fixture();

    const res = await call(mockUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactId: f.guests[0]._id.toString(), templateName: 'event_reminder' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.sentCount, 1);
    assert.equal(res.body.messageId, 'wamid.TEST1');
    assert.equal(res.body.status, 'accepted');
    assert.equal(res.body.sentTo.fullName, 'Shubham Suryavanshi');
  });

  test('more recipients than the ceiling is refused before anything is sent', async () => {
    const f = await fixture();
    const tooMany = Array.from({ length: controller.MAX_TEMPLATE_RECIPIENTS + 1 }, (_, i) =>
      new mongoose.Types.ObjectId().toString()
    );

    const res = await call(mockUrl, { token: f.token, body: f.body(tooMany) });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(sent.length, 0);
  });

  test('an empty selection is refused', async () => {
    const f = await fixture();
    const res = await call(mockUrl, { token: f.token, body: f.body([]) });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /at least one guest/i);
    assert.equal(sent.length, 0);
  });

  test('one audit record per guest, grouped by one bulk operation id', async () => {
    const f = await fixture();
    const ids = f.guests.map((g: any) => g._id.toString());

    const res = await call(mockUrl, { token: f.token, body: f.body(ids) });

    const logs = await AuditLog.find({ action: 'WHATSAPP_TEMPLATE_SENT' }).lean();
    assert.equal(logs.length, 3);
    assert.ok(res.body.bulkOperationId);
    for (const log of logs) {
      assert.equal(log.bulkOperationId, res.body.bulkOperationId);
      assert.equal(log.actor.email, 'owner@test.test');
    }
  });
});

describe('invalid and out-of-scope guests', () => {
  test('a malformed guest id fails that recipient only', async () => {
    const f = await fixture();
    const good = f.guests[0]._id.toString();

    const res = await call(mockUrl, { token: f.token, body: f.body([good, 'not-an-id']) });

    assert.equal(res.status, 207);
    assert.equal(res.body.success, false);
    assert.equal(res.body.sentCount, 1);
    assert.equal(res.body.failed[0].contactId, 'not-an-id');
    assert.equal(res.body.failed[0].code, 'VALIDATION_ERROR');
    assert.equal(sent.length, 1);
  });

  test('a guest of another event cannot be messaged through an event you do own', async () => {
    const f = await fixture();
    const stranger = await makeAdmin('stranger@test.test');
    const otherEvent = await makeEvent(stranger._id, { eventName: 'Other' });
    const outsider = await makeGuest(otherEvent, stranger._id, 'Outsider', '+919800000000');

    const res = await call(mockUrl, {
      token: f.token,
      body: f.body([f.guests[0]._id.toString(), outsider._id.toString()]),
    });

    assert.equal(res.status, 207);
    assert.equal(res.body.failed[0].code, 'CONTACT_NOT_FOUND');
    assert.equal(sent.length, 1);
    assert.ok(!sent.some((m) => m.to === '+919800000000'), 'the outsider must never be messaged');
  });

  test('every guest being unusable answers with that failure, not a success', async () => {
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: f.body([new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString()]),
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.sentCount, 0);
    assert.equal(res.body.failedCount, 2);
    assert.equal(sent.length, 0);
  });
});

describe('authorization', () => {
  test('no token is refused', async () => {
    const f = await fixture();
    const res = await call(realUrl, { body: f.body([f.guests[0]._id.toString()]) });
    assert.equal(res.status, 401);
  });

  test("another admin's event is refused outright, for every recipient", async () => {
    const f = await fixture();
    const stranger = await makeAdmin('stranger@test.test');

    const res = await call(mockUrl, {
      token: sign(stranger, 'Admin'),
      body: f.body(f.guests.map((g: any) => g._id.toString())),
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ACCESS_DENIED');
    assert.equal(sent.length, 0);
  });

  test('a forged SuperAdmin claim buys nothing: the role comes from the database', async () => {
    const f = await fixture();
    const stranger = await makeAdmin('stranger@test.test');
    const forged = jwt.sign(
      { id: stranger._id.toString(), email: stranger.email, role: 'SuperAdmin' },
      process.env.JWT_SECRET
    );

    const res = await call(mockUrl, { token: forged, body: f.body([f.guests[0]._id.toString()]) });

    assert.equal(res.status, 403);
    assert.equal(sent.length, 0);
  });

  test('the Super Admin reaches any event', async () => {
    const f = await fixture();
    const superAdmin = await makeAdmin('super@test.test', 'SuperAdmin');

    const res = await call(mockUrl, {
      token: sign(superAdmin, 'SuperAdmin'),
      body: f.body([f.guests[0]._id.toString()]),
    });

    assert.equal(res.status, 200);
  });
});

describe('Upcoming-only restriction', () => {
  for (const status of ['Completed', 'Cancelled']) {
    test(`a ${status} event is refused, and no guest of it is messaged`, async () => {
      const owner = await makeAdmin('owner@test.test');
      const event = await makeEvent(owner._id, { eventStatus: status });
      const a = await makeGuest(event, owner._id, 'A', '+918530808862');
      const b = await makeGuest(event, owner._id, 'B', '+919112472833');

      const res = await call(mockUrl, {
        token: sign(owner, 'Admin'),
        body: {
          eventId: event._id.toString(),
          contactIds: [a._id.toString(), b._id.toString()],
          templateName: 'event_reminder',
        },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'EVENT_NOT_ACTIVE');
      assert.equal(sent.length, 0, 'nothing may be sent for an event that is not Upcoming');
    });
  }

  test('the restriction is enforced by the real route too, not only the handler', async () => {
    const owner = await makeAdmin('owner@test.test');
    const event = await makeEvent(owner._id, { eventStatus: 'Completed' });
    const guest = await makeGuest(event, owner._id, 'A', '+918530808862');

    const res = await call(realUrl, {
      token: sign(owner, 'Admin'),
      body: {
        eventId: event._id.toString(),
        contactIds: [guest._id.toString()],
        templateName: 'event_reminder',
      },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EVENT_NOT_ACTIVE');
  });

  test('an Upcoming event reaches the send step on the real route', async () => {
    const f = await fixture();

    const res = await call(realUrl, { token: f.token, body: f.body([f.guests[0]._id.toString()]) });

    // 503: authorized and Upcoming, then stopped by the missing WhatsApp
    // configuration — which is also proof the send happens server-side.
    assert.equal(res.status, 503);
    assert.equal(res.body.failed[0].code, 'CONFIGURATION_ERROR');
    assert.match(res.body.failed[0].reason, /WHATSAPP_TOKEN/);
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('bearer'), 'no credential material in the response');
  });

  test('an unknown template is refused', async () => {
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: { ...f.body([f.guests[0]._id.toString()]), templateName: 'marketing_blast' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNKNOWN_TEMPLATE');
  });
});

describe('partial failure', () => {
  test('one rejection by Meta does not stop the other guests', async () => {
    const f = await fixture();
    rejectPhones.set(
      '+919112472833',
      new WhatsAppTemplateError('RECIPIENT_NOT_ALLOWED', 'This number cannot receive messages.', 400, {
        meta: { code: 131030 },
      })
    );

    const res = await call(mockUrl, {
      token: f.token,
      body: f.body(f.guests.map((g: any) => g._id.toString())),
    });

    assert.equal(res.status, 207);
    assert.equal(res.body.success, false, 'a partial failure is never reported as a success');
    assert.equal(res.body.sentCount, 2);
    assert.equal(res.body.failedCount, 1);
    assert.equal(res.body.failed[0].fullName, 'Aditya Kshirsagar');
    assert.equal(res.body.failed[0].code, 'RECIPIENT_NOT_ALLOWED');
    assert.equal(sent.length, 2);
  });

  test('a failed recipient is audited as not sent — only the successes are logged', async () => {
    const f = await fixture();
    rejectPhones.set(
      '+919112472833',
      new WhatsAppTemplateError('RECIPIENT_NOT_ALLOWED', 'This number cannot receive messages.', 400)
    );

    await call(mockUrl, { token: f.token, body: f.body(f.guests.map((g: any) => g._id.toString())) });

    const logs = await AuditLog.find({ action: 'WHATSAPP_TEMPLATE_SENT' }).lean();
    assert.equal(logs.length, 2);
    assert.ok(
      !logs.some((log: any) => log.documentId === f.guests[1]._id.toString()),
      'the guest that was not messaged must not be logged as sent'
    );
  });
});

describe('duplicate prevention', () => {
  test('sending the same guest again inside the window is refused', async () => {
    const f = await fixture();
    const id = f.guests[0]._id.toString();

    assert.equal((await call(mockUrl, { token: f.token, body: f.body([id]) })).status, 200);
    const second = await call(mockUrl, { token: f.token, body: f.body([id]) });

    assert.equal(second.status, 409);
    assert.equal(second.body.failed[0].code, 'DUPLICATE_SEND');
    assert.equal(sent.length, 1);
  });

  test('a guest already messaged is skipped while the rest of the batch goes out', async () => {
    const f = await fixture();
    const [a, b, c] = f.guests.map((g: any) => g._id.toString());

    await call(mockUrl, { token: f.token, body: f.body([a]) });
    const res = await call(mockUrl, { token: f.token, body: f.body([a, b, c]) });

    assert.equal(res.status, 207);
    assert.equal(res.body.sentCount, 2);
    assert.equal(res.body.failed[0].code, 'DUPLICATE_SEND');
    assert.equal(sent.length, 3, 'a and then b, c — a is never sent twice');
  });

  test('two identical requests racing each other send once per guest', async () => {
    const f = await fixture();
    const ids = f.guests.map((g: any) => g._id.toString());

    const [first, second] = await Promise.all([
      call(mockUrl, { token: f.token, body: f.body(ids) }),
      call(mockUrl, { token: f.token, body: f.body(ids) }),
    ]);

    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(sent.length, 3);
  });

  test('a failed send does not block the retry', async () => {
    const f = await fixture();
    const id = f.guests[0]._id.toString();
    rejectPhones.set('+918530808862', new WhatsAppTemplateError('NETWORK_ERROR', 'Could not reach WhatsApp.', 504));

    assert.equal((await call(mockUrl, { token: f.token, body: f.body([id]) })).status, 504);
    rejectPhones.clear();

    const retry = await call(mockUrl, { token: f.token, body: f.body([id]) });
    assert.equal(retry.status, 200);
  });

  test('the window expires', async () => {
    const f = await fixture();
    const id = f.guests[0]._id.toString();

    assert.equal((await call(mockUrl, { token: f.token, body: f.body([id]) })).status, 200);
    clock += controller.DUPLICATE_SEND_WINDOW_MS + 1_000;
    assert.equal((await call(mockUrl, { token: f.token, body: f.body([id]) })).status, 200);
    assert.equal(sent.length, 2);
  });
});
