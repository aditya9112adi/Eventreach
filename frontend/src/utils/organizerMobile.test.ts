/**
 * The Create Event form's Organizer Mobile Number: at most 10 digits, and the
 * "10/10 — limit reached" warning only after an attempt to add an 11th digit.
 *
 * The typing sessions drive the same pure functions the page's key, paste and
 * change handlers call, so they test the real rules. There is no DOM test runner
 * here, so how the page uses them is checked in its source, as the other
 * component tests do. All numbers are made up.
 *
 * Run: npx tsx --test frontend/src/utils/organizerMobile.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  applyOrganizerMobileInput,
  counterLabel,
  nextLimitAttempt,
  reconcileOrganizerMobileChange,
  type OrganizerMobileState,
} from './organizerMobile.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

const empty = (): OrganizerMobileState => ({ value: '', limitAttempted: false });
const full = (limitAttempted = false): OrganizerMobileState => ({ value: '9876543210', limitAttempted });
const label = (s: OrganizerMobileState) => counterLabel(s.value.length, 10, s.limitAttempted).text;

/** One keystroke at the caret (the end by default) or over a selection. */
const press = (state: OrganizerMobileState, key: string, start = state.value.length, end = start): OrganizerMobileState => {
  const r = applyOrganizerMobileInput(state, { start, end, text: key });
  return { value: r.value, limitAttempted: r.limitAttempted };
};
const type = (state: OrganizerMobileState, keys: string): OrganizerMobileState => [...keys].reduce((s, k) => press(s, k), state);
const paste = (state: OrganizerMobileState, text: string, start = state.value.length, end = start): OrganizerMobileState => {
  const r = applyOrganizerMobileInput(state, { start, end, text, isPaste: true });
  return { value: r.value, limitAttempted: r.limitAttempted };
};
/** Backspace at `caret`: the browser removes a digit, then the change handler sees the result. */
const backspace = (state: OrganizerMobileState, caret = state.value.length): OrganizerMobileState => {
  const next = state.value.slice(0, caret - 1) + state.value.slice(caret);
  const r = reconcileOrganizerMobileChange(state, next, caret - 1);
  return { value: r.value, limitAttempted: r.limitAttempted };
};

describe('typing', () => {
  test('digits are accepted up to 10', () => {
    let s = empty();
    for (const [i, digit] of [...'9876543210'].entries()) {
      s = press(s, digit);
      assert.equal(s.value.length, i + 1);
    }
    assert.equal(s.value, '9876543210');
  });

  test('reaching exactly 10 digits shows 10/10, with no warning', () => {
    const s = type(empty(), '9876543210');
    assert.equal(s.limitAttempted, false);
    assert.equal(label(s), '10/10');
    assert.equal(counterLabel(10, 10, s.limitAttempted).atLimit, false, 'not in the warning style either');
  });

  test('an 11th digit is not accepted: the 10 digits stay, and only now is the limit reported', () => {
    const s = press(full(), '1');
    assert.equal(s.value, '9876543210');
    assert.equal(s.limitAttempted, true);
    assert.equal(label(s), '10/10 — limit reached');
    assert.equal(counterLabel(10, 10, s.limitAttempted).atLimit, true);
  });

  test('every further attempt leaves the number as it is and the warning on', () => {
    let s = full();
    for (const digit of '123456789') s = press(s, digit);
    assert.equal(s.value, '9876543210');
    assert.equal(label(s), '10/10 — limit reached');
  });

  test('non-numeric characters are rejected, and are not mistaken for an attempt to go past the limit', () => {
    let s = type(empty(), '98765');
    for (const key of ['a', 'Z', '+', ' ', '-', '.', 'e', '#']) s = press(s, key);
    assert.equal(s.value, '98765');
    assert.equal(s.limitAttempted, false);
    // And in a full field, a letter neither adds a digit nor raises the warning.
    assert.equal(press(full(), 'x').limitAttempted, false);
    assert.equal(press(full(), 'x').value, '9876543210');
  });

  test('a refused letter leaves a warning that is already showing as it was', () => {
    assert.equal(press(full(true), 'x').limitAttempted, true);
  });
});

