import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldClearSession } from '../frontend/src/services/authErrors.ts';

/**
 * Regression guard for the login failure.
 *
 * The axios interceptor used to treat EVERY 401 as an expired session and do
 * `window.location.href = '/login'`. A wrong password returns 401, so signing in
 * with bad credentials reloaded the page and wiped the "Invalid credentials"
 * banner before it could render — the form just appeared to reset silently.
 */
describe('shouldClearSession', () => {
  test('does NOT clear the session for a failed login (401 on /auth/login)', () => {
    assert.equal(shouldClearSession(401, '/auth/login'), false);
  });

  test('does NOT clear the session for a failed registration (401 on /auth/register)', () => {
    assert.equal(shouldClearSession(401, '/auth/register'), false);
  });

  test('DOES clear the session for a 401 on a protected endpoint', () => {
    assert.equal(shouldClearSession(401, '/events'), true);
    assert.equal(shouldClearSession(401, '/admin/users/pending'), true);
    assert.equal(shouldClearSession(401, '/auth/me'), true);
  });

  test('ignores non-401 statuses', () => {
    // 429 (rate limited) and 403 (account pending/revoked) must reach the page so
    // their message is displayed rather than triggering a silent reload.
    assert.equal(shouldClearSession(429, '/auth/login'), false);
    assert.equal(shouldClearSession(403, '/auth/login'), false);
    assert.equal(shouldClearSession(500, '/events'), false);
    assert.equal(shouldClearSession(undefined, '/events'), false);
  });
});
