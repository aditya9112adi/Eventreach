import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WhatsApp media sending, end to end against the REAL compiled backend.
 *
 * Media is sent by Meta media ID, never by URL: /uploads is authenticated and
 * sits on an ephemeral disk, so no link WhatsApp could fetch exists. Each
 * campaign uploads its files to Meta once, then reuses the returned id for
 * every recipient.
 *
 * Meta is never contacted — axios is stubbed on the shared module object.
 * Upload validation is exercised through the real multer middleware and the
 * real controller, with real bytes on disk, so the magic-byte check is
 * genuinely tested rather than mocked away.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_media_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = 'test-token-not-a-real-secret';
process.env.WHATSAPP_PHONE_ID = '111111111111111';
process.env.WHATSAPP_API_VERSION = 'v25.0';

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const campaignRoutes = require('../backend/dist/routes/campaignRoutes').default;
const { MessageLog } = require('../backend/dist/models/MessageLog');
const { Campaign } = require('../backend/dist/models/Campaign');
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { Admin } = require('../backend/dist/models/Admin');
const { queueService } = require('../backend/dist/services/QueueService');
const { buildPrimaryPayload, buildFollowUpPayloads } = require('../backend/dist/services/WhatsAppService');
const { UPLOAD_DIR } = require('../backend/dist/middleware/mediaUpload');
const { WHATSAPP_MEDIA_RULES } = require('../shared/dist/index.js');

let server: any, baseUrl = '', adminToken = '', eventId: any;
const originalAxiosPost = axios.post;
const createdFiles: string[] = [];

