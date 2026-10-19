/**
 * The Dashboard page: the request it builds from the two filters, how it reads
 * the answer, and how the page is wired (no DOM test runner here, so the wiring
 * is checked in the source, as the other component tests do). The numbers
 * themselves are tested against the real server in tests/dashboardStats.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/utils/dashboardQuery.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  EMPTY_DASHBOARD_STATS,
  buildDashboardQuery,
  createLatestGate,
  dashboardErrorMessage,
  readDashboardStats,
} from './dashboardQuery.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const ID = '64b7f0c2a1b2c3d4e5f60718';

describe('the request', () => {
  test('All sends no filter - never the text "All"', () => {
    assert.equal(buildDashboardQuery({ eventId: '', status: '' }), '');
    assert.equal(buildDashboardQuery({}), '');
    assert.equal(buildDashboardQuery({ eventId: null, status: null }), '');
    for (const all of ['All', 'all', ' ALL ']) assert.equal(buildDashboardQuery({ status: all }), '', all);
  });

  test('a status filters by status', () => {
    for (const status of ['Upcoming', 'Completed', 'Cancelled']) {
      assert.equal(buildDashboardQuery({ status }), `?status=${status}`);
    }
  });

  test('a selected event filters by that event', () => {
    assert.equal(buildDashboardQuery({ eventId: ID }), `?eventId=${ID}`);
  });

  test('the event wins when both are present, as the page treats them as exclusive', () => {
    assert.equal(buildDashboardQuery({ eventId: ID, status: 'Completed' }), `?eventId=${ID}`);
    assert.equal(buildDashboardQuery({ eventId: 'All', status: 'Completed' }), '?status=Completed');
  });

  test('values are encoded, not pasted into the URL', () => {
    assert.equal(buildDashboardQuery({ status: 'a&b=c' }), '?status=a%26b%3Dc');
  });
});

describe('the answer', () => {
  const good = { totalEvents: 58, totalContacts: 126, totalCampaigns: 4, messagesSent: 43, messagesDelivered: 28, messagesFailed: 10, messagesPending: 10 };

  test('a complete answer is shown exactly as sent, zeros included', () => {
    assert.deepEqual(readDashboardStats(good), good);
    assert.deepEqual(readDashboardStats({ ...EMPTY_DASHBOARD_STATS }), EMPTY_DASHBOARD_STATS);
  });

  test('an incomplete or malformed answer is an error, not a set of zeros', () => {
    assert.equal(readDashboardStats(null), null);
    assert.equal(readDashboardStats(undefined), null);
    assert.equal(readDashboardStats('ok'), null);
    assert.equal(readDashboardStats({}), null);
    const { messagesFailed, ...partial } = good;
    void messagesFailed;
    assert.equal(readDashboardStats(partial), null);
    assert.equal(readDashboardStats({ ...good, messagesSent: '43' }), null);
    assert.equal(readDashboardStats({ ...good, totalEvents: NaN }), null);
    assert.equal(readDashboardStats({ ...good, totalContacts: -1 }), null);
  });

  test('the empty state is all zeros and is never the same object as one that was shown', () => {
    assert.deepEqual(Object.values(EMPTY_DASHBOARD_STATS), [0, 0, 0, 0, 0, 0, 0]);
    const shown = readDashboardStats(good)!;
    assert.notEqual(shown, good);
  });

  test("the server's own message is shown when it gave one", () => {
    assert.equal(dashboardErrorMessage({ response: { data: { error: 'Invalid status filter.' } } }), 'Invalid status filter.');
    assert.match(dashboardErrorMessage(new Error('Network Error')), /could not be loaded/);
    assert.match(dashboardErrorMessage(undefined), /could not be loaded/);
  });
});

describe('stale answers', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A request as the page makes it: take a token, wait for the answer, show it only if still the latest. */
  const request = async (gate: ReturnType<typeof createLatestGate>, label: string, ms: number, shown: string[]) => {
    const token = gate.next();
    await wait(ms);
    if (!gate.isLatest(token)) return;
    shown.push(label);
  };

  test('a slow answer to an earlier filter never replaces the answer to the current one', async () => {
    const gate = createLatestGate();
    const shown: string[] = [];
    // "All" is slow; "Completed" is chosen straight after and answers first.
    await Promise.all([request(gate, 'All', 40, shown), request(gate, 'Completed', 5, shown)]);
    assert.deepEqual(shown, ['Completed'], 'the late "All" answer was dropped, not shown after "Completed"');
  });

  test('requests that finish in order are each shown', async () => {
    const gate = createLatestGate();
    const shown: string[] = [];
    await request(gate, 'All', 1, shown);
    await request(gate, 'Upcoming', 1, shown);
    assert.deepEqual(shown, ['All', 'Upcoming']);
  });

  test('only the newest of three overlapping requests is shown, whatever order they finish in', async () => {
    const gate = createLatestGate();
    const shown: string[] = [];
    await Promise.all([request(gate, 'first', 30, shown), request(gate, 'second', 5, shown), request(gate, 'third', 15, shown)]);
    assert.deepEqual(shown, ['third']);
  });

  test('a token is never reused, and one gate does not affect another', () => {
    const a = createLatestGate();
    const b = createLatestGate();
    const [t1, t2] = [a.next(), a.next()];
    assert.notEqual(t1, t2);
    assert.equal(a.isLatest(t1), false);
    assert.equal(a.isLatest(t2), true);
    const u1 = b.next();
    assert.equal(b.isLatest(u1), true);
    assert.equal(a.isLatest(t2), true);
  });
});

