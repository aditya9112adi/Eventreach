/**
 * Real-time access sync - the logic (pure; no browser needed) and how it is wired.
 *
 * Run: npx tsx --test frontend/src/utils/accessSync.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import type { User } from '@eventreach/shared';
import {
  ACCESS_REFRESH_INTERVAL_MS,
  accessChangeToasts,
  createRefreshCoordinator,
  diffAccess,
  nextAccessBoundaryDelay,
  profileFromStorageEvent,
  redirectTargetFor,
  sameProfile,
  shouldRefreshNow,
} from './accessSync.ts';
import { canSeeTemplatesPage } from './whatsappTemplates.ts';
import { shouldClearSession } from '../services/authErrors.ts';

const admin = (over: Partial<User> = {}): User => ({
  id: 'a1', name: 'Admin', email: 'a@example.com', role: 'Admin', status: 'Active', canManageWhatsAppTemplates: false, createdAt: '2026-01-01T00:00:00Z', ...over,
});

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

describe('Templates Access OFF -> ON -> OFF', () => {
  test('the menu and the page guard follow the profile the server returns, with no refresh', () => {
    const off = admin();
    const on = admin({ canManageWhatsAppTemplates: true });
    assert.equal(canSeeTemplatesPage(off), false);
    assert.equal(canSeeTemplatesPage(on), true, 'OFF -> ON: the menu entry and the route open');
    assert.equal(canSeeTemplatesPage(admin({ canManageWhatsAppTemplates: false })), false, 'ON -> OFF: both close');
    assert.deepEqual(diffAccess(off, on), ['templates_granted']);
    assert.deepEqual(diffAccess(on, off), ['templates_revoked']);
  });

  test('turning it off while on a template page sends the Admin to the dashboard; other pages stay', () => {
    const revoked = admin();
    for (const path of ['/whatsapp/templates', '/whatsapp/templates/new', '/whatsapp/templates/abc/edit', '/whatsapp/test-send']) {
      assert.equal(redirectTargetFor(path, revoked), '/dashboard', path);
    }
    for (const path of ['/dashboard', '/events', '/whatsapp-other', '/reports']) assert.equal(redirectTargetFor(path, revoked), null, path);
    assert.equal(redirectTargetFor('/whatsapp/templates', admin({ canManageWhatsAppTemplates: true })), null, 'granted: stays');
    assert.equal(redirectTargetFor('/whatsapp/templates', admin({ role: 'SuperAdmin' })), null, 'a Super Admin always may');
    assert.equal(redirectTargetFor('/whatsapp/templates', null), null);
  });

  test('the person is told what changed, in words, once per change', () => {
    assert.deepEqual(accessChangeToasts(['templates_granted']).map((t) => t.type), ['success']);
    assert.match(accessChangeToasts(['templates_revoked'])[0].message, /removed/);
    assert.deepEqual(accessChangeToasts([]), []);
  });
});

describe('other access changes', () => {
  test('status, role, access window and event assignment are each recognised', () => {
    const base = admin({ accessStartDate: '2026-01-01', accessExpiryDate: '2026-12-01', assignedEventId: 'e1' });
    assert.deepEqual(diffAccess(base, { ...base, isAccessCancelled: true }), ['status']);
    assert.deepEqual(diffAccess(base, { ...base, status: 'Rejected' }), ['status']);
    assert.deepEqual(diffAccess(base, { ...base, role: 'User' }), ['role']);
    assert.deepEqual(diffAccess(base, { ...base, accessExpiryDate: '2027-01-01' }), ['access_window']);
    assert.deepEqual(diffAccess(base, { ...base, assignedEventId: 'e2' }), ['event_assignment']);
    assert.deepEqual(diffAccess(base, { ...base }), []);
  });

  test('a different account\'s profile is never compared, so another sign-in cannot raise a false message', () => {
    assert.deepEqual(diffAccess(admin({ id: 'a1' }), admin({ id: 'a2', canManageWhatsAppTemplates: true })), []);
    assert.deepEqual(diffAccess(null, admin()), []);
    assert.deepEqual(diffAccess(admin(), undefined), []);
  });

  test('an access window that starts or ends is looked at when it does, even if no one is online to change anything', () => {
    const now = Date.parse('2026-10-14T10:00:00Z');
    assert.equal(nextAccessBoundaryDelay(admin({ accessExpiryDate: '2026-10-14T10:00:30Z' }), now), 30_000 + 750);
    assert.equal(nextAccessBoundaryDelay(admin({ accessStartDate: '2026-10-14T10:10:00Z', accessExpiryDate: '2026-11-01T00:00:00Z' }), now), 600_000 + 750, 'the nearer boundary');
    assert.equal(nextAccessBoundaryDelay(admin({ accessExpiryDate: '2026-10-01T00:00:00Z' }), now), null, 'already past: the server already refuses it');
    assert.equal(nextAccessBoundaryDelay(admin({ accessExpiryDate: '2030-01-01T00:00:00Z' }), now), 24 * 60 * 60 * 1000, 'long waits are chunked');
    assert.equal(nextAccessBoundaryDelay(admin({ role: 'SuperAdmin', accessExpiryDate: '2026-10-14T10:00:30Z' }), now), null, 'a Super Admin has no window');
    assert.equal(nextAccessBoundaryDelay(admin(), now), null);
    assert.equal(nextAccessBoundaryDelay(admin({ accessExpiryDate: 'garbage' }), now), null);
  });
});

describe('re-reads: duplicates, bursts and ordering', () => {
  test('a burst of duplicate pushes costs at most two reads, one after the other - never in parallel', async () => {
    let running = 0;
    let peak = 0;
    let runs = 0;
    const release: Array<() => void> = [];
    const coordinator = createRefreshCoordinator(async () => {
      runs += 1;
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
    });
    const first = coordinator.request();
    for (let i = 0; i < 9; i++) void coordinator.request(); // nine duplicates while the first is in flight
    assert.equal(runs, 1);
    release.shift()!();
    await new Promise((r) => setImmediate(r));
    assert.equal(runs, 2, 'exactly one follow-up read, so the latest change is never missed');
    release.shift()!();
    await first;
    assert.equal(peak, 1, 'never two reads at once, so an older answer cannot land after a newer one');
    assert.equal(coordinator.isRunning(), false);
  });

  test('a failed read does not wedge it: the next trigger reads again', async () => {
    let calls = 0;
    const coordinator = createRefreshCoordinator(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
    });
    await coordinator.request();
    await coordinator.request();
    assert.equal(calls, 2);
  });

  test('focus, visibility and online signals read once per burst', () => {
    assert.equal(shouldRefreshNow(0, 10_000), true);
    assert.equal(shouldRefreshNow(10_000, 12_000), false);
    assert.equal(shouldRefreshNow(10_000, 15_000), true);
    assert.equal(ACCESS_REFRESH_INTERVAL_MS, 60_000, 'the safety net is one small request a minute, only while the tab is visible');
  });

  test('an unchanged answer is recognised, so nothing re-renders', () => {
    assert.equal(sameProfile(admin(), admin()), true);
    assert.equal(sameProfile(admin(), admin({ canManageWhatsAppTemplates: true })), false);
    assert.equal(sameProfile(null, admin()), false);
    assert.equal(sameProfile(null, null), true);
  });
});

describe('several tabs', () => {
  const stored = (user: User) => ({ key: 'user', newValue: JSON.stringify(user) });

  test('a tab adopts the profile another tab of the SAME account wrote', () => {
    const adopted = profileFromStorageEvent(stored(admin({ canManageWhatsAppTemplates: true })), admin());
    assert.equal(adopted?.canManageWhatsAppTemplates, true);
  });

  test('it ignores its own value, other keys, removals, garbage and another account', () => {
    assert.equal(profileFromStorageEvent(stored(admin()), admin()), null, 'nothing changed');
    assert.equal(profileFromStorageEvent({ key: 'token', newValue: 'x' }, admin()), null);
    assert.equal(profileFromStorageEvent({ key: 'user', newValue: null }, admin()), null, 'a sign-out is handled elsewhere');
    assert.equal(profileFromStorageEvent({ key: 'user', newValue: '{not json' }, admin()), null);
    assert.equal(profileFromStorageEvent(stored(admin({ id: 'someone-else', canManageWhatsAppTemplates: true })), admin()), null, 'never adopt another sign-in');
    assert.equal(profileFromStorageEvent(stored(admin()), null), null, 'signed out here');
  });
});

describe('existing session behavior is unchanged', () => {
  test('a 401 still ends the session, except on the sign-in and registration calls', () => {
    assert.equal(shouldClearSession(401, '/auth/me'), true);
    assert.equal(shouldClearSession(401, '/auth/login'), false);
    assert.equal(shouldClearSession(500, '/auth/me'), false, 'a server error does not sign anyone out');
  });
});

describe('wiring', () => {
  const hook = read('frontend/src/components/useAccessSync.ts');
  const store = read('frontend/src/store/authStore.tsx');
  const layout = read('frontend/src/layouts/DashboardLayout.tsx');

  test('mounted once, in the layout every signed-in page uses', () => {
    assert.ok(layout.includes("import { useAccessSync } from '../components/useAccessSync';"));
    assert.equal((layout.match(/useAccessSync\(\)/g) || []).length, 1);
  });

  test('every trigger is set up in an effect that tears it down', () => {
    for (const pair of [
      ['socket.on(ACCESS_CHANGED_EVENT, refresh)', 'socket.off(ACCESS_CHANGED_EVENT, refresh)'],
      ["socket.on('connect', refresh)", "socket.off('connect', refresh)"],
      ["document.addEventListener('visibilitychange', onReturn)", "document.removeEventListener('visibilitychange', onReturn)"],
      ["window.addEventListener('focus', onReturn)", "window.removeEventListener('focus', onReturn)"],
      ["window.addEventListener('online', onOnline)", "window.removeEventListener('online', onOnline)"],
      ['window.setInterval(', 'window.clearInterval(interval)'],
      ['window.setTimeout(', 'window.clearTimeout(timer)'],
    ]) {
      assert.ok(hook.includes(pair[0]), pair[0]);
      assert.ok(hook.includes(pair[1]), pair[1]);
    }
  });

  test('callbacks live in refs, so a re-render does not add a second set of listeners', () => {
    assert.ok(hook.includes('const latest = useRef('));
    assert.ok(hook.includes('requestRef.current()'));
    assert.ok(/\}, \[socket, token\]\);/.test(hook), 'the socket effect depends only on the socket and session');
    assert.ok(/\}, \[token\]\);/.test(hook));
  });

  test('the answer comes from the server, one profile request - not the whole dataset', () => {
    assert.ok(store.includes("api.get('/auth/me')"));
    assert.equal(/api\.get\('\/(events|contacts|campaigns)/.test(hook + store), false);
    assert.ok(store.includes('setUser((prev) => (sameProfile(prev, fresh) ? prev : fresh));'));
  });

  test('a 401 on a re-read ends the session; other failures keep what is shown', () => {
    assert.ok(store.includes('if (error?.response?.status === 401) {'));
    assert.ok(/if \(error\?\.response\?\.status === 401\) \{[\s\S]*?setToken\(null\);[\s\S]*?setUser\(null\);[\s\S]*?\}[\s\S]*?return null;/.test(store));
  });

  test('another tab\'s profile is followed through localStorage events', () => {
    assert.ok(store.includes("window.addEventListener('storage', onStorage)"));
    assert.ok(store.includes("window.removeEventListener('storage', onStorage)"));
    assert.ok(store.includes('profileFromStorageEvent(event, userRef.current)'));
  });

  test('a failed change shows no success: the toast comes only from a successful read\'s diff', () => {
    assert.ok(hook.includes('const result = await refreshUser();\n      lastRefreshAt.current = Date.now();\n      if (!result) return;'));
  });
});
