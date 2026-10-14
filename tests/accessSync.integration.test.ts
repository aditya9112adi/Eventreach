import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * Real-time access sync, end to end: a Super Admin changes an account's access
 * over HTTP, and the affected account's open sockets are told - and nobody
 * else's. Real compiled backend (backend/dist), a real Socket.IO server and
 * real socket.io-client connections, on a throwaway database. No Meta, no
 * email, nothing leaves this machine.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_accesssync_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';
process.env.WHATSAPP_TOKEN = 'fake-token-never-real';
process.env.WHATSAPP_WABA_ID = '102290129340398';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: connect } = require('socket.io-client');

const adminRoutes = require('../backend/dist/routes/adminRoutes').default;
const authRoutes = require('../backend/dist/routes/authRoutes').default;
const whatsappRoutes = require('../backend/dist/routes/whatsappRoutes').default;
const { initSocket, getIO, ACCESS_CHANGED_EVENT } = require('../backend/dist/services/socketService');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');

let server: any;
let baseUrl = '';
let ip = 0;
const fx: any = {};
const sockets: any[] = [];

const call = (method: string, path: string, token: string | null, body?: any): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `203.0.113.${(ip++ % 250) + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(baseUrl + path);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const tokenFor = (account: any, role: string) => jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });

/** A connected socket that records every ACCESS_CHANGED it receives. */
const open = (token: string | null, extra: Record<string, unknown> = {}): Promise<{ socket: any; events: any[] }> =>
  new Promise((resolve, reject) => {
    const socket = connect(baseUrl, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true, ...extra });
    sockets.push(socket);
    const events: any[] = [];
    socket.on(ACCESS_CHANGED_EVENT, (payload: any) => events.push(payload));
    socket.on('connect', () => resolve({ socket, events }));
    socket.on('connect_error', (error: Error) => reject(error));
  });

/** Events are pushed after the HTTP answer: give the server a moment, then count. */
const settle = () => new Promise((r) => setTimeout(r, 150));

const grant = (token: string, id: string, enabled: boolean) => call('PUT', `/api/admin/admins/${id}/whatsapp-template-access`, token, { enabled });

before(async () => {
  await mongoose.connect(TEST_DB);
  const base = { passwordHash: 'x', status: 'Active' };
  fx.superAdmin = await Admin.create({ ...base, name: 'Super', email: 'super-sync@example.com', role: 'SuperAdmin' });
  fx.adminA = await Admin.create({ ...base, name: 'Admin A', email: 'a-sync@example.com', role: 'Admin' });
  fx.adminB = await Admin.create({ ...base, name: 'Admin B', email: 'b-sync@example.com', role: 'Admin' });
  fx.user = await User.create({ ...base, name: 'User', email: 'u-sync@example.com', adminId: fx.adminA._id });
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.a = tokenFor(fx.adminA, 'Admin');
  fx.b = tokenFor(fx.adminB, 'Admin');
  fx.u = tokenFor(fx.user, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  server = http.createServer(app);
  initSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const s of sockets) s.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  getIO().close();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  await Admin.updateMany({ role: 'Admin' }, { $unset: { canManageWhatsAppTemplates: 1 } });
  await Admin.updateMany({ role: 'Admin' }, { $set: { status: 'Active', isAccessCancelled: false } });
});

describe('a Super Admin changes Templates Access', () => {
  test('is saved, and then only that Admin\'s sockets - every tab - are told, with no permission data', async () => {
    const tab1 = await open(fx.a);
    const tab2 = await open(fx.a);
    const other = await open(fx.b);
    const user = await open(fx.u);
    const superAdmin = await open(fx.super);

    const res = await grant(fx.super, String(fx.adminA._id), true);
    assert.equal(res.status, 200);
    assert.equal(res.body.changed, true);
    assert.equal((await Admin.findById(fx.adminA._id)).canManageWhatsAppTemplates, true, 'persisted');
    await settle();

    for (const tab of [tab1, tab2]) {
      assert.equal(tab.events.length, 1, 'every open tab of the Admin is told once');
      assert.deepEqual(Object.keys(tab.events[0]).sort(), ['at', 'reason']);
      assert.equal(tab.events[0].reason, 'templates');
    }
    assert.equal(other.events.length, 0, 'another Admin is not told');
    assert.equal(user.events.length, 0, 'a User is not told');
    assert.equal(superAdmin.events.length, 0, 'the Super Admin\'s own room is not used');
    assert.equal(JSON.stringify(tab1.events).includes('canManage'), false, 'no permission values are pushed: the client asks the API');
  });

  test('revoking is pushed the same way, and the Admin is denied by the API straight away', async () => {
    assert.equal((await grant(fx.super, String(fx.adminA._id), true)).status, 200);
    assert.equal((await call('GET', '/api/whatsapp/templates', fx.a)).status, 200, 'allowed while granted');
    const tab = await open(fx.a);

    assert.equal((await grant(fx.super, String(fx.adminA._id), false)).status, 200);
    await settle();
    assert.equal(tab.events.length, 1);
    const denied = await call('GET', '/api/whatsapp/templates', fx.a);
    assert.equal(denied.status, 403, 'denied by the server, whatever the browser shows');
    assert.equal(denied.body.error.code, 'ACCESS_DENIED');
    assert.equal((await call('POST', '/api/whatsapp/templates', fx.a, {})).status, 403);
  });

  test('no event for a change that was not made: no-op, bad input, unknown account, a failed save', async () => {
    const tab = await open(fx.a);
    assert.equal((await grant(fx.super, String(fx.adminA._id), false)).body.changed, false, 'already off');
    assert.equal((await call('PUT', `/api/admin/admins/${fx.adminA._id}/whatsapp-template-access`, fx.super, { enabled: 'yes' })).status, 400);
    assert.equal((await grant(fx.super, String(new mongoose.Types.ObjectId()), true)).status, 404);
    assert.equal((await grant(fx.super, String(fx.superAdmin._id), true)).status, 400, 'a Super Admin has nothing to grant');

    const original = Admin.findByIdAndUpdate;
    Admin.findByIdAndUpdate = () => { throw new Error('database unavailable'); };
    try {
      assert.equal((await grant(fx.super, String(fx.adminA._id), true)).status, 500);
    } finally {
      Admin.findByIdAndUpdate = original;
    }
    await settle();
    assert.equal(tab.events.length, 0, 'a change that did not happen sends no success signal');
    assert.notEqual((await Admin.findById(fx.adminA._id)).canManageWhatsAppTemplates, true, 'nothing was saved');
  });

  test('an Admin cannot change anyone\'s access, and anonymous requests are refused; nobody is told', async () => {
    const tabB = await open(fx.b);
    assert.equal((await grant(fx.a, String(fx.adminB._id), true)).status, 403, 'an Admin cannot grant');
    assert.equal((await grant(fx.a, String(fx.adminA._id), true)).status, 403, 'not even to themselves');
    assert.equal((await grant(fx.u, String(fx.adminB._id), true)).status, 403);
    assert.equal((await call('PUT', `/api/admin/admins/${fx.adminB._id}/whatsapp-template-access`, null, { enabled: true })).status, 401);
    await settle();
    assert.equal(tabB.events.length, 0);
    assert.notEqual((await Admin.findById(fx.adminB._id)).canManageWhatsAppTemplates, true);
  });
});

describe('who can subscribe', () => {
  test('a connection needs a valid token for an active account', async () => {
    await assert.rejects(open(null), /missing token/);
    await assert.rejects(open('not-a-jwt'), /invalid token/);
    await assert.rejects(open(jwt.sign({ id: String(fx.adminA._id), role: 'Admin' }, 'a-different-secret')), /invalid token/);
    await Admin.updateOne({ _id: fx.adminB._id }, { $set: { isAccessCancelled: true } });
    await assert.rejects(open(fx.b), /not active/);
    await assert.rejects(open(jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: 'Admin' }, process.env.JWT_SECRET)), /not found/);
  });

  test('a client cannot join another account\'s room, by "identify", by the query string or by a spoofed id', async () => {
    const attacker = await open(fx.b);
    attacker.socket.emit('identify', String(fx.adminA._id));
    attacker.socket.emit('join', String(fx.adminA._id));
    const spoof = await open(fx.b, { query: { userId: String(fx.adminA._id), room: String(fx.adminA._id) } });
    await settle();

    assert.equal((await grant(fx.super, String(fx.adminA._id), true)).status, 200);
    await settle();
    assert.equal(attacker.events.length, 0);
    assert.equal(spoof.events.length, 0);
  });
});

describe('what an Admin reads back', () => {
  test('/auth/me is the database\'s answer after every change - including one made while they were offline', async () => {
    const me = async () => (await call('GET', '/api/auth/me', fx.a)).body.user.canManageWhatsAppTemplates;
    assert.equal(await me(), false);

    const tab = await open(fx.a);
    tab.socket.close(); // offline: the push cannot reach them
    await grant(fx.super, String(fx.adminA._id), true);
    await settle();
    assert.equal(tab.events.length, 0, 'an offline browser gets nothing');
    assert.equal(await me(), true, 'but reconnecting and asking the API gives the current state');

    const back = await open(fx.a);
    assert.equal(back.events.length, 0, 'a reconnect is not replayed events: the client re-reads instead');
    await grant(fx.super, String(fx.adminA._id), false);
    await settle();
    assert.equal(await me(), false);
    assert.equal(back.events.length, 1);
  });

  test('a stale or repeated push is harmless: the same answer every time, whatever order', async () => {
    const tab = await open(fx.a);
    await grant(fx.super, String(fx.adminA._id), true);
    await grant(fx.super, String(fx.adminA._id), false);
    await grant(fx.super, String(fx.adminA._id), true);
    await settle();
    assert.equal(tab.events.length, 3, 'each real change is pushed');
    for (let i = 0; i < 3; i++) {
      assert.equal((await call('GET', '/api/auth/me', fx.a)).body.user.canManageWhatsAppTemplates, true, 'the answer is the same however many events arrived');
    }
  });
});

describe('other access changes', () => {
  test('a password reset pushes "credentials" and the old session is refused by the API', async () => {
    const tab = await open(fx.a);
    // The token was issued before the reset: back-date it so the one-second slack cannot hide the change.
    const old = jwt.sign({ id: String(fx.adminA._id), email: fx.adminA.email, role: 'Admin', iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const res = await call('PUT', `/api/admin/users/${fx.adminA._id}/reset-password?type=Admin`, fx.super, { newPassword: 'BrandNewPass#2026x', confirmPassword: 'BrandNewPass#2026x' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await settle();
    assert.deepEqual(tab.events.map((e) => e.reason), ['credentials']);
    assert.equal((await call('GET', '/api/auth/me', old)).status, 401, 'the next re-read ends the session');
  });

  test('approve and reject notify the account\'s own room, after saving', async () => {
    const pending = await Admin.create({ name: 'Pending', email: 'p-sync@example.com', passwordHash: 'x', role: 'Admin', status: 'Pending', pendingAccessStartDate: new Date(), pendingAccessEndDate: new Date(Date.now() + 86400000) });
    const pendingToo = await Admin.create({ name: 'Pending2', email: 'p2-sync@example.com', passwordHash: 'x', role: 'Admin', status: 'Pending' });
    const rooms: { room: string; event: string }[] = [];
    const io = getIO();
    const originalTo = io.to.bind(io);
    io.to = (room: string) => {
      const target = originalTo(room);
      const emit = target.emit.bind(target);
      target.emit = (event: string, ...args: any[]) => { rooms.push({ room: String(room), event }); return emit(event, ...args); };
      return target;
    };
    try {
      const approved = await call('PUT', `/api/admin/users/${pending._id}/approve?type=Admin`, fx.super, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal((await Admin.findById(pending._id)).status, 'Active', 'saved first');
      const rejected = await call('PUT', `/api/admin/users/${pendingToo._id}/reject?type=Admin`, fx.super, { reason: 'No' });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    } finally {
      io.to = originalTo;
    }
    assert.ok(rooms.some((r) => r.room === String(pending._id) && r.event === ACCESS_CHANGED_EVENT), 'approval is pushed to that account');
    assert.ok(rooms.some((r) => r.room === String(pendingToo._id) && r.event === ACCESS_CHANGED_EVENT), 'rejection too');
    assert.equal(rooms.filter((r) => r.event === ACCESS_CHANGED_EVENT && ![String(pending._id), String(pendingToo._id)].includes(r.room)).length, 0, 'to nobody else');
  });
});