describe('deleting', () => {
  test('deleting a digit after a limit attempt clears the warning', () => {
    const attempted = press(full(), '1');
    assert.equal(label(attempted), '10/10 — limit reached');
    const s = backspace(attempted);
    assert.equal(s.value, '987654321');
    assert.equal(s.limitAttempted, false);
    assert.equal(label(s), '9/10');
  });

  test('after deleting, a digit can be typed again, and the next attempt warns again', () => {
    let s = backspace(press(full(), '1'));
    s = press(s, '0');
    assert.equal(s.value, '9876543210');
    assert.equal(label(s), '10/10', 'back to 10 digits, no new attempt, no warning');
    assert.equal(label(press(s, '5')), '10/10 — limit reached');
  });

  test('deleting from the middle also clears it', () => {
    const s = backspace(press(full(), '1'), 4);
    assert.equal(s.value, '987543210');
    assert.equal(s.limitAttempted, false);
  });
});

describe('editing in the middle', () => {
  test('a digit typed in the middle of 9 goes in at the caret', () => {
    const s = press({ value: '987643210', limitAttempted: false }, '5', 4);
    assert.equal(s.value, '9876543210');
    assert.equal(s.limitAttempted, false);
    assert.equal(label(s), '10/10');
  });

  test('a digit typed in the middle of a full number is refused, the number is unchanged, and the warning shows', () => {
    const s = press(full(), '1', 4);
    assert.equal(s.value, '9876543210');
    assert.equal(label(s), '10/10 — limit reached');
  });

  test('replacing a few digits with the same number of digits works, with no warning', () => {
    const s = press(full(), '1', 3, 6);
    assert.equal(s.value, '987' + '1' + '3210');
    assert.equal(s.limitAttempted, false);
  });
});

describe('select all and replace', () => {
  test('selecting all 10 digits and typing a digit replaces them, with no false warning', () => {
    const s = press(full(), '5', 0, 10);
    assert.equal(s.value, '5');
    assert.equal(s.limitAttempted, false);
    assert.equal(label(s), '1/10');
  });

  test('selecting all and typing a whole new number works from the first digit', () => {
    let s = press(full(), '7', 0, 10);
    s = type(s, '123456789');
    assert.equal(s.value, '7123456789');
    assert.equal(label(s), '10/10', 'a full number typed over the old one: no warning');
  });

  test('selecting all and pasting a new 10-digit number replaces it, and clears an earlier warning', () => {
    const s = paste(full(true), '9123456780', 0, 10);
    assert.equal(s.value, '9123456780');
    assert.equal(s.limitAttempted, false);
    assert.equal(label(s), '10/10');
  });
});

describe('pasting', () => {
  test('a paste that would make more than 10 digits is refused whole, in every position', () => {
    assert.equal(paste(empty(), '98765432109').value, '');
    assert.equal(paste(empty(), '987654321098765').value, '');
    assert.equal(paste(type(empty(), '98765'), '4321099').value, '98765');
    assert.equal(paste(full(), '1').value, '9876543210');
    assert.equal(paste(full(), '12', 3, 4).value, '9876543210', 'a selection replaced by more digits than it held');
  });

  test('pasting onto a full number reports the attempt', () => {
    const s = paste(full(), '123');
    assert.equal(s.value, '9876543210');
    assert.equal(label(s), '10/10 — limit reached');
  });

  test('a paste with letters is refused and leaves the number alone', () => {
    assert.equal(paste(type(empty(), '987'), 'abc').value, '987');
    assert.equal(paste(type(empty(), '987'), '12ab').value, '987');
  });

  test('a valid paste goes in at the caret, spaces and dashes removed', () => {
    assert.equal(paste(type(empty(), '98'), '765 43-210').value, '9876543210');
    assert.equal(paste(empty(), '98765 43210').value, '9876543210');
  });

  test('no paste can ever produce a value longer than 10 digits', () => {
    const attempts = ['1', '12345678901', '+919876543210', '9'.repeat(40), '0', '98 76 54 32 10 99'];
    for (const state of [empty(), type(empty(), '5'), type(empty(), '98765'), full()]) {
      for (const text of attempts) {
        for (const [start, end] of [[0, 0], [state.value.length, state.value.length], [0, state.value.length]]) {
          const result = paste(state, text, start, end);
          assert.ok(result.value.length <= 10, `${JSON.stringify(state.value)} + ${JSON.stringify(text)}`);
          assert.match(result.value, /^\d*$/);
        }
      }
    }
  });
});

