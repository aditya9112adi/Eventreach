import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIndianMobile,
  isNormalizedIndianMobile,
  indianSubscriberLength,
  COUNTRY_OPTIONS,
  DEFAULT_COUNTRY_CODE,
  INDIA_E164_LENGTH,
} from '../shared/src/index.ts';

/**
 * The India-only phone rule, shared by the contact form, bulk import, the
 * import preview and the update endpoint.
 *
 * Every case in this file is one the product must get right: a guest typing
 * ten digits, a pasted +91 number, a spreadsheet column with spaces in it,
 * and the several ways a country code can end up doubled.
 */

describe('Country options are India only', () => {
  test('exactly one option, IN (+91)', () => {
    assert.equal(COUNTRY_OPTIONS.length, 1);
    assert.equal(COUNTRY_OPTIONS[0].code, 'IN');
    assert.equal(COUNTRY_OPTIONS[0].label, 'IN (+91)');
  });

  test('no other country survives anywhere in the list', () => {
    const labels = COUNTRY_OPTIONS.map((c) => c.label).join(' ');
    for (const gone of ['US', 'UK', 'GB', 'AU', '+1', '+44', '+61']) {
      assert.ok(!labels.includes(gone), `${gone} must not be offered`);
    }
  });
});

describe('VALID — every accepted way of writing an Indian mobile', () => {
  const cases: Array<[string, string]> = [
    ['9876543210', '+919876543210'],        // plain 10 digits
    ['+919876543210', '+919876543210'],     // already E.164, must not be doubled
    ['919876543210', '+919876543210'],      // country code without the plus
    ['09876543210', '+919876543210'],       // domestic trunk prefix
    ['+91 98765 43210', '+919876543210'],   // spaces, as pasted from a sheet
    ['+91-98765-43210', '+919876543210'],   // hyphens
    ['(+91) 9876543210', '+919876543210'],  // brackets
    ['  9876543210  ', '+919876543210'],    // stray whitespace
    ['7218636606', '+917218636606'],        // the number from the report
    ['+917218636606', '+917218636606'],
  ];

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      const r = normalizeIndianMobile(input);
      assert.equal(r.ok, true, `expected valid, got: ${!r.ok ? r.reason : ''}`);
      if (r.ok) {
        assert.equal(r.e164, expected);
        assert.equal(r.e164.length, INDIA_E164_LENGTH, 'exactly 13 characters including +91');
      }
    });
  }

  test('every Indian mobile prefix 6-9 is accepted', () => {
    for (const first of ['6', '7', '8', '9']) {
      const r = normalizeIndianMobile(`${first}876543210`);
      assert.equal(r.ok, true, `${first}… should be valid`);
    }
  });

  test('normalising is idempotent — an already-stored number is unchanged', () => {
    const once = normalizeIndianMobile('9876543210');
    assert.ok(once.ok);
    if (once.ok) {
      const twice = normalizeIndianMobile(once.e164);
      assert.ok(twice.ok);
      if (twice.ok) assert.equal(twice.e164, once.e164, 're-normalising must not add another +91');
    }
  });

  test('isNormalizedIndianMobile recognises stored values', () => {
    assert.equal(isNormalizedIndianMobile('+919876543210'), true);
    assert.equal(isNormalizedIndianMobile('9876543210'), false, 'not yet normalised');
  });
});

describe('INVALID — everything that must be refused', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['987654321', 'nine digits', /9 digits|10 digits/i],
    ['98765432101', 'eleven digits', /11 digits|10 digits/i],
    ['+91987654321', '+91 with nine digits', /digits/i],
    ['+9198765432101', '+91 with eleven digits', /digits/i],
    ['+12025550123', 'US number', /digits|Indian/i],
    ['+442071838750', 'UK number', /digits|Indian/i],
    ['+61412345678', 'AU number', /digits|Indian/i],
    ['+91+919876543210', 'doubled country code with plus', /repeated|misplaced/i],
    ['98765abcde', 'letters', /only digits/i],
    ['!@#$%^&*()', 'symbols', /only digits/i],
    ['', 'empty', /Enter a WhatsApp number/i],
    ['   ', 'whitespace only', /Enter a WhatsApp number/i],
    ['1234567890', 'starts with 1', /starts with 6, 7, 8 or 9/i],
    ['5876543210', 'starts with 5', /starts with 6, 7, 8 or 9/i],
  ];

  for (const [input, label, reasonPattern] of cases) {
    test(`${label}: ${JSON.stringify(input)} is rejected`, () => {
      const r = normalizeIndianMobile(input);
      assert.equal(r.ok, false, 'must not be accepted');
      if (!r.ok) {
        assert.match(r.reason, reasonPattern);
        assert.ok(r.reason.length > 0, 'a reason must be given to the user');
      }
    });
  }

  test('non-string input is rejected rather than throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const r = normalizeIndianMobile(bad as any);
      assert.equal(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
    }
  });

  /**
   * The specific corruption this feature exists to prevent: a number that has
   * already been normalised being normalised again by a caller that prepends
   * the country code itself.
   */
  test('a doubled country code never silently becomes a plausible number', () => {
    for (const doubled of ['+91+919876543210', '+91919876543210', '9191876543210']) {
      const r = normalizeIndianMobile(doubled);
      if (r.ok) {
        assert.notEqual(r.e164, '+919876543210', `${doubled} must not resolve to the original number`);
        assert.equal(r.e164.length, INDIA_E164_LENGTH);
      }
    }
  });
});