describe('leaving the page', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * One load as the page makes it: a token, the numbers (which succeed or fail) and the
   * event list (which succeeds or fails), each applied only while the token is the latest.
   */
  const load = (gate: ReturnType<typeof createLatestGate>, applied: string[], ms: number, outcome: { stats: 'ok' | 'fail'; events: 'ok' | 'fail' }) => {
    const token = gate.next();
    const isLatest = () => gate.isLatest(token);
    const events = wait(ms).then(() => {
      if (outcome.events === 'fail') throw new Error('events failed');
      if (isLatest()) applied.push('events');
    }).catch(() => undefined);
    const stats = (async () => {
      try {
        await wait(ms);
        if (outcome.stats === 'fail') throw new Error('stats failed');
        if (!isLatest()) return;
        applied.push('stats');
      } catch {
        if (!isLatest()) return;
        applied.push('error');
      } finally {
        if (isLatest()) applied.push('loaded');
      }
    })();
    return Promise.all([events, stats]);
  };

  test('with no unmount, a load applies everything (so the cases below are not vacuous)', async () => {
    const gate = createLatestGate();
    const applied: string[] = [];
    await load(gate, applied, 5, { stats: 'ok', events: 'ok' });
    assert.deepEqual([...applied].sort(), ['events', 'loaded', 'stats']);
    const failed: string[] = [];
    await load(gate, failed, 5, { stats: 'fail', events: 'ok' });
    assert.deepEqual([...failed].sort(), ['error', 'events', 'loaded']);
  });

  test('unmounting drops a pending success, a pending failure and a pending event list', async () => {
    for (const outcome of [{ stats: 'ok', events: 'ok' }, { stats: 'fail', events: 'ok' }, { stats: 'ok', events: 'fail' }, { stats: 'fail', events: 'fail' }] as const) {
      const gate = createLatestGate();
      const applied: string[] = [];
      const pending = load(gate, applied, 20, outcome);
      gate.next(); // what the page's cleanup does when it unmounts
      await pending;
      assert.deepEqual(applied, [], JSON.stringify(outcome));
    }
  });

  test('a request made after a remount is not dropped by the earlier unmount', async () => {
    const gate = createLatestGate();
    const applied: string[] = [];
    const first = load(gate, applied, 20, { stats: 'ok', events: 'ok' });
    gate.next();                                                          // unmount
    const second = load(gate, applied, 5, { stats: 'ok', events: 'ok' }); // the page mounts again and loads
    await Promise.all([first, second]);
    assert.deepEqual([...applied].sort(), ['events', 'loaded', 'stats'], 'only the second load, once each');
  });
});

