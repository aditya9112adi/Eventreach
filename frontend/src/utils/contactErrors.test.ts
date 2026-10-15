/**
 * What the Add / Edit Guest modal says when saving fails - the logic (pure; no
 * browser needed) and how the modal is wired.
 *
 * Run: npx tsx --test frontend/src/utils/contactErrors.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { CONTACT_FALLBACK_MESSAGE, contactErrorField, contactErrorMessage } from './contactErrors.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

const refusal = (status: number, error: string, code?: string, field?: string) => ({
  response: { status, data: { error, ...(code ? { code } : {}), ...(field ? { field } : {}) } },
});

describe('the message shown for each failure', () => {
  test('a duplicate number: the server\'s duplicate message, exactly', () => {
    const error = refusal(409, "This contact already exists in this event's guest list.", 'CONTACT_DUPLICATE', 'phoneNumber');
    assert.equal(contactErrorMessage(error, 'add'), "This contact already exists in this event's guest list.");
    assert.equal(contactErrorMessage(error, 'update'), "This contact already exists in this event's guest list.");
    assert.equal(contactErrorField(error), 'phoneNumber');
  });

  test('an invalid number: its own message, not the duplicate one', () => {
    assert.equal(contactErrorMessage(refusal(400, 'Please enter a valid WhatsApp number.', 'INVALID_PHONE', 'phoneNumber'), 'add'), 'Please enter a valid WhatsApp number.');
  });

  test('another validation problem keeps its own wording', () => {
    assert.equal(contactErrorMessage(refusal(400, 'Full name is required'), 'add'), 'Full name is required');
    assert.equal(contactErrorMessage(refusal(403, 'Access denied. You do not have access to this event.'), 'add'), 'Access denied. You do not have access to this event.');
  });

  test('no answer at all (offline, timeout, server asleep): "try again", not a duplicate and not a raw error', () => {
    const offline = contactErrorMessage({ message: 'Network Error', code: 'ERR_NETWORK' }, 'add');
    const timeout = contactErrorMessage({ code: 'ECONNABORTED', message: 'timeout of 0ms exceeded' }, 'add');
    assert.equal(offline, 'Unable to add contact right now. Please try again.');
    assert.equal(timeout, offline);
    assert.equal(contactErrorMessage(undefined, 'add'), offline);
    assert.equal(contactErrorMessage({ message: 'Network Error' }, 'update'), 'Unable to update contact right now. Please try again.');
  });

  test('a server error is the fixed "try again" - whatever text came with it', () => {
    for (const status of [500, 502, 503, 504]) {
      const message = contactErrorMessage(refusal(status, 'MongoServerError: E11000 secret detail'), 'add');
      assert.equal(message, CONTACT_FALLBACK_MESSAGE.add, String(status));
      assert.equal(message.includes('E11000'), false);
    }
  });

  test('a reply with no usable text is "try again" rather than blank or "undefined"', () => {
    assert.equal(contactErrorMessage({ response: { status: 400, data: {} } }, 'add'), CONTACT_FALLBACK_MESSAGE.add);
    assert.equal(contactErrorMessage({ response: { status: 400, data: { error: '   ' } } }, 'add'), CONTACT_FALLBACK_MESSAGE.add);
    assert.equal(contactErrorMessage({ response: { status: 400, data: { error: 5 } } }, 'add'), CONTACT_FALLBACK_MESSAGE.add);
    assert.equal(contactErrorMessage({ response: { status: 400 } }, 'add'), CONTACT_FALLBACK_MESSAGE.add);
  });

  test('the old catch-all sentence is gone from the add flow', () => {
    const source = read('frontend/src/pages/Contacts/ContactList.tsx');
    assert.equal(source.includes('Failed to add contact'), false);
    assert.equal(source.includes("|| 'Failed to update contact'"), false);
  });

  test('no field named, or a malformed one, is no field', () => {
    assert.equal(contactErrorField(refusal(400, 'x')), null);
    assert.equal(contactErrorField({ response: { data: { field: 5 } } }), null);
    assert.equal(contactErrorField(undefined), null);
  });
});

describe('the modal', () => {
  const page = read('frontend/src/pages/Contacts/ContactList.tsx');
  const addFlow = page.slice(page.indexOf('const onAddContact'), page.indexOf('const onEditContact'));

  test('a failure shows the message inside the modal and leaves it open with the typed values', () => {
    assert.ok(addFlow.includes("setAddError(contactErrorMessage(err, 'add'));"));
    const catchBlock = addFlow.slice(addFlow.indexOf('} catch'), addFlow.indexOf('} finally'));
    assert.equal(/setIsAddModalOpen|reset\(\)|setRefreshToken|showToast/.test(catchBlock), false, 'a failure never closes, clears, refreshes or announces success');
    assert.ok(page.includes('{addError && ('), 'the existing in-modal error panel is used');
  });

  test('success - close, reset, refresh, toast - happens only after the server confirms', () => {
    const tryBlock = addFlow.slice(addFlow.indexOf('try {'), addFlow.indexOf('} catch'));
    const post = tryBlock.indexOf("await api.post('/contacts'");
    for (const effect of ['setRefreshToken', 'setIsAddModalOpen(false)', 'reset()', "showToast('success'"]) {
      assert.ok(tryBlock.indexOf(effect) > post, `${effect} comes after the awaited request`);
    }
  });

  test('a second submit while one is in flight is ignored, and the guard is always released', () => {
    assert.ok(page.includes('const saveInFlight = useRef(false);'));
    assert.ok(addFlow.includes('if (!activeEvent || saveInFlight.current) return;'));
    assert.ok(/saveInFlight\.current = true;[\s\S]*?\} finally \{\s*saveInFlight\.current = false;/.test(addFlow));
    assert.ok(page.includes('<Button type="submit" isLoading={isSubmitting}>'), 'and the button is disabled while saving');
  });

  test('editing a guest gets the same treatment', () => {
    const edit = page.slice(page.indexOf('const onEditContact'), page.indexOf('const handleDelete'));
    assert.ok(edit.includes("setAddError(contactErrorMessage(err, 'update'));"));
    assert.ok(edit.includes('saveInFlight.current'));
  });

  test('a full phone field is not shown as a "limit reached" error', () => {
    assert.ok(page.includes('max={INDIA_MOBILE_DIGITS} warnAtMax={false}'));
    assert.ok(page.includes('warnAtMax = true'), 'other fields still warn at their maximum');
  });
});
