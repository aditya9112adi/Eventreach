/**
 * Sign-in when the API is asleep - the logic (pure; no browser needed) and how
 * the sign-in path is wired.
 *
 * Run: npx tsx --test frontend/src/utils/loginWait.test.ts
 */
import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  LOGIN_TIMEOUT_MS,
  WAKE_NOTICE,
  WAKE_NOTICE_AFTER_MS,
  apiRootFromBase,
  loginErrorMessage,
  loginWaitNotice,
  resetWarmUpForTests,
  warmUpApi,
} from './loginWait.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

describe('waiting message', () => {
  test('nothing for a normal sign-in; an explanation once it is clearly waiting on a sleeping server', () => {
    assert.equal(loginWaitNotice(0), null);
    assert.equal(loginWaitNotice(WAKE_NOTICE_AFTER_MS - 1), null);
    assert.equal(loginWaitNotice(WAKE_NOTICE_AFTER_MS), WAKE_NOTICE);
    assert.match(WAKE_NOTICE, /starting up/);
  });

  test('the timeout is longer than a measured cold start (~43 s) but finite', () => {
    assert.ok(LOGIN_TIMEOUT_MS > 60_000);
    assert.ok(LOGIN_TIMEOUT_MS <= 120_000);
  });
});

describe('error messages name the cause', () => {
  test('the server\'s own message wins - invalid credentials, pending approval, "starting up"', () => {
    assert.equal(loginErrorMessage({ response: { status: 401, data: { error: 'Invalid credentials' } } }), 'Invalid credentials');
    assert.equal(loginErrorMessage({ response: { status: 503, data: { error: 'The server is starting up. Please try again in a moment.' } } }), 'The server is starting up. Please try again in a moment.');
  });

  test('a timeout and an unreachable server are different messages', () => {
    const timeout = loginErrorMessage({ code: 'ECONNABORTED', message: 'timeout of 90000ms exceeded' });
    const network = loginErrorMessage({ message: 'Network Error' });
    assert.match(timeout, /took too long/);
    assert.match(network, /Could not reach the server/);
    assert.notEqual(timeout, network);
  });

  test('anything else is generic, and never leaks a raw error', () => {
    assert.equal(loginErrorMessage({ response: { status: 500, data: {} } }), 'Something went wrong. Please try again.');
    assert.equal(loginErrorMessage(undefined), 'Could not reach the server. Check your connection and try again.');
    assert.equal(loginErrorMessage({ response: { status: 500, data: { error: 5 } } }).includes('5'), false);
  });
});

describe('waking the server early', () => {
  beforeEach(() => resetWarmUpForTests());

  test('the API root is the base URL without /api', () => {
    assert.equal(apiRootFromBase('https://eventreach-api.example.com/api'), 'https://eventreach-api.example.com');
    assert.equal(apiRootFromBase('http://localhost:5000/api'), 'http://localhost:5000');
    assert.equal(apiRootFromBase(undefined), null);
    assert.equal(apiRootFromBase('not a url'), null);
  });

  test('one GET to /health - no credentials, no cookies, no cache - and only once per page load', () => {
    const calls: { url: string; init: any }[] = [];
    const fake = (async (url: string, init: any) => { calls.push({ url, init }); return {} as Response; }) as unknown as typeof fetch;
    assert.equal(warmUpApi('https://api.example.com/api', fake), true);
    assert.equal(warmUpApi('https://api.example.com/api', fake), false, 'never repeated');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example.com/health');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.mode, 'no-cors');
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers, undefined, 'no Authorization header');
  });

  test('a failed ping is ignored: it can never block or break the page', async () => {
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    assert.equal(warmUpApi('https://api.example.com/api', failing), true);
    await new Promise((r) => setImmediate(r));
    const throwsSync = (() => { throw new Error('boom'); }) as unknown as typeof fetch;
    resetWarmUpForTests();
    assert.doesNotThrow(() => warmUpApi('https://api.example.com/api', throwsSync));
  });

  test('no base URL or no fetch: nothing is sent', () => {
    assert.equal(warmUpApi(undefined, (async () => ({})) as unknown as typeof fetch), false);
    assert.equal(warmUpApi('https://api.example.com/api', null), false);
  });
});

describe('the sign-in path is wired so nothing unrelated can hold it up', () => {
  const login = read('frontend/src/pages/Login.tsx');
  const store = read('frontend/src/store/authStore.tsx');
  const socket = read('frontend/src/contexts/SocketContext.tsx');
  const app = read('frontend/src/App.tsx');

  test('Login warms the server on open, passes the timeout, shows the wait notice and always clears it', () => {
    assert.ok(login.includes('warmUpApi(api.defaults.baseURL);'));
    assert.ok(login.includes("api.post('/auth/login', data, { timeout: LOGIN_TIMEOUT_MS })"));
    assert.ok(login.includes('window.setTimeout(() => setWaitNotice(loginWaitNotice(WAKE_NOTICE_AFTER_MS)), WAKE_NOTICE_AFTER_MS)'));
    assert.ok(/finally \{[\s\S]*?clearTimeout\(waitTimer\.current\)[\s\S]*?setWaitNotice\(null\)/.test(login));
    assert.ok(login.includes('setApiError(loginErrorMessage(error))'));
    assert.ok(login.includes('role="status"'), 'announced to screen readers');
  });

  test('signing in navigates as soon as the server answers: it does not wait for sockets, events or dashboard data', () => {
    assert.ok(/const response = await api\.post\('\/auth\/login'[\s\S]*?login\(response\.data\.token, response\.data\.user\);\s*navigate\('\/dashboard'\);/.test(login));
    assert.equal(/socket|Socket|dashboard\/|\/events/.test(login.replace("navigate('/dashboard')", '')), false, 'Login knows nothing of sockets or dashboard data');
  });

  test('the profile from sign-in is used as is: the session restore it triggers does not ask /auth/me again', () => {
    assert.ok(store.includes('freshSignIn.current = newToken;'));
    assert.ok(/if \(freshSignIn\.current === token\) \{\s*freshSignIn\.current = null;\s*setIsLoading\(false\);\s*return;\s*\}/.test(store));
    // A page load with a stored session still revalidates it.
    assert.ok(store.includes("const response = await api.get('/auth/me');"));
  });

  test('the route guard waits on the session only - never on the socket', () => {
    const guard = app.slice(app.indexOf('const ProtectedRoute'), app.indexOf('// Separate component'));
    assert.ok(guard.includes('const { user, isLoading } = useAuth();'));
    assert.equal(/useSocket|isConnected/.test(guard), false);
    assert.equal(/useSocket|SocketContext/.test(store), false, 'the auth store does not depend on the socket');
  });

  test('a socket that fails to connect only logs: it cannot block or fail sign-in', () => {
    const start = socket.indexOf("socketInstance.on('connect_error'");
    const handler = socket.slice(start, socket.indexOf('});', start) + 3);
    assert.ok(handler.includes('console.warn('));
    assert.ok(handler.includes('setIsConnected(false)'));
    const code = handler.replace(/\/\/.*$/gm, ''); // comments may mention logging out
    assert.equal(/throw|navigate|logout|login\(/.test(code), false, 'its failure path leaves the page and the session alone');
    assert.ok(socket.includes('if (!token) {'), 'nothing connects while signed out');
  });
});
