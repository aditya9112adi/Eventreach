import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Browser access from a Vercel preview deployment, end to end.
 *
 * A browser only lets a page read an API response when the response says that
 * page's origin is allowed (Access-Control-Allow-Origin). The login page of a
 * preview deployment runs on an origin that is not in FRONTEND_URL, so the
 * preflight the browser sends first (OPTIONS /api/auth/login) came back
 * without that header and the login was blocked.
 *
 * These tests start the REAL compiled server (backend/dist/server.js) as a
 * child process - so the real middleware order is in play, not a copy of the
 * CORS setup - on a throwaway local database, and send it the same requests a
 * browser would. The child gets a minimal environment of fake values and an
 * empty working directory, so no .env file and no real credential can reach
 * it, and it is never pointed at anything but 127.0.0.1.
 *
 * Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);

const PREVIEW = 'https://eventreach-frontend-git-release-743904-aditya9112adis-projects.vercel.app';
const PRODUCTION = 'https://eventreach-frontend-zeta.vercel.app';
const SECOND_FRONTEND = 'https://app.example.com';
const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_corspreview_${Date.now()}`;
const SERVER = path.resolve('backend/dist/server.js');

interface Booted {
  port: number;
  proc: ChildProcess;
  output: () => string;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eventreach-cors-'));

const boot = async (env: Record<string, string>): Promise<Booted> => {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    cwd: emptyCwd,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      NODE_ENV: 'development',
      PORT: String(port),
      MONGODB_URI: TEST_DB,
      JWT_SECRET: 'integration-test-only-secret',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (chunk) => (log += chunk));
  proc.stderr?.on('data', (chunk) => (log += chunk));
  const booted: Booted = { port, proc, output: () => log };

  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    const up = await request(booted, 'GET', '/health').then((r) => r.status === 200, () => false);
    if (up) {
      // The configuration report is written just after the server starts listening.
      for (let j = 0; j < 40 && !/Email transport/.test(log); j++) await new Promise((r) => setTimeout(r, 50));
      return booted;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  throw new Error(`server did not start:\n${log}`);
};

let ipSeq = 0;
const request = (
  server: Booted,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: p,
        method,
        headers: {
          // The rate limiter keys on this header, so each request is its own client.
          'CF-Connecting-IP': `198.51.100.${(++ipSeq % 250) + 1}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

/** The preflight a browser sends before a cross-origin JSON login. */
const preflight = (server: Booted, origin: string, requestHeaders = 'content-type') =>
  request(server, 'OPTIONS', '/api/auth/login', {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': requestHeaders,
  });

const login = (server: Booted, origin?: string) =>
  request(server, 'POST', '/api/auth/login', origin ? { Origin: origin } : {}, { email: 'nobody@example.com', password: 'not-a-real-password-1' });

const allows = (res: { headers: http.IncomingHttpHeaders }, origin: string) => res.headers['access-control-allow-origin'] === origin;
const lists = (value: string | string[] | undefined, token: string) => String(value ?? '').toLowerCase().split(/\s*,\s*/).includes(token.toLowerCase());

let configured: Booted; // production + a second frontend, plus the approved preview origin
let unconfigured: Booted; // what production runs today: no extra origins
let withBadEntries: Booted; // one valid extra origin among invalid ones
const servers: Booted[] = [];

before(async () => {
  [configured, unconfigured, withBadEntries] = await Promise.all([
    boot({ FRONTEND_URL: `${PRODUCTION},${SECOND_FRONTEND}`, CORS_EXTRA_ORIGINS: PREVIEW }),
    boot({ FRONTEND_URL: PRODUCTION }),
    boot({
      FRONTEND_URL: PRODUCTION,
      CORS_EXTRA_ORIGINS: [
        '*',
        'https://*.vercel.app',
        'http://insecure.example.com',
        'https://user:secret-pw-1234@creds.example.com',
        'https://paths.example.com/app',
        'not a url',
        'https://valid.example.com/',
      ].join(','),
    }),
  ]);
  servers.push(configured, unconfigured, withBadEntries);
});

after(async () => {
  for (const s of servers) s.proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  const mongoose = require('mongoose');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  fs.rmSync(emptyCwd, { recursive: true, force: true });
});