describe("a phone's on-screen keyboard (change handler)", () => {
  test('an 11th digit puts the 10 digits back, with the caret where it was, and reports the attempt', () => {
    const r = reconcileOrganizerMobileChange(full(), '98765432101', 11);
    assert.equal(r.value, '9876543210');
    assert.equal(r.caret, 10);
    assert.equal(r.limitAttempted, true);
  });

  test('an 11th digit in the middle leaves the number and the caret in place', () => {
    const r = reconcileOrganizerMobileChange(full(), '98761543210', 5);
    assert.equal(r.value, '9876543210');
    assert.equal(r.caret, 4);
  });

  test('letters are stripped and are not an attempt to go past the limit', () => {
    const r = reconcileOrganizerMobileChange({ value: '98765', limitAttempted: false }, '98765ab', 7);
    assert.equal(r.value, '98765');
    assert.equal(r.limitAttempted, false);
  });

  test('an ordinary change within 10 digits is kept and clears the warning', () => {
    const r = reconcileOrganizerMobileChange(full(true), '987654321', 9);
    assert.equal(r.value, '987654321');
    assert.equal(r.limitAttempted, false);
  });
});

describe('the counter', () => {
  test('the warning follows the attempt flag when one is given, and only while the field is full', () => {
    assert.equal(counterLabel(10, 10, false).text, '10/10');
    assert.equal(counterLabel(10, 10, true).text, '10/10 — limit reached');
    assert.equal(counterLabel(9, 10, true).text, '9/10', 'a stale flag cannot warn on a field that is not full');
    assert.equal(counterLabel(0, 10, true).text, '0/10');
  });

  test('without a flag - every other field - it warns whenever the field is full, exactly as before', () => {
    assert.equal(counterLabel(50, 50).text, '50/50 — limit reached');
    assert.equal(counterLabel(49, 50).text, '49/50');
    assert.equal(counterLabel(0, 20).text, '0/20');
    assert.equal(counterLabel(20, 20).atLimit, true);
  });

  test('nextLimitAttempt: an over-long attempt sets it, an accepted edit clears it, a refused non-digit leaves it', () => {
    assert.equal(nextLimitAttempt(false, 'Maximum limit reached. Only 10 digits are allowed.'), true);
    assert.equal(nextLimitAttempt(true, null), false);
    assert.equal(nextLimitAttempt(false, 'Enter digits only (0–9).'), false);
    assert.equal(nextLimitAttempt(true, 'Enter digits only (0–9).'), true);
  });
});

