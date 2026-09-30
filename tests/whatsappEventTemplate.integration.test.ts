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

// ── media templates: the header file ─────────────────────────────────────────

/**
 * A template whose approved header is a document, image or video needs a file
 * on every send. The file is uploaded to Meta ONCE per request and the media
 * id reused for every recipient, exactly as campaign media is.
 *
 * The catalog lookup is what tells us the header format, so these tests set
 * WHATSAPP_WABA_ID for their duration only — the tests above deliberately run
 * without it, and must keep behaving as they do.
 */
describe('media templates', () => {
  const axios = require('axios');
  const fsNode = require('node:fs');
  const pathNode = require('node:path');
  const { UPLOAD_DIR } = require('../backend/dist/middleware/mediaUpload');
  const { clearTemplateCatalogCache } = require('../backend/dist/services/whatsappTemplateCatalog');

  const originalGet = axios.get;
  let headerFormat: string | null = 'DOCUMENT';
  const files: string[] = [];

  /** A real file on disk, as the upload endpoint would have left one. */
  const storedFile = (name: string, bytes: Buffer) => {
    const fileName = `tpl-${Date.now()}-${name}`;
    fsNode.mkdirSync(UPLOAD_DIR, { recursive: true });
    fsNode.writeFileSync(pathNode.join(UPLOAD_DIR, fileName), bytes);
    files.push(fileName);
    return { url: `/uploads/${fileName}`, filename: name };
  };

  const PDF = () => storedFile('Invite.pdf', Buffer.from('%PDF-1.4\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
  const PNG = () => storedFile('photo.png', Buffer.from('89504e470d0a1a0a', 'hex'));

  before(() => {
    process.env.WHATSAPP_WABA_ID = 'WABA_ID_FOR_TEST';
    process.env.WHATSAPP_TOKEN = 'placeholder-not-a-real-token';
    axios.get = async () => ({
      data: {
        data: [
          {
            name: 'event_reminder',
            language: 'en',
            status: 'APPROVED',
            components: [
              ...(headerFormat ? [{ type: 'HEADER', format: headerFormat }] : []),
              { type: 'BODY', text: 'Hi {{1}}, {{2}} is on {{3}} at {{4}}. Venue: {{5}}.' },
            ],
          },
        ],
      },
    });
  });

  after(() => {
    axios.get = originalGet;
    delete process.env.WHATSAPP_WABA_ID;
    delete process.env.WHATSAPP_TOKEN;
    for (const f of files) {
      try {
        fsNode.unlinkSync(pathNode.join(UPLOAD_DIR, f));
      } catch {
        /* already gone */
      }
    }
  });

  beforeEach(() => {
    headerFormat = 'DOCUMENT';
    clearTemplateCatalogCache();
  });

  test('the attachment becomes the header media, and every recipient shares one upload', async () => {
    const f = await fixture();
    const attachment = PDF();

    const res = await call(mockUrl, {
      token: f.token,
      body: { ...f.body(f.guests.map((g: any) => g._id.toString())), attachment },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.sentCount, 3);
    assert.equal(res.body.headerMedia.kind, 'document');
    assert.equal(res.body.headerMedia.filename, 'Invite.pdf');

    assert.equal(sent.length, 3);
    for (const message of sent) {
      assert.equal(message.headerMedia.kind, 'document');
      assert.equal(message.headerMedia.filename, 'Invite.pdf', 'the recipient must see a filename, not a media id');
    }
    assert.equal(
      new Set(sent.map((m: any) => m.headerMedia.mediaId)).size,
      1,
      'one upload for the whole request, reused for every recipient'
    );
  });

  test('a media template with no attachment is refused, and nothing is sent', async () => {
    const f = await fixture();
    const res = await call(mockUrl, { token: f.token, body: f.body([f.guests[0]._id.toString()]) });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'ATTACHMENT_REQUIRED');
    assert.match(res.body.error.message, /document/i);
    assert.equal(sent.length, 0);
  });

  test('a file of the wrong kind for the header is refused', async () => {
    const f = await fixture();
    const attachment = PNG(); // an image, for a DOCUMENT header

    const res = await call(mockUrl, {
      token: f.token,
      body: { ...f.body([f.guests[0]._id.toString()]), attachment },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(sent.length, 0);
  });

  test('an image header accepts an image', async () => {
    headerFormat = 'IMAGE';
    clearTemplateCatalogCache();
    const f = await fixture();

    const res = await call(mockUrl, {
      token: f.token,
      body: { ...f.body([f.guests[0]._id.toString()]), attachment: PNG() },
    });

    assert.equal(res.status, 200);
    assert.equal(sent[0].headerMedia.kind, 'image');
    assert.equal(sent[0].headerMedia.filename, undefined, 'only a document carries a filename');
  });

  test('a template with no media header refuses an attachment rather than ignoring it', async () => {
    headerFormat = null;
    clearTemplateCatalogCache();
    const f = await fixture();

    const res = await call(mockUrl, {
      token: f.token,
      body: { ...f.body([f.guests[0]._id.toString()]), attachment: PDF() },
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /no media header/i);
    assert.equal(sent.length, 0);
  });

  test('a text-only template still sends with no header component', async () => {
    headerFormat = null;
    clearTemplateCatalogCache();
    const f = await fixture();

    const res = await call(mockUrl, { token: f.token, body: f.body([f.guests[0]._id.toString()]) });

    assert.equal(res.status, 200);
    assert.equal(sent[0].headerMedia, undefined, 'nothing extra is sent for a plain template');
    assert.equal(res.body.headerMedia, null);
  });

  test('a file that is no longer on the server is reported plainly', async () => {
    const f = await fixture();
    const attachment = { url: '/uploads/gone-forever.pdf', filename: 'gone-forever.pdf' };

    const res = await call(mockUrl, {
      token: f.token,
      body: { ...f.body([f.guests[0]._id.toString()]), attachment },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'ATTACHMENT_MISSING');
    assert.match(res.body.error.message, /re-upload/i);
    assert.equal(sent.length, 0);
  });

  test('without WHATSAPP_WABA_ID an attachment is refused, naming what is missing', async () => {
    delete process.env.WHATSAPP_WABA_ID;
    clearTemplateCatalogCache();
    const f = await fixture();

    const res = await call(mockUrl, {
      token: f.token,
      body: { ...f.body([f.guests[0]._id.toString()]), attachment: PDF() },
    });

    process.env.WHATSAPP_WABA_ID = 'WABA_ID_FOR_TEST';
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'CONFIGURATION_ERROR');
    assert.match(res.body.error.message, /WHATSAPP_WABA_ID/);
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('bearer'), 'no credential material');
    assert.equal(sent.length, 0);
  });

  test('the Upcoming-only rule and authorization still come first', async () => {
    const f = await fixture();
    const stranger = await makeAdmin('stranger@test.test');

    // Another admin's event: refused before the attachment is even looked at.
    const denied = await call(mockUrl, {
      token: sign(stranger, 'Admin'),
      body: { ...f.body([f.guests[0]._id.toString()]), attachment: PDF() },
    });
    assert.equal(denied.status, 403);

    // A completed event: same.
    const owner = await makeAdmin('owner2@test.test');
    const done = await makeEvent(owner._id, { eventStatus: 'Completed' });
    const guest = await makeGuest(done, owner._id, 'Late', '+919812345699');
    const stale = await call(mockUrl, {
      token: sign(owner, 'Admin'),
      body: {
        eventId: done._id.toString(),
        contactIds: [guest._id.toString()],
        templateName: 'event_reminder',
        attachment: PDF(),
      },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'EVENT_NOT_ACTIVE');
    assert.equal(sent.length, 0, 'no upload may turn into a send for a refused request');
  });
});

// ── event_document: proactive document template ──────────────────────────────

/**
 * The template that sends a PDF to a guest who has never messaged the business
 * number. It declares its own DOCUMENT header, so unlike the tests above it
 * needs no WHATSAPP_WABA_ID — which is deliberately left unset here, exactly as
 * a deployment without it would be.
 */
describe('event_document', () => {
  const fsNode = require('node:fs');
  const pathNode = require('node:path');
  const { UPLOAD_DIR } = require('../backend/dist/middleware/mediaUpload');
  const files: string[] = [];

  const storedPdf = () => {
    const fileName = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-Invite.pdf`;
    fsNode.mkdirSync(UPLOAD_DIR, { recursive: true });
    fsNode.writeFileSync(
      pathNode.join(UPLOAD_DIR, fileName),
      Buffer.from('%PDF-1.4\ntrailer<</Root 1 0 R>>\n%%EOF\n')
    );
    files.push(fileName);
    return { url: `/uploads/${fileName}`, filename: 'Invite.pdf' };
  };

  const documentBody = (contactIds: string[], eventId: string, attachment?: any) => ({
    eventId,
    contactIds,
    templateName: 'event_document',
    ...(attachment ? { attachment } : {}),
  });

  after(() => {
    for (const f of files) {
      try {
        fsNode.unlinkSync(pathNode.join(UPLOAD_DIR, f));
      } catch {
        /* already gone */
      }
    }
  });

  test('sends the document template to every recipient, uploading the PDF once', async () => {
    const f = await fixture();
    const ids = f.guests.map((g: any) => g._id.toString());

    const res = await call(mockUrl, {
      token: f.token,
      body: documentBody(ids, f.event._id.toString(), storedPdf()),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.sentCount, 3);
    assert.equal(res.body.templateName, 'event_document');
    assert.equal(res.body.languageCode, 'en');
    assert.equal(res.body.headerMedia.kind, 'document');
    assert.equal(res.body.headerMedia.filename, 'Invite.pdf');

    assert.equal(sent.length, 3, 'one message per recipient');
    assert.equal(
      new Set(sent.map((m: any) => m.headerMedia.mediaId)).size,
      1,
      'the PDF is uploaded once and its media id reused'
    );
    for (const message of sent) {
      assert.equal(message.templateName, 'event_document');
      assert.equal(message.languageCode, 'en');
      assert.deepEqual(message.variables, [], 'no body parameters for a template with no variables');
      assert.equal(message.headerMedia.kind, 'document');
      assert.equal(message.headerMedia.filename, 'Invite.pdf');
    }
  });

  test('works without WHATSAPP_WABA_ID, because the header is declared', async () => {
    assert.equal(process.env.WHATSAPP_WABA_ID, undefined, 'this suite runs without it');
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: documentBody([f.guests[0]._id.toString()], f.event._id.toString(), storedPdf()),
    });
    assert.equal(res.status, 200, 'sending must not depend on the template catalog');
  });

  test('without a PDF it is refused, and nothing is sent', async () => {
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: documentBody([f.guests[0]._id.toString()], f.event._id.toString()),
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'ATTACHMENT_REQUIRED');
    assert.match(res.body.error.message, /document/i);
    assert.equal(sent.length, 0);
  });

  test('the Upcoming-only rule and authorization still come first', async () => {
    const f = await fixture();
    const stranger = await makeAdmin('stranger@test.test');

    const denied = await call(mockUrl, {
      token: sign(stranger, 'Admin'),
      body: documentBody([f.guests[0]._id.toString()], f.event._id.toString(), storedPdf()),
    });
    assert.equal(denied.status, 403);

    const owner = await makeAdmin('owner3@test.test');
    const done = await makeEvent(owner._id, { eventStatus: 'Completed' });
    const guest = await makeGuest(done, owner._id, 'Late', '+919812345688');
    const stale = await call(mockUrl, {
      token: sign(owner, 'Admin'),
      body: documentBody([guest._id.toString()], done._id.toString(), storedPdf()),
    });
    assert.equal(stale.status, 409);
    assert.equal(sent.length, 0);
  });

  test('event_reminder still sends with no header and its five values', async () => {
    const f = await fixture();
    const res = await call(mockUrl, { token: f.token, body: f.body([f.guests[0]._id.toString()]) });

    assert.equal(res.status, 200);
    assert.equal(sent[0].templateName, 'event_reminder');
    assert.equal(sent[0].headerMedia, undefined, 'no header is added to a template without one');
    assert.equal(sent[0].variables.length, 5);
  });
});

// ── event_image: proactive image template ────────────────────────────────────

/**
 * The same proactive path as event_document, with an IMAGE header instead of a
 * DOCUMENT one. The upload is counted here by wrapping the real uploader, so
 * "uploaded once and reused" and "authorization happens before the upload" are
 * measured rather than assumed.
 */
describe('event_image', () => {
  const fsNode = require('node:fs');
  const pathNode = require('node:path');
  const { UPLOAD_DIR } = require('../backend/dist/middleware/mediaUpload');
  const { whatsappService } = require('../backend/dist/services/WhatsAppService');
  const files: string[] = [];

  const realUpload = whatsappService.uploadMediaToMeta.bind(whatsappService);
  let uploads = 0;

  before(() => {
    whatsappService.uploadMediaToMeta = async (...args: any[]) => {
      uploads += 1;
      return realUpload(...args);
    };
  });

  after(() => {
    whatsappService.uploadMediaToMeta = realUpload;
    for (const f of files) {
      try {
        fsNode.unlinkSync(pathNode.join(UPLOAD_DIR, f));
      } catch {
        /* already gone */
      }
    }
  });

  beforeEach(() => {
    uploads = 0;
  });

  /** A real file on disk with the right magic bytes for its kind. */
  const stored = (kind: 'png' | 'pdf') => {
    const bytes =
      kind === 'png'
        ? Buffer.from('89504e470d0a1a0a', 'hex')
        : Buffer.from('%PDF-1.4\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const name = kind === 'png' ? 'Invitation.png' : 'Invite.pdf';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${name}`;
    fsNode.mkdirSync(UPLOAD_DIR, { recursive: true });
    fsNode.writeFileSync(pathNode.join(UPLOAD_DIR, fileName), bytes);
    files.push(fileName);
    return { url: `/uploads/${fileName}`, filename: name };
  };

  const imageBody = (contactIds: string[], eventId: string, attachment?: any) => ({
    eventId,
    contactIds,
    templateName: 'event_image',
    ...(attachment ? { attachment } : {}),
  });

  test('sends the image template to every recipient, uploading the image once', async () => {
    const f = await fixture();
    const ids = f.guests.map((g: any) => g._id.toString());

    const res = await call(mockUrl, {
      token: f.token,
      body: imageBody(ids, f.event._id.toString(), stored('png')),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.sentCount, 3);
    assert.equal(res.body.templateName, 'event_image');
    assert.equal(res.body.languageCode, 'en');
    assert.equal(res.body.headerMedia.kind, 'image');

    assert.equal(uploads, 1, 'one upload for the whole request, not one per recipient');
    assert.equal(sent.length, 3, 'one message per recipient');
    assert.equal(
      new Set(sent.map((m: any) => m.headerMedia.mediaId)).size,
      1,
      'the same Meta media id is reused for every recipient'
    );
    for (const message of sent) {
      assert.equal(message.templateName, 'event_image');
      assert.equal(message.languageCode, 'en');
      assert.deepEqual(message.variables, [], 'no body parameters for a template with no variables');
      assert.equal(message.headerMedia.kind, 'image');
      assert.equal(message.headerMedia.filename, undefined, 'only a document carries a filename');
    }
  });

  test('without an image it is refused, and nothing is uploaded or sent', async () => {
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: imageBody([f.guests[0]._id.toString()], f.event._id.toString()),
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'ATTACHMENT_REQUIRED');
    assert.match(res.body.error.message, /image/i);
    assert.equal(uploads, 0);
    assert.equal(sent.length, 0);
  });

  test('a PDF offered to the image template is rejected', async () => {
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: imageBody([f.guests[0]._id.toString()], f.event._id.toString(), stored('pdf')),
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.match(res.body.error.message, /image/i);
    assert.equal(uploads, 0, 'the wrong type is caught before anything is uploaded');
    assert.equal(sent.length, 0);
  });

  test('authorization is checked BEFORE the image is uploaded', async () => {
    const f = await fixture();
    const stranger = await makeAdmin('stranger@test.test');

    const res = await call(mockUrl, {
      token: sign(stranger, 'Admin'),
      body: imageBody([f.guests[0]._id.toString()], f.event._id.toString(), stored('png')),
    });

    assert.equal(res.status, 403);
    assert.equal(uploads, 0, 'a refused request must never reach Meta with a file');
    assert.equal(sent.length, 0);
  });

  test('the Upcoming-only rule also precedes the upload', async () => {
    const owner = await makeAdmin('owner4@test.test');
    const done = await makeEvent(owner._id, { eventStatus: 'Completed' });
    const guest = await makeGuest(done, owner._id, 'Late', '+919812345677');

    const res = await call(mockUrl, {
      token: sign(owner, 'Admin'),
      body: imageBody([guest._id.toString()], done._id.toString(), stored('png')),
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EVENT_NOT_ACTIVE');
    assert.equal(uploads, 0);
    assert.equal(sent.length, 0);
  });

  test('event_document still sends a document header, unchanged', async () => {
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: {
        eventId: f.event._id.toString(),
        contactIds: [f.guests[0]._id.toString()],
        templateName: 'event_document',
        attachment: stored('pdf'),
      },
    });

    assert.equal(res.status, 200);
    assert.equal(sent[0].templateName, 'event_document');
    assert.equal(sent[0].headerMedia.kind, 'document');
    assert.equal(sent[0].headerMedia.filename, 'Invite.pdf');
  });

  test('event_reminder still sends no header and its five values', async () => {
    const f = await fixture();
    const res = await call(mockUrl, { token: f.token, body: f.body([f.guests[0]._id.toString()]) });

    assert.equal(res.status, 200);
    assert.equal(sent[0].headerMedia, undefined);
    assert.equal(sent[0].variables.length, 5);
    assert.equal(uploads, 0, 'a template with no media header uploads nothing');
  });
});

// ── reporting: template sends in the Delivery Log ────────────────────────────

/**
 * A proactive template send has no campaign, so its delivery row carries the
 * event instead. The row is written BEFORE the Meta request, because Meta can
 * deliver a status callback the instant it accepts a message and the webhook
 * correlates on a row that must already exist.
 */
describe('template delivery records', () => {
  const { MessageLog } = require('../backend/dist/models/MessageLog');
  const webhook = require('../backend/dist/controllers/webhookController');
  const fsNode = require('node:fs');
  const pathNode = require('node:path');
  const { UPLOAD_DIR } = require('../backend/dist/middleware/mediaUpload');
  const files: string[] = [];

  const storedPng = () => {
    const fileName = `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-Invitation.png`;
    fsNode.mkdirSync(UPLOAD_DIR, { recursive: true });
    fsNode.writeFileSync(pathNode.join(UPLOAD_DIR, fileName), Buffer.from('89504e470d0a1a0a', 'hex'));
    files.push(fileName);
    return { url: `/uploads/${fileName}`, filename: 'Invitation.png' };
  };

  /** A Meta status callback, applied through the real webhook logic. */
  const callback = (wamid: string, status: string, extra: any = {}) =>
    webhook.__applyStatusUpdatesForTest({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  { id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
                ],
              },
            },
          ],
        },
      ],
    });

  beforeEach(async () => {
    await MessageLog.deleteMany({});
  });

  after(() => {
    for (const f of files) {
      try {
        fsNode.unlinkSync(pathNode.join(UPLOAD_DIR, f));
      } catch {
        /* already gone */
      }
    }
  });

  test('a successful send leaves one Sent row carrying event, guest and wamid', async () => {
    const f = await fixture();
    const res = await call(mockUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactIds: [f.guests[0]._id.toString()], templateName: 'event_image', attachment: storedPng() },
    });
    assert.equal(res.status, 200);

    const logs = await MessageLog.find({}).lean();
    assert.equal(logs.length, 1, 'exactly one row per recipient');
    const [log] = logs;
    assert.equal(String(log.eventId), String(f.event._id), 'the event, since there is no campaign');
    assert.equal(log.campaignId, undefined, 'and no campaign is invented for it');
    assert.equal(String(log.contactId), String(f.guests[0]._id));
    assert.equal(log.contactName, 'Shubham Suryavanshi');
    assert.equal(log.phoneNumber, '+918530808862');
    assert.equal(log.templateName, 'event_image');
    assert.equal(log.status, 'Sent');
    assert.equal(log.wamid, res.body.sent[0].messageId);
    assert.ok(log.sentAt, 'accepted-at is recorded');
    assert.equal(log.deliveredAt, undefined, 'acceptance is not delivery');
  });

  test('event_document is recorded the same way', async () => {
    const f = await fixture();
    const pdfName = `log-${Date.now()}-Invite.pdf`;
    fsNode.writeFileSync(pathNode.join(UPLOAD_DIR, pdfName), Buffer.from('%PDF-1.4\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
    files.push(pdfName);

    await call(mockUrl, {
      token: f.token,
      body: {
        eventId: f.event._id.toString(),
        contactIds: [f.guests[0]._id.toString()],
        templateName: 'event_document',
        attachment: { url: `/uploads/${pdfName}`, filename: 'Invite.pdf' },
      },
    });

    const log = await MessageLog.findOne({}).lean();
    assert.equal(log.templateName, 'event_document');
    assert.equal(log.status, 'Sent');
  });

  test('three recipients create exactly three rows, one wamid each', async () => {
    const f = await fixture();
    const ids = f.guests.map((g: any) => g._id.toString());
    await call(mockUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactIds: ids, templateName: 'event_image', attachment: storedPng() },
    });

    const logs = await MessageLog.find({}).lean();
    assert.equal(logs.length, 3);
    assert.equal(new Set(logs.map((l: any) => String(l.contactId))).size, 3, 'a row per guest');
    assert.equal(new Set(logs.map((l: any) => l.wamid)).size, 3, 'each with its own wamid');
    assert.equal(new Set(logs.map((l: any) => String(l.eventId))).size, 1, 'all on the same event');
    for (const log of logs) assert.equal(log.templateName, 'event_image');
  });

  test('a Meta rejection is recorded as Failed on the same row, with its code', async () => {
    const f = await fixture();
    rejectPhones.set(
      '+919112472833',
      new WhatsAppTemplateError('RECIPIENT_NOT_ALLOWED', 'This number cannot receive messages.', 400, {
        meta: { code: 131030 },
      })
    );

    const res = await call(mockUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactIds: f.guests.map((g: any) => g._id.toString()), templateName: 'event_image', attachment: storedPng() },
    });
    assert.equal(res.status, 207, 'a partial failure');

    const logs = await MessageLog.find({}).lean();
    assert.equal(logs.length, 3, 'still one row per recipient');
    const failed = logs.filter((l: any) => l.status === 'Failed');
    const sentRows = logs.filter((l: any) => l.status === 'Sent');
    assert.equal(failed.length, 1);
    assert.equal(sentRows.length, 2);
    assert.equal(failed[0].phoneNumber, '+919112472833');
    assert.equal(failed[0].errorCode, 131030, "Meta's own code");
    assert.match(failed[0].errorReason, /cannot receive messages/);
    assert.ok(failed[0].failedAt);
    assert.equal(failed[0].wamid, undefined, 'a refused message has no wamid');
  });

  test('the row exists BEFORE the send, so an immediate callback is not lost', async () => {
    const f = await fixture();
    let rowAtSendTime: any = null;

    // The stub stands in for Meta: whatever it sees at this moment is what a
    // callback arriving in the same instant would find.
    const sender = async (input: any) => {
      rowAtSendTime = await MessageLog.findOne({ phoneNumber: input.to }).lean();
      return { success: true, messageId: 'wamid.RACE', status: 'accepted', recipient: input.to };
    };

    const raceApp = express();
    raceApp.use(express.json());
    raceApp.use(requireAuth);
    raceApp.post('/send', controller.buildEventTemplateHandler(sender, () => clock));
    const raceServer = http.createServer(raceApp);
    await new Promise<void>((r) => raceServer.listen(0, '127.0.0.1', () => r()));
    const raceUrl = `http://127.0.0.1:${(raceServer.address() as any).port}/send`;

    await call(raceUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactIds: [f.guests[0]._id.toString()], templateName: 'event_image', attachment: storedPng() },
    });
    await new Promise<void>((r) => raceServer.close(() => r()));

    assert.ok(rowAtSendTime, 'the delivery row already existed when Meta was called');
    assert.equal(rowAtSendTime.status, 'Pending', 'as Pending, exactly as the campaign flow does');
    assert.equal(rowAtSendTime.wamid, undefined, 'the wamid only exists after Meta answers');
  });

  test('the webhook finds a template row by wamid and walks it to Read', async () => {
    const f = await fixture();
    await call(mockUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactIds: [f.guests[0]._id.toString()], templateName: 'event_image', attachment: storedPng() },
    });
    const wamid = (await MessageLog.findOne({}).lean()).wamid;

    await callback(wamid, 'delivered');
    let log = await MessageLog.findOne({ wamid }).lean();
    assert.equal(log.status, 'Delivered');
    assert.ok(log.deliveredAt);

    await callback(wamid, 'read');
    log = await MessageLog.findOne({ wamid }).lean();
    assert.ok(log.readAt, 'read is a timestamp on a delivered row');
    assert.equal(log.status, 'Delivered');

    // And a repeat callback changes nothing and creates nothing.
    const before = await MessageLog.countDocuments({});
    await callback(wamid, 'delivered');
    assert.equal(await MessageLog.countDocuments({}), before, 'no duplicate row');
  });

  test('a failed callback records Meta’s reason on the template row', async () => {
    const f = await fixture();
    await call(mockUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactIds: [f.guests[0]._id.toString()], templateName: 'event_image', attachment: storedPng() },
    });
    const wamid = (await MessageLog.findOne({}).lean()).wamid;

    await callback(wamid, 'failed', {
      errors: [{ code: 131047, title: 'Re-engagement message' }],
    });

    const log = await MessageLog.findOne({ wamid }).lean();
    assert.equal(log.status, 'Failed');
    assert.equal(log.errorCode, 131047);
    assert.equal(log.errorReason, 'Re-engagement message');
    assert.ok(log.failedAt);
  });

  test('the Delivery Log is event-scoped, and refuses another admin’s event', async () => {
    const f = await fixture();
    await call(mockUrl, {
      token: f.token,
      body: { eventId: f.event._id.toString(), contactIds: [f.guests[0]._id.toString()], templateName: 'event_image', attachment: storedPng() },
    });

    const reportRoutes = require('../backend/dist/routes/reportRoutes').default;
    const reportApp = express();
    reportApp.use(express.json());
    reportApp.use('/api/reports', reportRoutes);
    const reportServer = http.createServer(reportApp);
    await new Promise<void>((r) => reportServer.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(reportServer.address() as any).port}/api/reports`;

    const get = (token: string | null, eventId: string) =>
      fetch(`${base}/event/${eventId}/template-logs`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

    const mine = await get(f.token, f.event._id.toString());
    assert.equal(mine.status, 200);
    const body = await mine.json();
    assert.equal(body.logs.length, 1, 'the owner sees their own template send');
    assert.equal(body.logs[0].templateName, 'event_image');

    const stranger = await makeAdmin('reportstranger@test.test');
    const theirs = await get(sign(stranger, 'Admin'), f.event._id.toString());
    assert.equal(theirs.status, 403, 'another admin cannot read this event’s rows');

    const anon = await get(null, f.event._id.toString());
    assert.equal(anon.status, 401);

    // fetch keeps the socket alive, and close() waits for it — which leaves
    // the whole test process hanging after the assertions have passed.
    reportServer.closeAllConnections?.();
    await new Promise<void>((r) => reportServer.close(() => r()));
  });
});
