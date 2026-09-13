import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newPasswordSchema } from './newPasswordValidation.ts';

/**
 * Frontend-side validation used by the self-service reset-password form
 * (ResetPassword.tsx). The underlying password policy itself is covered once
 * in tests/passwordPolicy.test.ts — this only checks that this schema wires
 * it up correctly and enforces the confirmation match, which is the part
 * specific to this form.
 */
describe('newPasswordSchema (ResetPassword form)', () => {
  test('accepts a compliant, matching password pair', () => {
    const result = newPasswordSchema.safeParse({ newPassword: 'TestPass123', confirmPassword: 'TestPass123' });
    assert.equal(result.success, true);
  });

  test('rejects a mismatched confirmation, attributed to confirmPassword', () => {
    const result = newPasswordSchema.safeParse({ newPassword: 'TestPass123', confirmPassword: 'Different123' });
    assert.equal(result.success, false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'confirmPassword');
      assert.ok(issue, 'the mismatch must be attributed to confirmPassword');
      assert.match(issue!.message, /do not match/i);
    }
  });

  test('rejects a password that fails the shared policy, using its message', () => {
    const result = newPasswordSchema.safeParse({ newPassword: 'short', confirmPassword: 'short' });
    assert.equal(result.success, false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'newPassword');
      assert.ok(issue);
      assert.match(issue!.message, /at least 8 characters/i);
    }
  });

  test('requires a confirmation to be supplied', () => {
    const result = newPasswordSchema.safeParse({ newPassword: 'TestPass123', confirmPassword: '' });
    assert.equal(result.success, false);
  });
});