/** Real bytes with correct magic numbers, so the sniffer sees a genuine file. */
const FIXTURES: Record<string, { mime: string; ext: string; head: number[] }> = {
  jpg:  { mime: 'image/jpeg',      ext: '.jpg',  head: [0xff, 0xd8, 0xff, 0xe0] },
  jpeg: { mime: 'image/jpeg',      ext: '.jpeg', head: [0xff, 0xd8, 0xff, 0xe0] },
  png:  { mime: 'image/png',       ext: '.png',  head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  pdf:  { mime: 'application/pdf', ext: '.pdf',  head: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  mp3:  { mime: 'audio/mpeg',      ext: '.mp3',  head: [0x49, 0x44, 0x33, 0x04] },
  mp4:  { mime: 'video/mp4',       ext: '.mp4',  head: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70] },
};

const makeBytes = (kind: string, sizeBytes = 512): Buffer => {
  const f = FIXTURES[kind];
  const buf = Buffer.alloc(sizeBytes, 0x20);
  Buffer.from(f.head).copy(buf, 0);
  return buf;
};

/** multipart/form-data upload through the real route, with real bytes. */
const uploadFile = (opts: {
  bytes: Buffer; filename: string; contentType: string; token?: string;
}): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const boundary = '----eventreachtest' + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
      `Content-Type: ${opts.contentType}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, opts.bytes, tail]);

    const url = new URL(baseUrl + '/api/campaigns/upload');
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        Authorization: `Bearer ${opts.token ?? adminToken}`,
      },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: any = null; try { parsed = d ? JSON.parse(d) : null; } catch { parsed = d; }
        if (parsed?.url) createdFiles.push(path.join(UPLOAD_DIR, path.basename(parsed.url)));
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });

/** Records every Meta call so payloads can be asserted. */
const stubMeta = (opts: { mediaUploadFails?: boolean; sendFails?: boolean } = {}) => {
  const calls: Array<{ url: string; body: any }> = [];
  axios.post = async (url: string, body: any) => {
    calls.push({ url, body });
    if (url.includes('/media')) {
      if (opts.mediaUploadFails) {
        const e: any = new Error('Request failed with status code 400');
        e.response = { status: 400, data: { error: { message: 'Media upload failed: file type not supported', code: 131053 } } };
        throw e;
      }
      return { data: { id: `media-id-${calls.length}` } };
    }
    if (opts.sendFails) {
      const e: any = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { error: { message: 'Message undeliverable', code: 131026 } } };
      throw e;
    }
    return { data: { messages: [{ id: `wamid.MEDIA${calls.length}` }] } };
  };
  return calls;
};

const seedContacts = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await Contact.create({
      fullName: `Guest ${i}`, phoneNumber: `+9190000000${String(i).padStart(2, '0')}`,
      countryCode: 'IN', eventId, source: 'Manual', status: 'Valid',
    });
  }
};

const runCampaign = async (campaign: any, text: string, attachments: any[]) => {
  await queueService.processCampaign(String(campaign._id), undefined, text, attachments);
  for (let i = 0; i < 80; i++) {
    const pending = await MessageLog.countDocuments({ campaignId: campaign._id, status: 'Pending' });
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('campaign did not finish in time');
};

before(async () => {
  await mongoose.connect(TEST_DB);
  const admin = await Admin.create({
    name: 'A', email: 'media-admin@example.com',
    passwordHash: await bcrypt.hash('TestPass123', 10),
    role: 'SuperAdmin', status: 'Active', accessGrantedOn: new Date(),
  });
  adminToken = jwt.sign({ id: admin._id, email: admin.email, role: 'SuperAdmin' }, process.env.JWT_SECRET, { expiresIn: '1d' });

  const event = await Event.create({
    organizerName: 'Org', organizerMobile: BigInt('9112472833'), eventName: 'Gala', eventType: 'Party',
    eventDate: new Date('2026-12-01T00:00:00.000Z'), eventTime: new Date('2026-12-01T18:30:00+05:30'),
    eventVenue: 'Hall', eventStatus: 'Upcoming',
  });
  eventId = event._id;

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/campaigns', campaignRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  axios.post = originalAxiosPost;
  for (const f of createdFiles) { try { fs.unlinkSync(f); } catch {} }
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  axios.post = originalAxiosPost;
  await Promise.all([MessageLog.deleteMany({}), Campaign.deleteMany({}), Contact.deleteMany({})]);
});

// ── 1-6: accepted types ──────────────────────────────────────────────────────

describe('Upload validation — supported types', () => {
  for (const kind of ['jpg', 'jpeg', 'png', 'pdf', 'mp3', 'mp4']) {
    test(`${kind.toUpperCase()} is accepted`, async () => {
      const f = FIXTURES[kind];
      const res = await uploadFile({ bytes: makeBytes(kind), filename: `sample${f.ext}`, contentType: f.mime });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.mimeType, f.mime);
      assert.equal(res.body.type, WHATSAPP_MEDIA_RULES[f.mime].kind);
      assert.ok(res.body.url.startsWith('/uploads/'));
      assert.ok(res.body.sizeBytes > 0);
    });
  }
});

// ── 7-9: rejections ──────────────────────────────────────────────────────────

describe('Upload validation — rejections', () => {
  test('unsupported extension is rejected', async () => {
    const res = await uploadFile({
      bytes: Buffer.from('MZ' + 'x'.repeat(100)), filename: 'evil.exe', contentType: 'application/x-msdownload',
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /Unsupported file type/i);
  });

  test('contents that do not match the declared MIME are rejected', async () => {
    // An executable renamed to .png and declared image/png: passes a
    // MIME-only check, fails the magic-byte check.
    const res = await uploadFile({
      bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...Buffer.alloc(200)]),
      filename: 'notreally.png', contentType: 'image/png',
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /contents do not match/i);
  });

  test('a file larger than its per-type limit is rejected', async () => {
    // 6 MB PNG — under the 100 MB blanket ceiling, over the 5 MB image limit.
    const tooBig = makeBytes('png', 6 * 1024 * 1024);
    const res = await uploadFile({ bytes: tooBig, filename: 'huge.png', contentType: 'image/png' });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /at most 5 MB/i);
  });

  test('a rejected upload leaves no file behind on disk', async () => {
    const before = fs.readdirSync(UPLOAD_DIR).length;
    await uploadFile({ bytes: makeBytes('png', 6 * 1024 * 1024), filename: 'huge2.png', contentType: 'image/png' });
    assert.equal(fs.readdirSync(UPLOAD_DIR).length, before, 'refused files must be cleaned up');
  });

  test('upload requires authentication', async () => {
    const res = await uploadFile({
      bytes: makeBytes('png'), filename: 'x.png', contentType: 'image/png', token: 'not-a-valid-token',
    });
    assert.equal(res.status, 401);
  });
});

// ── 10-13: payload construction ──────────────────────────────────────────────

describe('WhatsApp payload construction', () => {
  const media = (type: string, filename: string, supportsCaption = true) =>
    ({ metaMediaId: 'MEDIA_ID_1', type, filename, supportsCaption });

  test('image payload', () => {
    const p = buildPrimaryPayload('+919112472833', 'Hello', [media('image', 'a.png')]);
    assert.equal(p.type, 'image');
    assert.equal(p.to, '919112472833');
    assert.deepEqual(p.image, { id: 'MEDIA_ID_1', caption: 'Hello' });
  });

  test('document payload carries the filename', () => {
    const p = buildPrimaryPayload('+919112472833', 'Invite', [media('document', 'invite.pdf')]);
    assert.equal(p.type, 'document');
    assert.equal(p.document.id, 'MEDIA_ID_1');
    assert.equal(p.document.filename, 'invite.pdf', 'without this the recipient sees the raw media id');
    assert.equal(p.document.caption, 'Invite');
  });

  test('audio payload has no caption, and the text follows separately', () => {
    const atts = [media('audio', 'song.mp3', false)];
    const p = buildPrimaryPayload('+919112472833', 'Listen', atts);
    assert.equal(p.type, 'audio');
    assert.deepEqual(p.audio, { id: 'MEDIA_ID_1' }, 'WhatsApp rejects a caption on audio');

    const follow = buildFollowUpPayloads('+919112472833', 'Listen', atts);
    assert.equal(follow.length, 1);
    assert.equal(follow[0].type, 'text');
    assert.equal(follow[0].text.body, 'Listen', 'text must not be lost');
  });

  test('video payload', () => {
    const p = buildPrimaryPayload('+919112472833', 'Watch', [media('video', 'clip.mp4')]);
    assert.equal(p.type, 'video');
    assert.deepEqual(p.video, { id: 'MEDIA_ID_1', caption: 'Watch' });
  });

  test('text is never sent twice when the media carries a caption', () => {
    const atts = [media('image', 'a.png')];
    const p = buildPrimaryPayload('+91911', 'Once', atts);
    assert.equal(p.image.caption, 'Once');
    assert.deepEqual(buildFollowUpPayloads('+91911', 'Once', atts), [], 'no duplicate text message');
  });

  test('a text-only campaign still builds a plain text payload', () => {
    const p = buildPrimaryPayload('+919112472833', 'Just text', []);
    assert.equal(p.type, 'text');
    assert.equal(p.text.body, 'Just text');
    assert.deepEqual(buildFollowUpPayloads('+919112472833', 'Just text', []), []);
  });
});

// ── 14-15, 20-21: sending ────────────────────────────────────────────────────

describe('Sending with media', () => {
  const attachFrom = async (kind: string) => {
    const f = FIXTURES[kind];
    const res = await uploadFile({ bytes: makeBytes(kind), filename: `c${f.ext}`, contentType: f.mime });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };

  test('media is uploaded to Meta once per campaign, not once per recipient', async () => {
    const calls = stubMeta();
    const att = await attachFrom('png');
    await seedContacts(3);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });

    await runCampaign(campaign, 'Hi {{fullName}}', [att]);

    const mediaCalls = calls.filter((c) => c.url.includes('/media'));
    const sendCalls = calls.filter((c) => c.url.includes('/messages'));
    assert.equal(mediaCalls.length, 1, 'one upload for the whole campaign');
    assert.equal(sendCalls.length, 3, 'one message per recipient');
    assert.ok(sendCalls.every((c) => c.body.image?.id === 'media-id-1'), 'the same media id is reused');
  });

  test('a successful media send records Sent + wamid + sentAt', async () => {
    stubMeta();
    const att = await attachFrom('png');
    await seedContacts(1);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });
    await runCampaign(campaign, 'Hi', [att]);

    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    assert.equal(log.status, 'Sent');
    assert.match(log.wamid, /^wamid\./);
    assert.ok(log.sentAt instanceof Date);
    assert.equal(log.deliveredAt, undefined, 'acceptance is not delivery');
  });

  test('a Meta media-upload failure marks every recipient Failed with the reason', async () => {
    stubMeta({ mediaUploadFails: true });
    const att = await attachFrom('png');
    await seedContacts(3);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });
    await runCampaign(campaign, 'Hi', [att]);

    const logs = await MessageLog.find({ campaignId: campaign._id }).lean();
    assert.equal(logs.length, 3);
    for (const l of logs) {
      assert.equal(l.status, 'Failed', 'no recipient may be left Pending');
      assert.equal(l.errorCode, 131053);
      assert.match(l.errorReason, /not supported/i);
      assert.ok(l.failedAt instanceof Date);
    }
  });

  test('a Meta send rejection marks the recipient Failed with the code', async () => {
    stubMeta({ sendFails: true });
    const att = await attachFrom('png');
    await seedContacts(1);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });
    await runCampaign(campaign, 'Hi', [att]);

    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    assert.equal(log.status, 'Failed');
    assert.equal(log.errorCode, 131026);
    assert.ok(log.failedAt instanceof Date);
  });

  test('text-only campaigns are unaffected — no media call is made', async () => {
    const calls = stubMeta();
    await seedContacts(2);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });
    await runCampaign(campaign, 'Hi {{fullName}}', []);

    assert.equal(calls.filter((c) => c.url.includes('/media')).length, 0, 'no upload for a text campaign');
    const sends = calls.filter((c) => c.url.includes('/messages'));
    assert.equal(sends.length, 2);
    assert.ok(sends.every((c) => c.body.type === 'text'));

    const logs = await MessageLog.find({ campaignId: campaign._id }).lean();
    assert.equal(logs.length, 2);
    assert.ok(logs.every((l: any) => l.status === 'Sent' && l.sentAt && l.wamid));
  });

  test('text + media campaign sends one message carrying both', async () => {
    const calls = stubMeta();
    const att = await attachFrom('jpg');
    await seedContacts(1);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });
    await runCampaign(campaign, 'Hi Asha, see you at Gala', [att]);

    const sends = calls.filter((c) => c.url.includes('/messages'));
    assert.equal(sends.length, 1, 'exactly one message — the text must not be sent again');
    assert.equal(sends[0].body.type, 'image');
    assert.equal(sends[0].body.image.caption, 'Hi Asha, see you at Gala');
  });

  test('a missing file on disk fails the campaign with a clear reason, not ENOENT', async () => {
    stubMeta();
    await seedContacts(1);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });
    await runCampaign(campaign, 'Hi', [{ url: '/uploads/gone-forever.png', type: 'image', filename: 'gone.png' }]);

    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    assert.equal(log.status, 'Failed');
    assert.match(log.errorReason, /no longer available|re-upload/i);
  });
});

// ── 22: no credential leakage ────────────────────────────────────────────────

describe('No credentials in logs or responses', () => {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    const cap = (...a: any[]) => { captured.push(a.map(String).join(' ')); };
    console.log = cap; console.warn = cap; console.error = cap;
  });
  afterEach(() => {
    console.log = originals.log; console.warn = originals.warn; console.error = originals.error;
  });

  test('a media upload failure never logs the token or the Authorization header', async () => {
    stubMeta({ mediaUploadFails: true });
    const f = FIXTURES.png;
    const up = await uploadFile({ bytes: makeBytes('png'), filename: `leak${f.ext}`, contentType: f.mime });
    await seedContacts(1);
    const campaign = await Campaign.create({ eventId, messageText: 'Hi', status: 'Draft' });
    await runCampaign(campaign, 'Hi', [up.body]);

    const all = captured.join('\n');
    assert.ok(!all.includes(process.env.WHATSAPP_TOKEN!), 'token must never be logged');
    assert.doesNotMatch(all, /Bearer /, 'Authorization header must never be logged');

    const log = await MessageLog.findOne({ campaignId: campaign._id }).lean();
    assert.ok(!String(log.errorReason).includes(process.env.WHATSAPP_TOKEN!), 'token must not reach the report');
  });
});

// ── Custom Message payloads, built from the STORED campaign ──────────────────

/**
 * Regression cover for the production failure of 23 Sep 2026: a text + PDF
 * campaign reached Meta as
 *   {"messaging_product":…,"to":…,"undefined":{"id":…,"caption":…}}
 * with no `type` at all, because campaign.mediaAttachments hands over Mongoose
 * subdocuments and spreading one drops every schema field. Meta treats an
 * untyped message as text and answers
 *   (#100) Invalid parameter: The parameter 'text' cannot be null.
 *
 * The tests above pass attachments as plain object literals, which is why they
 * never saw it. These go through the database exactly as sendCampaign does.
 */
describe('Custom Message payloads, from the stored campaign', () => {
  const attachFrom = async (kind: string, filename?: string) => {
    const f = FIXTURES[kind];
    const res = await uploadFile({
      bytes: makeBytes(kind),
      filename: filename || `c${f.ext}`,
      contentType: f.mime,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };

  const MESSAGE = 'Hi,\n\nPlease find the event document attached.\n\nThank you,\nEventReach Team';

  /** Stores the campaign, then sends it the way sendCampaign does: with the
   *  values read back off the persisted document. */
  const sendStored = async (messageText: string, attachments: any[]) => {
    const campaign = await Campaign.create({
      eventId,
      messageText,
      mediaAttachments: attachments,
      status: 'Draft',
    });
    const fresh = await Campaign.findById(campaign._id);
    await queueService.processCampaign(
      String(fresh._id),
      undefined,
      fresh.messageText,
      fresh.mediaAttachments
    );
    for (let i = 0; i < 80; i++) {
      const pending = await MessageLog.countDocuments({ campaignId: String(campaign._id), status: 'Pending' });
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return campaign;
  };

  const messagesFrom = (calls: Array<{ url: string; body: any }>) =>
    calls.filter((c) => c.url.includes('/messages')).map((c) => c.body);

  /** The exact shape the production error was about. */
  const assertNoNullText = (payload: any) => {
    assert.ok(payload.type, 'the message must carry a type — an untyped message is read by Meta as text');
    assert.ok(!Object.keys(payload).includes('undefined'), 'no "undefined" key may reach Meta');
    assert.ok(!('text' in payload), 'a media message must not carry a text property at all');
    assert.ok(
      !/"text"\s*:\s*null/.test(JSON.stringify(payload)),
      'the payload must never serialize text: null'
    );
  };

  test('1. text only sends a text payload carrying the real body', async () => {
    const calls = stubMeta();
    await seedContacts(1);
    await sendStored(MESSAGE, []);

    const [payload] = messagesFrom(calls);
    assert.equal(payload.type, 'text');
    assert.equal(payload.text.body, MESSAGE, 'the composed message must survive to Meta');
    assert.equal(payload.text.preview_url, false);
    assert.equal(calls.filter((c) => c.url.includes('/media')).length, 0);
  });

  test('2. PDF only sends a document payload, with no text property', async () => {
    const calls = stubMeta();
    const att = await attachFrom('pdf', 'Aditya_New_.pdf');
    await seedContacts(1);
    await sendStored('', [att]);

    const [payload] = messagesFrom(calls);
    assert.equal(payload.type, 'document');
    assert.equal(payload.document.id, 'media-id-1');
    assert.equal(payload.document.filename, 'Aditya_New_.pdf');
    assert.equal(payload.document.caption, undefined, 'no caption when there is no message');
    assertNoNullText(payload);
  });

  test('3. text + PDF sends ONE document payload whose caption is the message', async () => {
    const calls = stubMeta();
    const att = await attachFrom('pdf', 'Aditya_New_.pdf');
    await seedContacts(1);
    await sendStored(MESSAGE, [att]);

    const payloads = messagesFrom(calls);
    assert.equal(payloads.length, 1, 'the text rides as the caption, it is not sent twice');
    assert.equal(payloads[0].type, 'document');
    assert.equal(payloads[0].document.caption, MESSAGE);
    assert.equal(payloads[0].document.filename, 'Aditya_New_.pdf', 'the filename is the other field the bug dropped');
    assertNoNullText(payloads[0]);
  });

  test('4. image only sends an image payload, with no text property', async () => {
    const calls = stubMeta();
    const att = await attachFrom('png');
    await seedContacts(1);
    await sendStored('', [att]);

    const [payload] = messagesFrom(calls);
    assert.equal(payload.type, 'image');
    assert.equal(payload.image.id, 'media-id-1');
    assertNoNullText(payload);
  });

  test('5. text + image sends an image payload captioned with the message', async () => {
    const calls = stubMeta();
    const att = await attachFrom('png');
    await seedContacts(1);
    await sendStored(MESSAGE, [att]);

    const [payload] = messagesFrom(calls);
    assert.equal(payload.type, 'image');
    assert.equal(payload.image.caption, MESSAGE);
    assertNoNullText(payload);
  });

  test('6. every recipient of a text + PDF campaign gets the same document payload', async () => {
    const calls = stubMeta();
    const att = await attachFrom('pdf', 'Aditya_New_.pdf');
    await seedContacts(3);
    await sendStored(MESSAGE, [att]);

    const payloads = messagesFrom(calls);
    assert.equal(payloads.length, 3, 'one message per recipient');
    assert.equal(calls.filter((c) => c.url.includes('/media')).length, 1, 'uploaded once');
    for (const payload of payloads) {
      assert.equal(payload.type, 'document');
      assert.equal(payload.document.id, 'media-id-1');
      assert.equal(payload.document.filename, 'Aditya_New_.pdf');
      assert.equal(payload.document.caption, MESSAGE);
      assertNoNullText(payload);
    }
    assert.equal(new Set(payloads.map((p) => p.to)).size, 3, 'three distinct recipients');
  });

  test('7. a campaign with neither text nor attachment is refused, not sent as empty text', async () => {
    const calls = stubMeta();
    await seedContacts(1);
    const campaign = await sendStored('', []);

    assert.equal(messagesFrom(calls).length, 0, 'nothing may be posted to Meta');
    const log = await MessageLog.findOne({ campaignId: String(campaign._id) }).lean();
    assert.equal(log.status, 'Failed');
    assert.match(log.errorReason, /nothing to send/i);
  });

  test('an attachment with an unrecognised type fails loudly instead of going out untyped', async () => {
    const calls = stubMeta();
    const att = await attachFrom('pdf', 'Aditya_New_.pdf');
    await seedContacts(1);
    // The shape the bug produced: a media id, but no kind.
    const campaign = await Campaign.create({ eventId, messageText: MESSAGE, status: 'Draft' });
    await queueService.processCampaign(String(campaign._id), undefined, MESSAGE, [
      { url: att.url, filename: att.filename, mimeType: att.mimeType },
    ]);
    for (let i = 0; i < 80; i++) {
      const pending = await MessageLog.countDocuments({ campaignId: String(campaign._id), status: 'Pending' });
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(messagesFrom(calls).length, 0, 'an untyped message must never reach Meta');
    const log = await MessageLog.findOne({ campaignId: String(campaign._id) }).lean();
    assert.equal(log.status, 'Failed');
    assert.match(log.errorReason, /unrecognised media type/i);
  });

  test('the composed text reaches Meta and the recipient log verbatim', async () => {
    const calls = stubMeta();
    const att = await attachFrom('pdf', 'Aditya_New_.pdf');
    await seedContacts(1);

    const campaign = await Campaign.create({
      eventId, messageText: MESSAGE, mediaAttachments: [att], status: 'Draft',
    });

    // What is stored before anything is sent.
    const stored = await Campaign.findById(campaign._id).lean();
    assert.equal(stored.messageText, MESSAGE, 'the composer text must persist verbatim');
    assert.equal(stored.mediaAttachments[0].type, 'document', 'the stored attachment keeps its type');
    assert.equal(stored.mediaAttachments[0].filename, 'Aditya_New_.pdf');

    const fresh = await Campaign.findById(campaign._id);
    await queueService.processCampaign(String(fresh._id), undefined, fresh.messageText, fresh.mediaAttachments);
    for (let i = 0; i < 80; i++) {
      const pending = await MessageLog.countDocuments({ campaignId: String(campaign._id), status: 'Pending' });
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(messagesFrom(calls)[0].document.caption, MESSAGE, 'the text must not be lost on the way to Meta');

    const log = await MessageLog.findOne({ campaignId: String(campaign._id) }).lean();
    assert.equal(log.messageText, MESSAGE, 'the per-recipient record keeps the text that was sent');

    // Clearing the live draft after a send is deliberate — the Composer shows
    // it under "Previously Shared Messages" from history. It is emptied, never
    // set to null.
    const after = await Campaign.findById(campaign._id).lean();
    assert.equal(after.messageText, '', 'the draft is cleared after sending, by design');
    assert.notEqual(after.messageText, null);
  });
});