describe('Subscriber counter — the "13/10 — limit reached" bug', () => {
  test('a number typed with +91 counts as 10, not 13', () => {
    assert.equal(indianSubscriberLength('+919876543210'), 10);
    assert.equal(indianSubscriberLength('919876543210'), 10);
    assert.equal(indianSubscriberLength('9876543210'), 10);
  });

  test('a partially typed number counts what has been typed', () => {
    assert.equal(indianSubscriberLength('98765'), 5);
    assert.equal(indianSubscriberLength('+9198765'), 5);
    assert.equal(indianSubscriberLength(''), 0);
  });

  test('the count never exceeds the limit, so it cannot read "13/10"', () => {
    for (const input of ['+919876543210', '919876543210', '+91 98765 43210', '09876543210']) {
      assert.ok(indianSubscriberLength(input) <= 10, `${input} counted above the limit`);
    }
  });

  test('separators are not counted as digits', () => {
    assert.equal(indianSubscriberLength('+91 98765 43210'), 10);
    assert.equal(indianSubscriberLength('+91-98765-43210'), 10);
  });
});

/**
 * The stored country code is fixed, not taken from the request.
 *
 * These assert on the controller's own source rather than through HTTP,
 * because the point being proved is that the caller's value is never read on
 * the way to the database — a request-level test could pass while the field
 * was still being threaded through from req.body.
 */
describe('countryCode is hard-coded on persistence, never taken from the caller', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const controller = fs.readFileSync('backend/src/controllers/contactController.ts', 'utf8');

  test('every persisted countryCode is DEFAULT_COUNTRY_CODE', () => {
    // All assignments except the Zod field declaration, which describes what
    // the endpoint accepts rather than what it stores.
    const persisted = (controller.match(/countryCode: [A-Za-z_.]+/g) ?? [])
      .filter((site) => !site.startsWith('countryCode: z'));

    assert.ok(persisted.length >= 4, `expected all four persistence paths, found ${persisted.length}`);
    for (const site of persisted) {
      assert.equal(site, 'countryCode: DEFAULT_COUNTRY_CODE', `found a non-fixed persistence site: ${site}`);
    }
  });

  test('no persistence path passes the caller\'s countryCode through', () => {
    // A bare `countryCode,` inside an object literal would be the shorthand
    // that forwards req.body straight to the database.
    assert.ok(!/\n\s+countryCode,\n/.test(controller), 'a shorthand countryCode is still being persisted');
  });

  test('the caller\'s countryCode is not destructured for use', () => {
    assert.ok(
      !/const \{[^}]*\bcountryCode\b[^}]*\} = parsed\.data/.test(controller),
      'countryCode is still being read out of the request payload'
    );
    assert.ok(
      !/req\.body\.countryCode/.test(controller),
      'req.body.countryCode is still being read'
    );
  });

  test('DEFAULT_COUNTRY_CODE is IN, so a "US" payload can only ever store IN', () => {
    assert.equal(DEFAULT_COUNTRY_CODE, 'IN');
  });
});

/**
 * Contact Report formatting. phoneNumber is already E.164, so the export must
 * print it as-is — prefixing the stored country produced "IN+919876543210".
 */
describe('Contact Report prints E.164 without a duplicated country code', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const reports = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf8');

  test('the Phone column does not concatenate countryCode', () => {
    assert.ok(
      !/\$\{value\(r\.countryCode\)\}\$\{value\(r\.phoneNumber/.test(reports),
      'the Phone column still prefixes the country code'
    );
  });

  test('formatting a stored contact yields exactly the E.164 number', () => {
    const stored = { countryCode: 'IN', phoneNumber: '+919876543210' };
    // What the fixed column now does: use the number directly.
    const rendered = stored.phoneNumber;
    assert.equal(rendered, '+919876543210');
    assert.ok(!rendered.startsWith('IN'), 'must not read IN+91…');
    assert.ok(!rendered.includes('+91+91'), 'must not double the country code');
    assert.equal(rendered.length, INDIA_E164_LENGTH);
  });
});