describe('how the page is wired', () => {
  const page = read('frontend/src/pages/Dashboard.tsx');

  test('the request comes from the helper, so every filter is sent the same way', () => {
    assert.ok(page.includes('buildDashboardQuery({ eventId: selectedEventId, status: statusFilter })'));
    assert.equal(page.includes("'?status=' + statusFilter"), false);
    assert.equal(page.includes("'?eventId=' + selectedEventId"), false);
  });

  test('"All" in the dropdown is the empty status', () => {
    assert.ok(page.includes("{ label: 'All', value: '' }"));
  });

  test('the cards and the charts are refetched whenever either filter changes', () => {
    assert.ok(page.includes('}, [statusFilter, selectedEventId, requestGate]);'), 'both filters, and only them plus the stable request gate');
    assert.ok(page.includes('fetchAll();\n  }, [fetchAll]);'));
    assert.ok(page.includes("api.get('/dashboard/stats' + query)"));
    assert.ok(page.includes("api.get('/dashboard/activity' + query)"));
  });

  test('choosing a status clears the event and choosing an event clears the status', () => {
    assert.ok(page.includes("setStatusFilter(e.target.value as ('' | EventStatus)); setSelectedEventId('');"));
    assert.ok(page.includes("setSelectedEventId(id); setStatusFilter('');"));
  });

  test('an answer to an earlier filter that arrives late is ignored', () => {
    assert.ok(page.includes('const requestId = requestGate.next();'));
    assert.ok(page.includes('const isLatest = () => requestGate.isLatest(requestId);'));
    assert.equal((page.match(/if \(!isLatest\(\)\) return;/g) ?? []).length, 2, 'after the answer, and in the failure path');
    assert.ok(page.includes('if (isLatest()) setIsLoading(false);'));
  });

  test('the gate lives in a ref, which React keeps for the life of the component - not in useMemo', () => {
    assert.ok(page.includes('const gateRef = useRef<ReturnType<typeof createLatestGate> | null>(null);'));
    assert.ok(page.includes('if (gateRef.current === null) gateRef.current = createLatestGate();'));
    assert.ok(page.includes('const requestGate = gateRef.current;'));
    assert.equal(/useMemo\s*\(/.test(page), false, 'no useMemo call');
    assert.equal(/import \{[^}]*useMemo[^}]*\} from 'react'/.test(page), false, 'not imported');
  });

  test('leaving the page invalidates whatever is still in flight, and filter changes do not', () => {
    assert.ok(page.includes('useEffect(() => () => { requestGate.next(); }, [requestGate]);'));
    // The cleanup depends on the gate alone, so a new filter does not run it; fetchAll invalidates by taking a new token.
    assert.ok(page.includes('}, [statusFilter, selectedEventId, requestGate]);'));
  });

  test('a failed or incomplete load shows an error with Try again, and clears the previous numbers', () => {
    assert.ok(page.includes('readDashboardStats(statsRes.data)'));
    assert.ok(page.includes("throw new Error('The dashboard statistics were incomplete.')"));
    assert.ok(page.includes('setStats(EMPTY_DASHBOARD_STATS);'));
    assert.ok(page.includes('setChartData([]);'));
    assert.ok(page.includes('setRecentCampaigns([]);'));
    assert.ok(page.includes('setLoadError(dashboardErrorMessage(error));'));
    assert.ok(page.includes("<div role='alert'"));
    assert.ok(page.includes('onClick={fetchAll}>Try again'));
  });

  test('the cards and charts are not drawn while there is an error', () => {
    assert.ok(page.includes('{loadError ? ('));
    assert.ok(page.indexOf('{loadError ? (') < page.indexOf('{/* Stat Cards */}'));
    assert.ok(page.indexOf('{/* Stat Cards */}') < page.indexOf(')}\n\n    </div>'));
  });

  test('the event list failing does not stop the numbers', () => {
    assert.ok(page.includes("api.get('/events')"));
    assert.ok(page.includes(".catch((error) => console.error('Failed to fetch events', error));"));
    assert.equal(page.includes("api.get('/events'),\n      ]"), false);
  });

  test('the cards still show every figure the server sends, with no arithmetic on them', () => {
    for (const field of ['totalEvents', 'totalContacts', 'totalCampaigns', 'messagesSent', 'messagesDelivered', 'messagesFailed', 'messagesPending']) {
      assert.ok(page.includes(`stats.${field}`), field);
    }
    assert.equal(/stats\.\w+\s*[-+*/]\s*stats\./.test(page), false);
  });

  test('live updates still refetch', () => {
    for (const event of ['dashboard-updated', 'EVENT_ASSIGNMENT_CHANGED', 'event-status-changed']) {
      assert.ok(page.includes(`socket.on('${event}', handleUpdate)`), event);
    }
  });
});
