import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePassword,
  isPasswordValid,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS,
} from '../shared/src/index.ts';

/**
 * The policy is shared by the backend (registration + reset) and the frontend
 * (form validation + requirements checklist), so it is tested once here.
 */
describe('password policy', () => {
  test('rejects empty and non-string values', () => {
    assert.match(validatePassword('') as string, /required/i);
    assert.match(validatePassword(undefined) as string, /required/i);
    assert.match(validatePassword(12345678) as string, /required/i);
  });

  test('enforces the minimum length', () => {
    assert.match(validatePassword('Ab1') as string, /at least 8 characters/i);
    assert.equal(PASSWORD_MIN_LENGTH, 8);
  });

  test('requires a letter and a number', () => {
    assert.match(validatePassword('12345678') as string, /letter/i);
    assert.match(validatePassword('abcdefgh') as string, /number/i);
  });

  test('accepts a compliant password', () => {
    assert.equal(validatePassword('TestPass123'), null);
    assert.ok(isPasswordValid('TestPass123'));
  });

  test('rejects an over-long password', () => {
    assert.match(validatePassword('a1'.repeat(200)) as string, /too long/i);
  });

  test('never echoes the supplied password in the message', () => {
    const secret = 'sup3rSecretValue';
    const message = validatePassword(secret + '!'.repeat(200));
    assert.ok(message && !message.includes(secret));
  });

  test('exposes a requirements list for the UI', () => {
    assert.ok(PASSWORD_REQUIREMENTS.length >= 3);
  });
});
