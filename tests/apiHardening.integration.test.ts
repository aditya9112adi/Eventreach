import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Integration coverage for the hardening pass:
 *   - /uploads is authenticated and authorized per event
 *   - contact listings paginate and search in the database, while staying
 *     backward compatible for callers that need every contact
 *
 * These run against the REAL compiled backend in backend/dist. Run
 * `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_hardening_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.FRONTEND_URL = 'http://localhost:5173';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.RESEND_API_KEY;

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const authRoutes = require('../backend/dist/routes/authRoutes').default;
const contactRoutes = require('../backend/dist/routes/contactRoutes').default;
const { requireAuth } = require('../backend/dist/middleware/authMiddleware');
const { authorizeUpload } = require('../backend/dist/middleware/uploadAuthMiddleware');
const { User } = require('../backend/dist/models/User');
const { Admin } = require('../backend/dist/models/Admin');
const { Event } = require('../backend/dist/models/Event');
const { Contact } = require('../backend/dist/models/Contact');
const { Campaign } = require('../backend/dist/models/Campaign');

const PASSWORD = 'TestPass123';
const UPLOAD_DIR = path.join(process.cwd(), 'backend', 'uploads');
const MEDIA_FILE = 'hardening-test-image.png';
const MEDIA_URL = `/uploads/${MEDIA_FILE}`;

let server: any;
let baseUrl = '';
let ipCounter = 0;

interface Res {
  status: number;
  body: any;
  raw: string;
}

const call = (
  method: string,
  urlPath: string,
  opts: { body?: any; token?: string } = {}
): Promise<Res> =>
  new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const headers: Record<string, string> = {
      'CF-Connecting-IP': `203.0.113.${(ipCounter++ % 250) + 1}`,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const url = new URL(baseUrl + urlPath);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode || 0, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const seedAccount = async (
  kind: 'SuperAdmin' | 'Admin' | 'User',
  email: string,
  extra: any = {}
) => {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  if (kind === 'User') {
    return User.create({ name: 'Seeded User', email, passwordHash, status: 'Active', ...extra });
  }
  return Admin.create({
    name: `Seeded ${kind}`,
    email,
    passwordHash,
    role: kind,
    status: 'Active',
    ...(kind === 'Admin' ? { accessGrantedOn: new Date() } : {}),
    ...extra,
  });
};

const loginAs = async (email: string) => {
  const res = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  return res.body.token;
};

// Field types follow the Event schema: organizerMobile is a 10-digit Number and
// eventTime is minutes since midnight.
const makeEvent = (overrides: any = {}) =>
  Event.create({
    organizerName: 'Org',
    organizerMobile: 9876543210,
    eventName: 'Test Event',
    eventType: 'Wedding',
    eventDate: new Date(),
    eventTime: 1080, // 18:00
    eventVenue: 'Venue',
    eventStatus: 'Upcoming',
    ...overrides,
  });

before(async () => {
  await mongoose.connect(TEST_DB);

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  // A tiny real file so express.static has something to serve.
  fs.writeFileSync(path.join(UPLOAD_DIR, MEDIA_FILE), Buffer.from('fake-png-bytes'));

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  // Mounted exactly as server.ts mounts it.
  app.use('/uploads', requireAuth, authorizeUpload, express.static(UPLOAD_DIR));
  app.use('/api/auth', authRoutes);
  app.use('/api/contacts', contactRoutes);

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, MEDIA_FILE));
  } catch {
    /* already gone */
  }
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Admin.deleteMany({}),
    Event.deleteMany({}),
    Contact.deleteMany({}),
    Campaign.deleteMany({}),
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('FIX 1 — /uploads is authenticated and authorized', () => {
  const seedMedia = async () => {
    const event = await makeEvent();
    await Campaign.create({
      eventId: event._id,
      messageText: 'hello',
      mediaAttachments: [{ url: MEDIA_URL, type: 'image', filename: 'photo.png' }],
      status: 'Draft',
    });
    return event;
  };

  test('an unauthenticated request is rejected', async () => {
    await seedMedia();
    const res = await call('GET', MEDIA_URL);
    assert.equal(res.status, 401, 'must not serve media without a token');
    assert.ok(!res.raw.includes('fake-png-bytes'), 'file contents must not leak');
  });

  test('an authorized user receives the file', async () => {
    const event = await seedMedia();
    await seedAccount('User', 'owner@example.com', { assignedEventId: event._id });
    const token = await loginAs('owner@example.com');

    const res = await call('GET', MEDIA_URL, { token });
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('fake-png-bytes'), 'authorized user should get the bytes');
  });

  test('a Super Admin receives the file', async () => {
    await seedMedia();
    await seedAccount('SuperAdmin', 'sa-up@example.com');
    const token = await loginAs('sa-up@example.com');
    assert.equal((await call('GET', MEDIA_URL, { token })).status, 200);
  });

  test('an authenticated but unauthorized user is refused', async () => {
    await seedMedia();
    // No assignedEventId, so this account has access to no events at all.
    await seedAccount('User', 'outsider@example.com');
    const token = await loginAs('outsider@example.com');

    const res = await call('GET', MEDIA_URL, { token });
    assert.equal(res.status, 403, 'another event’s media must not be readable');
    assert.ok(!res.raw.includes('fake-png-bytes'), 'file contents must not leak');
  });

  test('a missing file returns 404 for an authenticated caller', async () => {
    await seedMedia();
    await seedAccount('SuperAdmin', 'sa-404@example.com');
    const token = await loginAs('sa-404@example.com');
    assert.equal((await call('GET', '/uploads/no-such-file.png', { token })).status, 404);
  });

  test('media referenced only from send history is still authorized', async () => {
    const event = await makeEvent();
    await Campaign.create({
      eventId: event._id,
      messageText: '',
      mediaAttachments: [],
      status: 'Completed',
      history: [
        {
          messageText: 'sent earlier',
          mediaAttachments: [{ url: MEDIA_URL, type: 'image', filename: 'photo.png' }],
          sentAt: new Date(),
        },
      ],
    });
    await seedAccount('User', 'hist@example.com', { assignedEventId: event._id });
    const token = await loginAs('hist@example.com');
    assert.equal((await call('GET', MEDIA_URL, { token })).status, 200);
  });

  test('a path traversal attempt is refused', async () => {
    await seedMedia();
    await seedAccount('SuperAdmin', 'sa-trav@example.com');
    const token = await loginAs('sa-trav@example.com');

    const res = await call('GET', '/uploads/..%2F..%2Fpackage.json', { token });
    assert.ok(res.status === 404 || res.status === 400, `expected refusal, got ${res.status}`);
    assert.ok(!res.raw.includes('"dependencies"'), 'must not serve files outside uploads');
  });
});

describe('FIX 2 — contact listings paginate without breaking callers', () => {
  const seedContacts = async (eventId: any, count: number) => {
    const docs = [];
    for (let i = 0; i < count; i++) {
      docs.push({
        fullName: i === 0 ? 'Zaphod Beeblebrox' : `Person ${String(i).padStart(3, '0')}`,
        phoneNumber: `+9198765${String(43000 + i).padStart(5, '0')}`,
        countryCode: 'IN',
        eventId,
        source: 'Manual',
        status: 'Valid',
      });
    }
    await Contact.insertMany(docs);
  };

  test('without pagination params the response is still a plain array', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 25);
    await seedAccount('SuperAdmin', 'sa-compat@example.com');
    const token = await loginAs('sa-compat@example.com');

    const res = await call('GET', `/api/contacts/event/${event._id}`, { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'existing callers must still receive an array');
    assert.equal(res.body.length, 25, 'and the complete set');
  });

  test('with page/limit it returns one page plus pagination metadata', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 25);
    await seedAccount('SuperAdmin', 'sa-page@example.com');
    const token = await loginAs('sa-page@example.com');

    const res = await call('GET', `/api/contacts/event/${event._id}?page=2&limit=10`, { token });
    assert.equal(res.status, 200);
    assert.ok(!Array.isArray(res.body), 'paginated calls get an envelope');
    assert.equal(res.body.data.length, 10, 'only one page of records is sent');
    assert.deepEqual(
      { total: res.body.pagination.total, page: res.body.pagination.page, limit: res.body.pagination.limit, totalPages: res.body.pagination.totalPages },
      { total: 25, page: 2, limit: 10, totalPages: 3 }
    );
  });

  test('pages do not overlap and cover the whole set', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 25);
    await seedAccount('SuperAdmin', 'sa-cover@example.com');
    const token = await loginAs('sa-cover@example.com');

    const ids = new Set<string>();
    for (const page of [1, 2, 3]) {
      const res = await call('GET', `/api/contacts/event/${event._id}?page=${page}&limit=10`, { token });
      res.body.data.forEach((c: any) => ids.add(c._id));
    }
    assert.equal(ids.size, 25, 'every contact appears exactly once across pages');
  });

  test('search runs in the database and is reflected in the total', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 25);
    await seedAccount('SuperAdmin', 'sa-search@example.com');
    const token = await loginAs('sa-search@example.com');

    const res = await call(
      'GET',
      `/api/contacts/event/${event._id}?page=1&limit=10&search=Zaphod`,
      { token }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.pagination.total, 1, 'total reflects the filter, not the collection');
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].fullName, 'Zaphod Beeblebrox');
  });

  test('search also matches phone numbers', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 5);
    await seedAccount('SuperAdmin', 'sa-phone@example.com');
    const token = await loginAs('sa-phone@example.com');

    const res = await call('GET', `/api/contacts/event/${event._id}?page=1&limit=10&search=43002`, { token });
    assert.equal(res.body.pagination.total, 1);
  });

  test('a regex metacharacter in search is treated as literal text', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 5);
    await seedAccount('SuperAdmin', 'sa-regex@example.com');
    const token = await loginAs('sa-regex@example.com');

    // ".*" would match everything if the input were used as a raw pattern.
    const res = await call('GET', `/api/contacts/event/${event._id}?page=1&limit=10&search=.*`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.pagination.total, 0, 'search input must not be executed as a regex');
  });

  test('the page size is capped so one request cannot pull the collection', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 25);
    await seedAccount('SuperAdmin', 'sa-cap@example.com');
    const token = await loginAs('sa-cap@example.com');

    const res = await call('GET', `/api/contacts/event/${event._id}?page=1&limit=100000`, { token });
    assert.ok(res.body.pagination.limit <= 200, `limit should be capped, got ${res.body.pagination.limit}`);
  });

  test('event authorization is still enforced on the paginated path', async () => {
    const event = await makeEvent();
    await seedContacts(event._id, 5);
    await seedAccount('User', 'nope@example.com');
    const token = await loginAs('nope@example.com');

    const res = await call('GET', `/api/contacts/event/${event._id}?page=1&limit=10`, { token });
    assert.equal(res.status, 403);
  });

  test('a User only sees contacts for their own event via /api/contacts', async () => {
    const mine = await makeEvent({ eventName: 'Mine' });
    const theirs = await makeEvent({ eventName: 'Theirs' });
    await seedContacts(mine._id, 3);
    await seedContacts(theirs._id, 4);

    await seedAccount('User', 'scoped@example.com', { assignedEventId: mine._id });
    const token = await loginAs('scoped@example.com');

    const res = await call('GET', '/api/contacts?page=1&limit=50', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.pagination.total, 3, 'must not count another event’s contacts');
  });
});

/**
 * Event scoping of the guest list the Composer reads.
 *
 * The Composer's Guests dropdown is filled from GET /api/contacts/event/:id,
 * so the event boundary has to hold in the response itself — not in anything
 * the browser does with it afterwards. The cases below each seed TWO events
 * and assert on what is absent as well as what is present.
 */
describe('contacts are scoped to the event that was asked for', () => {
  /** Named so a leak from the other event is identifiable on sight. */
  const seedNamed = async (eventId: any, names: string[], prefix: number) => {
    await Contact.insertMany(
      names.map((fullName, i) => ({
        fullName,
        phoneNumber: `+9199${String(prefix).padStart(3, '0')}${String(100000 + i).padStart(6, '0')}`,
        countryCode: 'IN',
        eventId,
        source: 'Manual',
        status: 'Valid',
      }))
    );
  };

  const twoEvents = async (email: string) => {
    const eventA = await makeEvent({ eventName: 'Scoped A' });
    const eventB = await makeEvent({ eventName: 'Scoped B' });
    await seedNamed(eventA._id, ['Alice Anderson', 'Amit Agarwal'], 1);
    await seedNamed(eventB._id, ['Bob Brown', 'Bhavna Bose', 'Balaji Rao'], 2);
    await seedAccount('SuperAdmin', email);
    return { eventA, eventB, token: await loginAs(email) };
  };

  test('event A returns only event A guests', async () => {
    const { eventA, token } = await twoEvents('scope-a@example.com');

    const res = await call('GET', `/api/contacts/event/${eventA._id}`, { token });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((c: any) => c.fullName).sort(),
      ['Alice Anderson', 'Amit Agarwal']
    );
    // Stated separately: the count alone would still pass if a swap happened.
    assert.equal(
      res.body.some((c: any) => /Bob|Bhavna|Balaji/.test(c.fullName)),
      false,
      'no guest of the other event may appear'
    );
  });

  test('event B returns only event B guests', async () => {
    const { eventB, token } = await twoEvents('scope-b@example.com');

    const res = await call('GET', `/api/contacts/event/${eventB._id}`, { token });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((c: any) => c.fullName).sort(),
      ['Balaji Rao', 'Bhavna Bose', 'Bob Brown']
    );
    assert.equal(
      res.body.some((c: any) => /Alice|Amit/.test(c.fullName)),
      false,
      'no guest of the other event may appear'
    );
  });

  test('searching one event cannot surface a guest of another', async () => {
    const { eventA, token } = await twoEvents('scope-search@example.com');

    // "Bob" exists, but only in event B.
    const byName = await call(
      'GET',
      `/api/contacts/event/${eventA._id}?page=1&limit=50&search=Bob`,
      { token }
    );
    assert.equal(byName.status, 200);
    assert.equal(byName.body.data.length, 0, 'the other event stays out of reach through search');
    assert.equal(byName.body.pagination.total, 0);

    // The same holds for a number that belongs to the other event.
    const byNumber = await call(
      'GET',
      `/api/contacts/event/${eventA._id}?page=1&limit=50&search=99002100000`,
      { token }
    );
    assert.equal(byNumber.body.data.length, 0, 'searching by number does not cross events either');
  });

  test('an event with no guests comes back empty rather than falling back to a wider list', async () => {
    await twoEvents('scope-empty@example.com');
    const empty = await makeEvent({ eventName: 'Nobody Invited' });
    await seedAccount('SuperAdmin', 'scope-empty2@example.com');
    const token = await loginAs('scope-empty2@example.com');

    const plain = await call('GET', `/api/contacts/event/${empty._id}`, { token });
    assert.equal(plain.status, 200);
    assert.deepEqual(plain.body, [], 'an empty event is empty, not everyone');

    const paged = await call('GET', `/api/contacts/event/${empty._id}?page=1&limit=10`, { token });
    assert.equal(paged.body.data.length, 0);
    assert.equal(paged.body.pagination.total, 0);
  });

  test('the same person invited to both events is two separate guests', async () => {
    /**
     * The unique index is { eventId, phoneNumber }, so one number may legitimately
     * exist under several events as distinct documents. Each event must return its
     * own, which is what makes a shared guest look like a leak when it is not.
     */
    const eventA = await makeEvent({ eventName: 'Shared A' });
    const eventB = await makeEvent({ eventName: 'Shared B' });
    const shared = { phoneNumber: '+919121604967', countryCode: 'IN', source: 'Manual', status: 'Valid' };
    await Contact.insertMany([
      { ...shared, fullName: 'Sashi', eventId: eventA._id },
      { ...shared, fullName: 'Sashi', eventId: eventB._id },
    ]);
    await seedAccount('SuperAdmin', 'scope-shared@example.com');
    const token = await loginAs('scope-shared@example.com');

    const a = await call('GET', `/api/contacts/event/${eventA._id}`, { token });
    const b = await call('GET', `/api/contacts/event/${eventB._id}`, { token });
    assert.equal(a.body.length, 1);
    assert.equal(b.body.length, 1);
    assert.notEqual(a.body[0]._id, b.body[0]._id, 'they are distinct records, one per event');
    assert.equal(a.body[0].eventId, String(eventA._id), 'each carries its own event');
    assert.equal(b.body[0].eventId, String(eventB._id));
  });
});
