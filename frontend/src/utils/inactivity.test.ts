/**
 * Signing an unattended session out.
 *
 * The monitor is driven here with its own clock and its own event target, so
 * these are the real timing and listener rules rather than a description of
 * them. The React wiring that cannot run without a DOM is asserted from the
 * layout's source at the end.
 *
 * Run: npx tsx --test frontend/src/utils/inactivity.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  createInactivityMonitor,
  isSessionEndedBroadcast,
  isTokenCleared,
  INACTIVITY_TIMEOUT_MS,
  INACTIVITY_MESSAGE,
  LOGOUT_BROADCAST_KEY,
  ACTIVITY_EVENTS,
} from './inactivity.ts';

/** A clock the test moves by hand, so ten minutes take no time to pass. */
const fakeClock = () => {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (handle: unknown) => {
      pending.delete(handle as number);
    },
    advance: (ms: number) => {
      now += ms;
      for (const [id, task] of [...pending.entries()]) {
        if (task.at <= now) {
          pending.delete(id);
          task.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
};

/** A stand-in for window/document that records what is attached to it. */
const fakeTarget = () => {
  const listeners = new Map<string, Set<(e?: any) => void>>();
  return {
    visibilityState: 'visible',
    addEventListener(type: string, fn: (e?: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e?: any) => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    total: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    typesAttached: () => [...listeners.entries()].filter(([, s]) => s.size > 0).map(([t]) => t),
  };
};

const build = (overrides: any = {}) => {
  const clock = fakeClock();
  const target = fakeTarget();
  const doc = fakeTarget();
  let timeouts = 0;
  const monitor = createInactivityMonitor({
    onTimeout: () => { timeouts += 1; },
    target,
    doc,
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...overrides,
  });
  return { monitor, clock, target, doc, fired: () => timeouts };
};

test('the period is stated once', () => {
  assert.equal(INACTIVITY_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(INACTIVITY_MESSAGE, 'You have been logged out due to inactivity.');
});

test('an authenticated session is watched', async (t) => {
  await t.test('starting attaches the watch and arms the clock', () => {
    const { monitor, clock, target, doc } = build();
    assert.equal(monitor.isRunning(), false, 'nothing runs until it is started');
    assert.equal(clock.pendingCount(), 0);

    monitor.start();
    assert.equal(monitor.isRunning(), true);
    assert.equal(clock.pendingCount(), 1, 'exactly one timeout');
    assert.deepEqual(target.typesAttached().sort(), [...ACTIVITY_EVENTS].sort());
    assert.deepEqual(doc.typesAttached(), ['visibilitychange']);
  });

  await t.test('nothing happens a moment before the period is up', () => {
    const { monitor, clock, fired } = build();
    monitor.start();
    clock.advance(INACTIVITY_TIMEOUT_MS - 1);
    assert.equal(fired(), 0);
  });

  await t.test('ten minutes with no activity signs the session out', () => {
    const { monitor, clock, fired } = build();
    monitor.start();
    clock.advance(INACTIVITY_TIMEOUT_MS);
    assert.equal(fired(), 1);
  });

  await t.test('and it signs out once, not repeatedly', () => {
    const { monitor, clock, fired } = build();
    monitor.start();
    clock.advance(INACTIVITY_TIMEOUT_MS * 5);
    assert.equal(fired(), 1);
  });
});

test('activity puts the clock back', async (t) => {
  for (const event of ACTIVITY_EVENTS) {
    await t.test(`${event} counts as the user being there`, () => {
      const { monitor, clock, target, fired } = build();
      monitor.start();
      clock.advance(INACTIVITY_TIMEOUT_MS - 1000);
      target.fire(event);
      clock.advance(INACTIVITY_TIMEOUT_MS - 1000);
      assert.equal(fired(), 0, 'the period started again from the activity');
      clock.advance(1000);
      assert.equal(fired(), 1, 'and still elapses once they stop');
    });
  }

  await t.test('a tab brought back to the front counts too', () => {
    const { monitor, clock, doc, fired } = build();
    monitor.start();
    clock.advance(INACTIVITY_TIMEOUT_MS - 1000);
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    clock.advance(INACTIVITY_TIMEOUT_MS - 1);
    assert.equal(fired(), 0);
  });

  await t.test('a tab going to the background does not', () => {
    // Otherwise a session left hidden would never time out.
    const { monitor, clock, doc, fired } = build();
    monitor.start();
    clock.advance(INACTIVITY_TIMEOUT_MS - 1000);
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    clock.advance(1000);
    assert.equal(fired(), 1, 'the original period still ran out');
  });

  await t.test('activity never leaves a second timeout behind', () => {
    const { monitor, clock, target } = build();
    monitor.start();
    for (let i = 0; i < 50; i++) target.fire('mousemove');
    assert.equal(clock.pendingCount(), 1, 'one timeout however much the mouse moves');
  });
});

test('a session that ends on purpose is not watched any longer', async (t) => {
  await t.test('stopping cancels the pending timeout', () => {
    const { monitor, clock, fired } = build();
    monitor.start();
    monitor.stop();
    assert.equal(clock.pendingCount(), 0);
    clock.advance(INACTIVITY_TIMEOUT_MS * 2);
    assert.equal(fired(), 0, 'no stale sign-out after the user left deliberately');
  });

  await t.test('stopping removes every listener', () => {
    const { monitor, target, doc } = build();
    monitor.start();
    assert.ok(target.total() > 0 && doc.total() > 0);
    monitor.stop();
    assert.equal(target.total(), 0, 'nothing left on window');
    assert.equal(doc.total(), 0, 'nothing left on document');
    assert.equal(monitor.listenerCount(), 0);
  });

  await t.test('activity after stopping does nothing', () => {
    const { monitor, clock, target, fired } = build();
    monitor.start();
    monitor.stop();
    target.fire('mousemove');
    assert.equal(clock.pendingCount(), 0, 'a stray event cannot restart it');
    assert.equal(fired(), 0);
  });

  await t.test('signing out and in again gives a fresh period', () => {
    const { monitor, clock, fired } = build();
    monitor.start();
    clock.advance(INACTIVITY_TIMEOUT_MS - 1);
    monitor.stop();                       // manual logout
    monitor.start();                      // signed in again
    clock.advance(INACTIVITY_TIMEOUT_MS - 1);
    assert.equal(fired(), 0, 'the new period is a full ten minutes, not the remainder');
    clock.advance(1);
    assert.equal(fired(), 1);
  });
});

test('re-rendering cannot stack a second watch', async (t) => {
  await t.test('starting twice arms one timeout and one set of listeners', () => {
    const { monitor, clock, target, doc } = build();
    monitor.start();
    const listeners = target.total() + doc.total();
    const tracked = monitor.listenerCount();
    monitor.start();
    monitor.start();
    assert.equal(clock.pendingCount(), 1, 'still a single timeout');
    assert.equal(target.total() + doc.total(), listeners, 'still a single set of listeners');
    // The browser drops a repeated (type, fn) pair, so the count above cannot
    // see a second registration — the monitor's own bookkeeping can.
    assert.equal(monitor.listenerCount(), tracked, 'and it has not registered the set twice');
  });

  await t.test('a repeated start still detaches everything in one stop', () => {
    const { monitor, target, doc } = build();
    monitor.start();
    monitor.start();
    monitor.stop();
    assert.equal(target.total() + doc.total(), 0, 'no listener survives the single stop');
    assert.equal(monitor.listenerCount(), 0);
  });

  await t.test('and it still signs out exactly once', () => {
    const { monitor, clock, fired } = build();
    monitor.start();
    monitor.start();
    clock.advance(INACTIVITY_TIMEOUT_MS);
    assert.equal(fired(), 1);
  });

  await t.test('stopping a never-started monitor is harmless', () => {
    const { monitor, clock } = build();
    monitor.stop();
    assert.equal(clock.pendingCount(), 0);
    assert.equal(monitor.isRunning(), false);
  });
});

test('the other tabs find out', async (t) => {
  await t.test('the broadcast is recognised', () => {
    assert.equal(isSessionEndedBroadcast(LOGOUT_BROADCAST_KEY, '1791000000000'), true);
  });

  await t.test('a cleared token is recognised, whatever ended the session', () => {
    // Covers the Logout button in another tab as well as a timed-out one.
    assert.equal(isTokenCleared('token', null), true);
    assert.equal(isTokenCleared('token', ''), true);
  });

  await t.test('an unrelated storage write is ignored', () => {
    assert.equal(isSessionEndedBroadcast('theme', 'dark'), false);
    assert.equal(isTokenCleared('theme', null), false);
    assert.equal(isTokenCleared('token', 'a-new-token'), false, 'signing IN is not signing out');
    assert.equal(isSessionEndedBroadcast(LOGOUT_BROADCAST_KEY, null), false);
  });
});

/**
 * The React side cannot be rendered here — this repo has no DOM test runner —
 * so the wiring is asserted from the layout's source, as the report tests do.
 */
test('it is wired into the authenticated shell only', async (t) => {
  const layout = fs.readFileSync('frontend/src/layouts/DashboardLayout.tsx', 'utf-8');
  const app = fs.readFileSync('frontend/src/App.tsx', 'utf-8');

  await t.test('the watch lives in the layout behind ProtectedRoute', () => {
    assert.ok(layout.includes('createInactivityMonitor'), 'the layout starts the watch');
    assert.match(app, /<ProtectedRoute>\s*<DashboardLayout \/>/, 'which only renders once signed in');
  });

  await t.test('the public pages are outside that layout, so they are never watched', () => {
    for (const route of ['/login', '/register', '/forgot-password', '/reset-password']) {
      const line = app.split('\n').find((l) => l.includes(`path="${route}"`));
      assert.ok(line, `${route} is routed`);
      assert.ok(!line!.includes('DashboardLayout'), `${route} does not render the authenticated shell`);
    }
  });

  await t.test('it reuses the application logout rather than clearing storage itself', () => {
    const block = layout.slice(layout.indexOf('const endSession'), layout.indexOf('const endSessionRef'));
    assert.ok(block.includes('logout()'), 'the existing logout is what ends the session');
    assert.ok(!block.includes("removeItem('token')"), 'no second way of ending a session');
  });

  await t.test('the message is shown through the existing toast and the login banner', () => {
    assert.ok(layout.includes("showToast('warning', INACTIVITY_MESSAGE)"), 'the existing toast');
    assert.ok(layout.includes('state: { message: INACTIVITY_MESSAGE }'), 'and the existing login banner');
  });

  await t.test('it navigates before clearing the session, or the banner is lost', () => {
    /**
     * Clearing first leaves ProtectedRoute without a user, so it redirects with
     * <Navigate replace> and no state — landing on /login with no message.
     * Observed happening before this order was fixed.
     */
    const block = layout.slice(layout.indexOf('const endSession'), layout.indexOf('const endSessionRef'));
    const navigateAt = block.indexOf("navigate('/login'");
    const logoutAt = block.indexOf('logout();');
    assert.ok(navigateAt >= 0 && logoutAt >= 0, 'both happen');
    assert.ok(navigateAt < logoutAt, 'the redirect carrying the message comes first');
  });

  await t.test('the effect has no dependencies, so a re-render cannot restart it', () => {
    const effect = layout.slice(layout.indexOf('const monitor = createInactivityMonitor'));
    assert.ok(effect.includes('}, []);'), 'the mount effect depends on nothing');
    assert.ok(layout.includes('endSessionRef.current'), 'the callback is reached through a ref');
  });

  await t.test('it is torn down on unmount, which is what the Logout button causes', () => {
    const effect = layout.slice(layout.indexOf('const monitor = createInactivityMonitor'));
    assert.ok(effect.includes('monitor.stop()'), 'the timer is cancelled');
    assert.ok(effect.includes("removeEventListener('storage'"), 'and the cross-tab listener too');
  });

  await t.test('the period is imported, never written out again', () => {
    assert.ok(!layout.includes('600000'), 'no second copy of the period');
    assert.ok(!layout.includes('10 * 60 * 1000'));
  });
});
