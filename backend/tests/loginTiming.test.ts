/**
 * Stage timing and the database-readiness wait - pure unit tests.
 *
 * Run: npx tsx --test backend/tests/loginTiming.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createStageTimer, logTiming } from '../src/utils/stageTimer';
import { waitForConnected, waitForDatabase } from '../src/middleware/databaseReady';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stage timer', () => {
  test('records each stage once, in order, with a total that covers them', async () => {
    const timer = createStageTimer();
    await sleep(15);
    timer.mark('first');
    await sleep(15);
    timer.mark('second');
    const { totalMs, stages } = timer.summary();
    assert.deepEqual(Object.keys(stages), ['first', 'second']);
    assert.ok(stages.first >= 10 && stages.second >= 10);
    assert.ok(totalMs >= stages.first + stages.second - 1);
  });

  test('the log line is one JSON object with the request id, outcome and numbers - nothing personal', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const timer = createStageTimer();
      timer.mark('account_lookup');
      logTiming('login_timing', 'req-123', 'success', timer);
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(parsed), ['login_timing']);
    assert.deepEqual(Object.keys(parsed.login_timing).sort(), ['outcome', 'requestId', 'stages', 'totalMs']);
    assert.equal(parsed.login_timing.requestId, 'req-123');
    assert.equal(parsed.login_timing.outcome, 'success');
    assert.equal(typeof parsed.login_timing.stages.account_lookup, 'number');
  });
});

const fakeConnection = (readyState: number) => {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { readyState, once: emitter.once.bind(emitter), off: emitter.off.bind(emitter) });
};

describe('waiting for the database', () => {
  test('already connected: no wait at all', async () => {
    assert.equal(await waitForConnected(fakeConnection(1), 1000), true);
  });

  test('connecting: resolves the moment it connects, and cleans up its listener and timer', async () => {
    const connection = fakeConnection(2);
    const started = Date.now();
    const pending = waitForConnected(connection, 5000);
    setTimeout(() => { connection.readyState = 1; connection.emit('connected'); }, 30);
    assert.equal(await pending, true);
    assert.ok(Date.now() - started < 1000, 'did not sit out the timeout');
    assert.equal(connection.listenerCount('connected'), 0, 'no listener left behind');
  });

  test('never connects: gives up after the bound with false, and cleans up', async () => {
    const connection = fakeConnection(0);
    assert.equal(await waitForConnected(connection, 40), false);
    assert.equal(connection.listenerCount('connected'), 0);
  });

  test('the middleware passes straight through when connected, and for /health at any time', async () => {
    let nexts = 0;
    const next = () => { nexts += 1; };
    await waitForDatabase({ connection: fakeConnection(1), maxWaitMs: 10 })({ path: '/api/auth/login' } as any, {} as any, next);
    await waitForDatabase({ connection: fakeConnection(0), maxWaitMs: 10 })({ path: '/health' } as any, {} as any, next);
    assert.equal(nexts, 2);
  });

  test('not connected in time: a clear 503 with Retry-After, and the route never runs', async () => {
    let nexts = 0;
    const headers: Record<string, string> = {};
    let status = 0;
    let body: any;
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: (code: number) => { status = code; return res; },
      json: (payload: any) => { body = payload; return res; },
    };
    await waitForDatabase({ connection: fakeConnection(0), maxWaitMs: 30 })({ path: '/api/auth/login' } as any, res, () => { nexts += 1; });
    assert.equal(nexts, 0);
    assert.equal(status, 503);
    assert.equal(headers['Retry-After'], '5');
    assert.match(body.error, /starting up/);
  });
});
