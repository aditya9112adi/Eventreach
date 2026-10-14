import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getAllowedOrigins,
  parseExtraOrigins,
  getExtraOriginsReport,
  EXTRA_ORIGINS_ENV,
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

describe('extra CORS origins (CORS_EXTRA_ORIGINS)', () => {
  const PREVIEW = 'https://eventreach-frontend-git-release-743904-aditya9112adis-projects.vercel.app';

  beforeEach(() => {
    delete process.env.FRONTEND_URL;
    delete process.env.CORS_EXTRA_ORIGINS;
    delete process.env.NODE_ENV;
  });

  test('the variable name is the documented one', () => {
    assert.equal(EXTRA_ORIGINS_ENV, 'CORS_EXTRA_ORIGINS');
  });

  test('with nothing set, the allowed origins are exactly what they were', () => {
    assert.deepEqual(getAllowedOrigins(), [DEV_FRONTEND_ORIGIN, PRODUCTION_FRONTEND_ORIGIN]);
    assert.deepEqual(getExtraOriginsReport(), { origins: [], ignored: [] });
  });

  test('the approved preview origin is added after FRONTEND_URL, which is untouched', () => {
    process.env.FRONTEND_URL = 'https://app.example.com,https://admin.example.com/';
    process.env.CORS_EXTRA_ORIGINS = PREVIEW;
    assert.deepEqual(getAllowedOrigins(), ['https://app.example.com', 'https://admin.example.com', PREVIEW]);
  });

  test('without FRONTEND_URL the built-in origins are kept and the preview is added', () => {
    process.env.CORS_EXTRA_ORIGINS = PREVIEW;
    assert.deepEqual(getAllowedOrigins(), [DEV_FRONTEND_ORIGIN, PRODUCTION_FRONTEND_ORIGIN, PREVIEW]);
  });

  test('extra origins never change the address used for email links', () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    process.env.CORS_EXTRA_ORIGINS = PREVIEW;
    assert.equal(getFrontendBaseUrl(), 'https://app.example.com');
    assert.equal(isFrontendUrlConfigured(), true);
    delete process.env.FRONTEND_URL;
    assert.equal(isFrontendUrlConfigured(), false, 'extra origins do not count as a configured frontend');
    assert.equal(getFrontendBaseUrl(), DEV_FRONTEND_ORIGIN);
  });

  test('only the exact approved origin is allowed - not its siblings, lookalikes or other schemes', () => {
    process.env.CORS_EXTRA_ORIGINS = PREVIEW;
    const allowed = getAllowedOrigins();
    assert.ok(allowed.includes(PREVIEW));
    for (const other of [
      'https://eventreach-frontend-git-other-aditya9112adis-projects.vercel.app',
      `${PREVIEW}.evil.com`,
      PREVIEW.replace('https://', 'http://'),
      `${PREVIEW}:8443`,
      'https://vercel.app',
      'https://someone-elses-app.vercel.app',
    ]) assert.equal(allowed.includes(other), false, other);
  });

  test('entries are normalised to a canonical origin and de-duplicated', () => {
    const report = parseExtraOrigins(` HTTPS://App.Example.com/ , https://app.example.com,https://b.example.com:8443/,, `);
    assert.deepEqual(report.origins, ['https://app.example.com', 'https://b.example.com:8443']);
    assert.deepEqual(report.ignored, [], 'a trailing comma or blank is not an entry');
  });

  test('a value already in FRONTEND_URL is not listed twice', () => {
    process.env.FRONTEND_URL = PREVIEW;
    process.env.CORS_EXTRA_ORIGINS = `${PREVIEW}/`;
    assert.deepEqual(getAllowedOrigins(), [PREVIEW]);
  });

  test('http is accepted only for localhost', () => {
    const report = parseExtraOrigins('http://localhost:5173,http://127.0.0.1:3000,http://[::1]:3000,http://app.example.com');
    assert.deepEqual(report.origins, ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000']);
    assert.deepEqual(report.ignored, [{ position: 4, reason: 'must be https (http is allowed only for localhost)' }]);
  });

  test('wildcards, other schemes, credentials, paths and junk are ignored, with a position and a reason', () => {
    const report = parseExtraOrigins([
      '*',
      'https://*.vercel.app',
      '*.vercel.app',
      'ftp://files.example.com',
      'https://user:secret-pw-1234@creds.example.com',
      'https://paths.example.com/app',
      'https://query.example.com?x=1',
      'https://fragment.example.com#top',
      'not a url',
      'https://ok.example.com',
    ].join(','));
    assert.deepEqual(report.origins, ['https://ok.example.com']);
    assert.deepEqual(report.ignored.map((i: any) => i.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(report.ignored.slice(0, 3).map((i: any) => i.reason), Array(3).fill('wildcards are not allowed'));
    assert.equal(report.ignored[3].reason, 'must be https (http is allowed only for localhost)');
    for (const i of report.ignored.slice(4, 8)) assert.equal(i.reason, 'must be a bare origin: no credentials, path, query or fragment');
    assert.equal(report.ignored[8].reason, 'not a valid URL');
  });

  test('a report never contains the text of an ignored entry', () => {
    const report = parseExtraOrigins('https://user:secret-pw-1234@creds.example.com,https://paths.example.com/private-path');
    const text = JSON.stringify(report);
    for (const leaked of ['secret-pw-1234', 'user:', 'creds.example.com', 'private-path', 'paths.example.com']) assert.equal(text.includes(leaked), false, leaked);
    assert.equal(report.ignored.length, 2);
  });

  test('unset and empty values mean no extra origins', () => {
    for (const raw of [undefined, '', '   ', ',,,']) assert.deepEqual(parseExtraOrigins(raw), { origins: [], ignored: [] });
  });
});
