import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  generateResetToken,
  hashResetToken,
  resetTokenExpiry,
  getResetTtlMinutes,
  DEFAULT_RESET_TTL_MINUTES,
} = require('../backend/dist/utils/resetToken');

describe('password reset tokens', () => {
  test('generates high-entropy, unique tokens', () => {
    const a = generateResetToken();
    const b = generateResetToken();
    assert.equal(a.length, 64, '32 random bytes as hex');
    assert.notEqual(a, b);
  });

  test('hashing is deterministic and one-way', () => {
    const raw = generateResetToken();
    assert.equal(hashResetToken(raw), hashResetToken(raw));
    assert.equal(hashResetToken(raw).length, 64);
    assert.notEqual(hashResetToken(raw), raw, 'the hash must differ from the raw token');
  });

  test('different tokens hash differently', () => {
    assert.notEqual(hashResetToken(generateResetToken()), hashResetToken(generateResetToken()));
  });

  test('expiry defaults to the documented TTL', () => {
    delete process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES;
    assert.equal(getResetTtlMinutes(), DEFAULT_RESET_TTL_MINUTES);
    const from = new Date('2026-01-01T00:00:00.000Z');
    assert.equal(
      resetTokenExpiry(from).getTime() - from.getTime(),
      DEFAULT_RESET_TTL_MINUTES * 60 * 1000
    );
  });

  test('TTL is configurable and ignores nonsense values', () => {
    process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES = '15';
    assert.equal(getResetTtlMinutes(), 15);
    for (const bad of ['0', '-5', 'abc', '99999']) {
      process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES = bad;
      assert.equal(getResetTtlMinutes(), DEFAULT_RESET_TTL_MINUTES, `rejects ${bad}`);
    }
    delete process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES;
  });
});
