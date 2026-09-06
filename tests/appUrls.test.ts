import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getAllowedOrigins,
  getFrontendBaseUrl,
  isFrontendUrlConfigured,
  DEV_FRONTEND_ORIGIN,
  PRODUCTION_FRONTEND_ORIGIN,
} = require('../backend/dist/config/appUrls');

/**
 * Regression guard: an unset FRONTEND_URL used to make the email helper fall
 * back to localhost even in production, so password-reset links pointed at
 * http://localhost:5173 and were unusable — while the API still reported
 * "reset link sent".
 */
describe('frontend URL resolution', () => {
  beforeEach(() => {
    delete process.env.FRONTEND_URL;
    delete process.env.NODE_ENV;
  });

  test('uses FRONTEND_URL when set', () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    assert.equal(getFrontendBaseUrl(), 'https://app.example.com');
    assert.equal(isFrontendUrlConfigured(), true);
  });

  test('strips a trailing slash and uses the first of several origins', () => {
    process.env.FRONTEND_URL = 'https://app.example.com/, https://other.example.com';
    assert.equal(getFrontendBaseUrl(), 'https://app.example.com');
    assert.deepEqual(getAllowedOrigins(), ['https://app.example.com', 'https://other.example.com']);
  });

  test('falls back to localhost in development', () => {
    process.env.NODE_ENV = 'development';
    assert.equal(getFrontendBaseUrl(), DEV_FRONTEND_ORIGIN);
    assert.equal(isFrontendUrlConfigured(), false);
  });

  test('NEVER falls back to localhost in production', () => {
    process.env.NODE_ENV = 'production';
    const url = getFrontendBaseUrl();
    assert.equal(url, PRODUCTION_FRONTEND_ORIGIN);
    assert.ok(!url.includes('localhost'), 'a production email link must not point at localhost');
  });

  test('CORS still accepts both origins when unconfigured', () => {
    const origins = getAllowedOrigins();
    assert.ok(origins.includes(DEV_FRONTEND_ORIGIN));
    assert.ok(origins.includes(PRODUCTION_FRONTEND_ORIGIN));
  });

  test('ignores blank / whitespace-only configuration', () => {
    process.env.FRONTEND_URL = '  ,  ';
    assert.equal(isFrontendUrlConfigured(), false);
    process.env.NODE_ENV = 'production';
    assert.equal(getFrontendBaseUrl(), PRODUCTION_FRONTEND_ORIGIN);
  });
});