describe('what the form submits', () => {
  const create = read('frontend/src/pages/Events/EventCreate.tsx');
  const schemaRegex = /organizerMobile:\s*z\.string\(\)\.regex\((\/.*?\/),/.exec(create);

  test('the validation is unchanged: exactly 10 digits', () => {
    assert.ok(schemaRegex, 'the schema still validates organizerMobile with a regex');
    assert.equal(schemaRegex![1], '/^\\d{10}$/');
    assert.ok(create.includes("'Mobile No must be exactly 10 digits'"));
  });

  test('a number built by typing, pasting or replacing is exactly what the schema accepts', () => {
    const accepts = new RegExp(schemaRegex![1].slice(1, -1));
    for (const value of [
      type(empty(), '9876543210').value,
      paste(empty(), '987 654 3210').value,
      press(full(), '5', 0, 10).value && type(press(full(), '5', 0, 10), '123456789').value,
      press(type(empty(), '987643210'), '5', 4).value,
      backspace(press(full(), '1')).value + '0',
    ]) {
      assert.match(value, accepts);
      assert.equal(value.length, 10);
    }
    // Anything shorter is still refused by the unchanged validation.
    assert.equal(accepts.test(type(empty(), '987654321').value), false);
  });

  test('the payload is the form value as it is: the field adds no transformation', () => {
    assert.ok(create.includes('const { customEventType, ...fields } = form;'));
    assert.ok(create.includes('const data = { ...fields, eventType: resolveEventType(form.eventType, customEventType) };'));
    assert.equal(/organizerMobile\s*:\s*[^z\n]*(parseInt|Number|replace|slice|padStart)/.test(create), false);
  });
});

describe('how the Create Event page uses it', () => {
  const create = read('frontend/src/pages/Events/EventCreate.tsx');
  const start = create.indexOf('label="Organizer Mobile Number"');
  const field = create.slice(start, create.indexOf('<CharCount value={wOrgMobile}', start));

  test('the field has no native maxLength, which would hide the attempt and cut a paste silently', () => {
    assert.ok(start > 0);
    assert.equal(field.includes('maxLength={'), false, 'no maxLength attribute on this field');
    assert.ok(field.includes('inputMode="numeric"'));
    assert.ok(field.includes('{...organizerMobileField}'));
  });

  test('keystrokes and pastes are checked before they reach the field, and a refused one is stopped', () => {
    assert.ok(field.includes('onKeyDown={(e) => {'));
    assert.ok(field.includes('applyOrganizerMobileInput('));
    assert.ok(field.includes('if (!result.accepted) e.preventDefault();'));
    assert.ok(/onPaste=\{\(e\) => \{\s*e\.preventDefault\(\);/.test(field));
    assert.ok(field.includes('isPaste: true'));
    assert.ok(field.includes("setValue('organizerMobile', result.value, { shouldValidate: true, shouldDirty: true });"));
  });

  test('the change handler restores the previous value instead of clearing the field', () => {
    assert.ok(field.includes("{ value: getValues('organizerMobile') ?? '', limitAttempted: mobileLimitAttempted }"));
    assert.ok(field.includes('input.setSelectionRange(result.caret, result.caret);'));
    assert.ok(field.includes('organizerMobileField.onChange(e);'));
  });

  test("the counter is told about attempts, and the field's own error still shows", () => {
    assert.ok(create.includes('<CharCount value={wOrgMobile} max={10} limitAttempted={mobileLimitAttempted} />'));
    assert.ok(field.includes('error={errors.organizerMobile?.message}'));
  });
});

describe('other fields are unaffected', () => {
  const create = read('frontend/src/pages/Events/EventCreate.tsx');
  const edit = read('frontend/src/pages/Events/EventEdit.tsx');
  const contacts = read('frontend/src/pages/Contacts/ContactList.tsx');

  test("the other Create Event fields keep their native limits and their counters' old behaviour", () => {
    for (const [limit, count] of [['organizerName', 'wOrgName'], ['name', 'wName'], ['venue', 'wVenue'], ['description', 'wDesc']] as const) {
      assert.ok(create.includes(`<CharCount value={${count}} max={LIMITS.${limit}} />`), count);
    }
    assert.ok(create.includes('maxLength={LIMITS.organizerName}'));
    assert.ok(create.includes('maxLength={LIMITS.name}'));
    assert.equal((create.match(/limitAttempted=/g) ?? []).length, 1, 'only the organizer mobile counter is given an attempt flag');
  });

  test('the Edit Event form has its own, unchanged organizer mobile field', () => {
    assert.ok(edit.includes('maxLength={10}'));
    assert.ok(edit.includes("{...register('organizerMobile')}"));
    assert.equal(edit.includes('organizerMobile.ts'), false);
    assert.equal(edit.includes('applyOrganizerMobileInput'), false);
  });

  test("the guest form's WhatsApp number keeps its own rules", () => {
    assert.ok(contacts.includes('insertMobileText('));
    assert.equal(contacts.includes('applyOrganizerMobileInput'), false);
    assert.equal(contacts.includes('counterLabel'), false);
  });
});