describe('the approved preview origin (CORS_EXTRA_ORIGINS)', () => {
  test('the login preflight is answered with that exact origin, credentials, the method and the headers', async () => {
    const res = await preflight(configured, PREVIEW);
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], PREVIEW, 'the exact origin, never *');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.ok(lists(res.headers['access-control-allow-methods'], 'POST'), `POST allowed: ${res.headers['access-control-allow-methods']}`);
    assert.ok(lists(res.headers['access-control-allow-headers'], 'content-type'), `content-type allowed: ${res.headers['access-control-allow-headers']}`);
    assert.ok(lists(res.headers.vary, 'Origin'), 'responses are cached per origin');
  });

  test('the headers the app sends after login (Authorization) are allowed too', async () => {
    const res = await preflight(configured, PREVIEW, 'authorization,content-type');
    assert.equal(res.status, 204);
    assert.ok(lists(res.headers['access-control-allow-headers'], 'authorization'));
    assert.ok(lists(res.headers['access-control-allow-headers'], 'content-type'));
  });

  test('the login response itself carries the header, so the browser lets the page read it', async () => {
    const res = await login(configured, PREVIEW);
    assert.ok([400, 401].includes(res.status), `unknown user is refused: ${res.status}`);
    assert.equal(res.headers['access-control-allow-origin'], PREVIEW);
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  test('other methods the app uses are allowed from it', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request(configured, 'OPTIONS', '/api/events', { Origin: PREVIEW, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization' });
      assert.equal(res.status, 204, method);
      assert.ok(lists(res.headers['access-control-allow-methods'], method), method);
    }
  });
});

describe('existing origins keep working', () => {
  test('every FRONTEND_URL entry is still allowed', async () => {
    for (const origin of [PRODUCTION, SECOND_FRONTEND]) {
      const res = await preflight(configured, origin);
      assert.equal(res.status, 204);
      assert.ok(allows(res, origin), origin);
      assert.ok(allows(await login(configured, origin), origin), `${origin} login`);
    }
  });

  test('a server with no extra origins (how production runs today) still serves its frontend', async () => {
    const res = await preflight(unconfigured, PRODUCTION);
    assert.equal(res.status, 204);
    assert.ok(allows(res, PRODUCTION));
  });
});

describe('everything else stays blocked', () => {
  const blocked = [
    ['an unrelated site', 'https://evil.example'],
    ['a lookalike that merely starts with the approved host', `${PREVIEW}.evil.com`],
    ['a lookalike that embeds the approved host', 'https://evil.com/' + PREVIEW.replace('https://', '')],
    ['another preview of the same project', 'https://eventreach-frontend-git-other-branch-aditya9112adis-projects.vercel.app'],
    ['another Vercel site', 'https://someone-elses-app.vercel.app'],
    ['the approved host over plain http', PREVIEW.replace('https://', 'http://')],
    ['the approved host on another port', `${PREVIEW}:8443`],
    ['an opaque origin', 'null'],
  ] as const;

  for (const [label, origin] of blocked) {
    test(`${label} gets no permission`, async () => {
      const res = await preflight(configured, origin);
      // Without Access-Control-Allow-Origin a browser refuses the response. (The cors library
      // sends Access-Control-Allow-Credentials whenever credentials are enabled; alone it grants nothing.)
      assert.equal(res.headers['access-control-allow-origin'], undefined, `preflight from ${origin}`);
      const actual = await login(configured, origin);
      assert.equal(actual.headers['access-control-allow-origin'], undefined, `login response to ${origin}`);
    });
  }

  test('a request with no Origin (server to server, curl) is unaffected and gets no CORS headers', async () => {
    const res = await login(configured);
    assert.ok([400, 401].includes(res.status));
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

describe('without the setting, the preview origin is refused - the reported failure', () => {
  test('the preflight is answered but without Access-Control-Allow-Origin, so a browser blocks the login', async () => {
    const res = await preflight(unconfigured, PREVIEW);
    assert.equal(res.status, 204, 'not an error status: the layer that decides is the origin allowlist');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

describe('bad CORS_EXTRA_ORIGINS entries', () => {
  test('wildcards, http, credentials, paths and junk are ignored; a valid entry beside them still works', async () => {
    assert.ok(allows(await preflight(withBadEntries, 'https://valid.example.com'), 'https://valid.example.com'), 'the valid entry works (trailing slash tolerated)');
    for (const origin of ['https://anything.vercel.app', 'https://paths.example.com', 'https://creds.example.com', 'http://insecure.example.com']) {
      assert.equal((await preflight(withBadEntries, origin)).headers['access-control-allow-origin'], undefined, origin);
    }
    assert.ok(allows(await preflight(withBadEntries, PRODUCTION), PRODUCTION), 'FRONTEND_URL is unaffected');
  });

  test('the startup log counts what was ignored and why, and never echoes an entry', async () => {
    const log = withBadEntries.output();
    assert.match(log, /CORS_EXTRA_ORIGINS: ignored 6 invalid entries/);
    assert.match(log, /CORS_EXTRA_ORIGINS: 1 extra origin allowed: https:\/\/valid\.example\.com/);
    for (const secret of ['secret-pw-1234', 'user:', 'paths.example.com/app', 'not a url']) assert.equal(log.includes(secret), false, `${secret} must not be logged`);
  });

  test('the approved origin is reported at startup so the setting can be checked', async () => {
    assert.match(configured.output(), new RegExp(`CORS_EXTRA_ORIGINS: 1 extra origin allowed: ${PREVIEW.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(unconfigured.output(), /CORS_EXTRA_ORIGINS/);
  });
});
