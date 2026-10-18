/**
 * The Manual Guest Add form's WhatsApp Number field - the rules (pure; no browser
 * needed) and how the form uses them.
 *
 * Run: npx tsx --test frontend/src/utils/mobileDigits.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { normalizeIndianMobile } from '@eventreach/shared';
import {
  MOBILE_DIGITS_ONLY,
  MOBILE_INCOMPLETE,
  MOBILE_TOO_LONG,
  limitMobileTyping,
  mobileForEdit,
  mobileFromPaste,
  validateMobileForSave,
} from './mobileDigits.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

describe('typing', () => {
  test('a normal 10-digit number is kept as typed, with no message', () => {
    assert.deepEqual(limitMobileTyping('9876543210'), { value: '9876543210', problem: null });
  });

  test('an 11th digit is refused and the field keeps its 10 digits, with the message', () => {
    assert.deepEqual(limitMobileTyping('98765432101', '9876543210'), { value: '9876543210', problem: MOBILE_TOO_LONG });
  });

  test('a typed + is refused as a non-digit, so no country code is typed in', () => {
    assert.deepEqual(limitMobileTyping('+', ''), { value: '', problem: MOBILE_DIGITS_ONLY });
  });

  test('non-numeric characters are removed and the field says digits only', () => {
    assert.deepEqual(limitMobileTyping('98765abc10'), { value: '9876510', problem: MOBILE_DIGITS_ONLY });
    assert.deepEqual(limitMobileTyping('+91'), { value: '91', problem: MOBILE_DIGITS_ONLY });
    assert.deepEqual(limitMobileTyping('98 76-54'), { value: '987654', problem: MOBILE_DIGITS_ONLY });
  });

  test('the message is cleared on the next valid edit', () => {
    assert.equal(limitMobileTyping('987654321').problem, null);
  });
});

describe('pasting', () => {
  test('pasting more than 10 digits is refused whole, with the message', () => {
    assert.deepEqual(mobileFromPaste('98765432109'), { value: null, problem: MOBILE_TOO_LONG });
    assert.deepEqual(mobileFromPaste('9876 5432 109'), { value: null, problem: MOBILE_TOO_LONG });
  });

  test('pasting exactly 10 digits, with spaces or dashes, is accepted', () => {
    assert.deepEqual(mobileFromPaste('98765 43210'), { value: '9876543210', problem: null });
    assert.deepEqual(mobileFromPaste('98765-43210'), { value: '9876543210', problem: null });
  });

  test('a pasted country prefix is taken off, so nothing is cut silently', () => {
    assert.deepEqual(mobileFromPaste('+91 98765 43210'), { value: '9876543210', problem: null });
    assert.deepEqual(mobileFromPaste('+919876543210'), { value: '9876543210', problem: null });
    assert.deepEqual(mobileFromPaste('919876543210'), { value: '9876543210', problem: null });
    assert.deepEqual(mobileFromPaste('09876543210'), { value: '9876543210', problem: null });
  });

  test('letters in a paste are refused', () => {
    assert.deepEqual(mobileFromPaste('abc'), { value: null, problem: MOBILE_DIGITS_ONLY });
    assert.deepEqual(mobileFromPaste('98765abc10'), { value: null, problem: MOBILE_DIGITS_ONLY });
  });

  test('a short paste is refused with the length message', () => {
    assert.deepEqual(mobileFromPaste('12345'), { value: null, problem: MOBILE_INCOMPLETE });
  });
});

describe('submitting', () => {
  test('fewer than 10 digits cannot be saved', () => {
    assert.equal(validateMobileForSave('98765'), MOBILE_INCOMPLETE);
    assert.equal(validateMobileForSave(''), MOBILE_INCOMPLETE);
  });

  test('more than 10 digits cannot be saved', () => {
    assert.equal(validateMobileForSave('98765432109'), MOBILE_TOO_LONG);
  });

  test('a valid 10-digit number with IN (+91) is accepted and stored as +91', () => {
    assert.equal(validateMobileForSave('9876543210'), null);
    assert.equal(normalizeIndianMobile('9876543210').ok && normalizeIndianMobile('9876543210').e164, '+919876543210');
  });

  test('a 10-digit number the shared rule refuses gets that rule\'s reason', () => {
    assert.match(String(validateMobileForSave('1234567890')), /Indian mobile/);
  });
});

describe('editing a saved guest', () => {
  test('a stored +91 number opens as its 10 digits', () => {
    assert.equal(mobileForEdit('+919876543210'), '9876543210');
    assert.equal(mobileForEdit('9876543210'), '9876543210');
  });

  test('a stored number that cannot be read is shown as stored, so saving it is refused', () => {
    assert.equal(mobileForEdit('12345'), '12345');
    assert.equal(validateMobileForSave(mobileForEdit('12345')), MOBILE_INCOMPLETE);
  });
});

describe('how the form uses them', () => {
  const page = read('frontend/src/pages/Contacts/ContactList.tsx');

  test('the field has no native maxLength, which would cut a pasted +91 number silently', () => {
    assert.equal(page.includes('maxLength={INDIA_E164_LENGTH}'), false);
    assert.equal(page.includes('INDIA_E164_LENGTH'), false);
  });

  test('typing and pasting go through the helpers, and a paste is refused by default', () => {
    assert.ok(page.includes('limitMobileTyping(e.target.value)'));
    assert.ok(page.includes('mobileFromPaste(e.clipboardData.getData(\'text\'))'));
    assert.ok(/onPaste=\{\(e\) => \{\s*e\.preventDefault\(\);/.test(page));
  });

  test('the save rule and the edit view use the same helpers', () => {
    assert.ok(page.includes('validateMobileForSave(value)'));
    assert.ok(page.includes("setValue('phoneNumber', mobileForEdit(contact.phoneNumber));"));
  });

  test('a refused keystroke or paste blocks saving until the field is corrected', () => {
    assert.ok(page.includes('if (phoneHint) {'));
  });

  test('the message shows in the field\'s existing error style', () => {
    assert.ok(page.includes('error={phoneHint ?? errors.phoneNumber?.message}'));
  });
});
