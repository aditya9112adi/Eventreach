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
  insertMobileText,
  limitMobileTyping,
  mobileForEdit,
  mobileFromPaste,
  validateMobileForSave,
} from './mobileDigits.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

const TEN = '9876543210';

describe('typing at the caret (keydown)', () => {
  test('typing 10 digits one by one keeps all 10', () => {
    let value = '';
    for (const digit of TEN) {
      const edit = insertMobileText(value, value.length, value.length, digit);
      assert.equal(edit.accepted, true);
      assert.equal(edit.problem, null);
      value = edit.value;
    }
    assert.equal(value, TEN);
  });

  test('an 11th digit is refused: the 10 digits stay exactly as entered, with the red message', () => {
    const edit = insertMobileText(TEN, 10, 10, '1');
    assert.deepEqual(edit, { accepted: false, value: TEN, caret: 10, problem: MOBILE_TOO_LONG });
    assert.equal(MOBILE_TOO_LONG, 'Maximum limit reached. Only 10 digits are allowed.');
  });

  test('an 11th digit typed in the middle is refused and the caret stays put', () => {
    const edit = insertMobileText(TEN, 4, 4, '1');
    assert.deepEqual(edit, { accepted: false, value: TEN, caret: 4, problem: MOBILE_TOO_LONG });
  });

  test('a non-digit is refused and the digits stay', () => {
    for (const key of ['a', '+', ' ', '-', '.']) {
      const edit = insertMobileText('98765', 5, 5, key);
      assert.deepEqual(edit, { accepted: false, value: '98765', caret: 5, problem: MOBILE_DIGITS_ONLY });
    }
  });

  test('a digit typed in the middle goes in at the caret, which moves past it', () => {
    const edit = insertMobileText('987643210', 4, 4, '5');
    assert.deepEqual(edit, { accepted: true, value: TEN, caret: 5, problem: null });
  });

  test('typing over a selection replaces it, even at 10 digits', () => {
    const edit = insertMobileText(TEN, 0, 3, '1');
    assert.deepEqual(edit, { accepted: true, value: '1' + TEN.slice(3), caret: 1, problem: null });
    assert.equal(insertMobileText(TEN, 0, 10, '5').value, '5');
  });

  test('a selection written backwards is read the same', () => {
    assert.equal(insertMobileText(TEN, 3, 0, '1').value, '1' + TEN.slice(3));
  });
});

describe('deleting corrects the number', () => {
  test('after a refused 11th digit, deleting a digit clears the message and allows a new one', () => {
    const refused = insertMobileText(TEN, 10, 10, '1');
    assert.equal(refused.problem, MOBILE_TOO_LONG);
    // Backspace is not intercepted: the browser removes the last digit, then onChange sees 9 digits.
    const afterDelete = limitMobileTyping('987654321', TEN, 9);
    assert.deepEqual(afterDelete, { value: '987654321', caret: 9, problem: null });
    assert.equal(insertMobileText(afterDelete.value, 9, 9, '0').value, TEN);
  });

  test('Delete in the middle keeps the rest and the caret', () => {
    assert.deepEqual(limitMobileTyping('987643210', TEN, 4), { value: '987643210', caret: 4, problem: null });
  });
});

describe('input the keyboard handler never sees (onChange fallback)', () => {
  test('a normal 10-digit number is kept as it is', () => {
    assert.deepEqual(limitMobileTyping(TEN, '', 10), { value: TEN, caret: 10, problem: null });
  });

  test('an 11th digit at the end puts the previous digits back, with the message, not an empty field', () => {
    assert.deepEqual(limitMobileTyping(TEN + '1', TEN, 11), { value: TEN, caret: 10, problem: MOBILE_TOO_LONG });
  });

  test('an 11th digit in the middle puts the previous digits back and the caret where it was', () => {
    assert.deepEqual(limitMobileTyping('98761543210', TEN, 5), { value: TEN, caret: 4, problem: MOBILE_TOO_LONG });
  });

  test('non-numeric characters are removed from where they landed and the field says digits only', () => {
    assert.deepEqual(limitMobileTyping('98765abc10', '', 10), { value: '9876510', caret: 7, problem: MOBILE_DIGITS_ONLY });
    assert.deepEqual(limitMobileTyping('987a65', '98765', 4), { value: '98765', caret: 3, problem: MOBILE_DIGITS_ONLY });
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

  test('an invalid paste leaves the current digits exactly as they are', () => {
    // More than 10 digits in total, letters, and a +91 prefix in a half-filled field.
    assert.deepEqual(insertMobileText('98765', 5, 5, '4321099', true), { accepted: false, value: '98765', caret: 5, problem: MOBILE_TOO_LONG });
    assert.deepEqual(insertMobileText(TEN, 10, 10, '1'), { accepted: false, value: TEN, caret: 10, problem: MOBILE_TOO_LONG });
    assert.deepEqual(insertMobileText('98765', 5, 5, 'abc', true), { accepted: false, value: '98765', caret: 5, problem: MOBILE_DIGITS_ONLY });
    assert.deepEqual(insertMobileText('98765', 5, 5, '+91 98765 43210', true), { accepted: false, value: '98765', caret: 5, problem: MOBILE_DIGITS_ONLY });
  });

  test('pasting more than 10 digits into an empty field is refused and the field stays empty', () => {
    assert.deepEqual(insertMobileText('', 0, 0, '98765432109', true), { accepted: false, value: '', caret: 0, problem: MOBILE_TOO_LONG });
  });

  test('a valid paste goes in at the caret, or over the selection', () => {
    assert.deepEqual(insertMobileText('98', 2, 2, '765 43210', true), { accepted: true, value: TEN, caret: 10, problem: null });
    assert.deepEqual(insertMobileText('9810', 2, 2, '7654 32', true), { accepted: true, value: '98765432' + '10', caret: 8, problem: null });
    assert.equal(insertMobileText(TEN, 4, 7, '321', true).value, '9876' + '321' + '210'.slice(0));
  });

  test('a whole number with +91 pasted over an empty or fully selected field is stored as its 10 digits', () => {
    assert.equal(insertMobileText('', 0, 0, '+91 98765 43210', true).value, TEN);
    assert.equal(insertMobileText('12345', 0, 5, '+919876543210', true).value, TEN);
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

  test('keystrokes and pastes are checked before they reach the field', () => {
    assert.ok(page.includes('onKeyDown={(e) => {'));
    assert.ok(page.includes('insertMobileText(input.value, input.selectionStart'));
    assert.ok(/if \(!edit\.accepted\) \{\s*e\.preventDefault\(\);\s*setPhoneHint\(edit\.problem\);/.test(page));
    assert.ok(/onPaste=\{\(e\) => \{\s*e\.preventDefault\(\);/.test(page));
    assert.ok(page.includes("e.clipboardData.getData('text'), true)"));
  });

  test('the onChange fallback restores the previous digits and caret, and never clears the field', () => {
    assert.ok(page.includes("limitMobileTyping(input.value, getValues('phoneNumber') ?? '',"));
    assert.ok(page.includes('input.setSelectionRange(typed.caret, typed.caret);'));
    assert.equal(page.includes('limitMobileTyping(e.target.value)'), false);
    assert.equal(page.includes('e.target.value = typed.value'), false);
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
