/**
 * Adding a guest to a Sub-Event by hand: the rules of the form (utils/guestForm.ts, run for
 * real here) and how the Members section wires the dialog (checked in the source, as this
 * repo has no DOM test runner).
 *
 * The server's side - the guest is the Sub-Event's own, appears only on its list, is refused
 * as a duplicate, needs authorization - is in tests/contactsSubEvent.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/components/ui/AddGuestDialog.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { guestSchema, GUEST_EMAIL_MAX, GUEST_NAME_MAX } from '../../utils/guestForm.ts';
import { isOwnGuestOf } from '../../utils/subEventMembers.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const dialog = read('frontend/src/components/ui/AddGuestDialog.tsx');
const members = read('frontend/src/components/ui/SubEventMembers.tsx');
const contacts = read('frontend/src/pages/Contacts/ContactList.tsx');

const valid = { fullName: 'Asha Rao', phoneNumber: '9876543210', countryCode: 'IN', email: 'asha@gmail.com' };
const problems = (input: Record<string, unknown>) => {
  const parsed = guestSchema.safeParse({ ...valid, ...input });
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('the Add Guest form has the main event\'s validation', () => {
  test('a complete guest is accepted; the email is optional', () => {
    assert.deepEqual(problems({}), []);
    assert.deepEqual(problems({ email: '' }), []);
    assert.deepEqual(problems({ email: undefined }), []);
  });

  test('the name is required and at most 50 characters', () => {
    assert.deepEqual(problems({ fullName: '' }), ['fullName: Name is required']);
    assert.deepEqual(problems({ fullName: 'x'.repeat(GUEST_NAME_MAX) }), []);
    assert.deepEqual(problems({ fullName: 'x'.repeat(GUEST_NAME_MAX + 1) }), ['fullName: Full name must be at most 50 characters']);
  });

  test('the mobile number is required, ten digits and a valid Indian mobile', () => {
    assert.equal(problems({ phoneNumber: '' }).length, 1);
    for (const bad of ['12345', '987654321', '98765432101', '5876543210', '98765abcde', '0000000000']) {
      assert.equal(problems({ phoneNumber: bad }).length, 1, bad);
    }
    for (const good of ['9876543210', '6123456789', '7000000000', '8999999999']) assert.deepEqual(problems({ phoneNumber: good }), [], good);
  });

  test('the email, if given, must be a @gmail.com address of at most 60 characters', () => {
    assert.deepEqual(problems({ email: 'someone@yahoo.com' }), ['email: Only @gmail.com emails allowed']);
    assert.deepEqual(problems({ email: 'no-at-sign' }), ['email: Only @gmail.com emails allowed']);
    assert.deepEqual(problems({ email: `${'a'.repeat(51)}@gmail.com` }), ['email: Only @gmail.com emails allowed']);
    assert.deepEqual(problems({ email: `${'a'.repeat(50)}@gmail.com` }), []);
    assert.equal(GUEST_EMAIL_MAX, 60);
  });

  test('the country code travels with the form but cannot be blank', () => {
    assert.deepEqual(problems({ countryCode: '' }), ['countryCode: Code required']);
  });

  test('it is the same rule as the one on the Contacts page', () => {
    // The Contacts page keeps its own copy of the schema; they must not drift apart.
    for (const rule of [
      "z.string().min(1, 'Name is required').max(50, 'Full name must be at most 50 characters')",
      'validateMobileForSave(value)',
      "z.string().min(1, 'Code required')",
      "/^[^@]{1,50}@gmail\\.com$/.test(val)",
      "message: 'Only @gmail.com emails allowed'",
    ]) {
      assert.ok(contacts.includes(rule), `Contacts page: ${rule}`);
      assert.ok(read('frontend/src/utils/guestForm.ts').includes(rule.replace("z.string().min(1, 'Name is required').max(50,", "z.string().min(1, 'Name is required').max(GUEST_NAME_MAX,")), `guest form: ${rule}`);
    }
  });
});

describe('the dialog', () => {
  test('is the Contacts page\'s form: fixed India country, digit-only phone handling, counters, Cancel and Add Guest', () => {
    for (const piece of [
      'zodResolver(guestSchema)',
      '<input type="hidden" {...register(\'countryCode\')} value={DEFAULT_COUNTRY_CODE} />',
      'insertMobileText(',
      'limitMobileTyping(',
      'indianSubscriberLength(wPhone)',
      'error={phoneHint ?? errors.phoneNumber?.message}',
      'label="Email (Optional)"',
      '>Cancel</Button>',
      '>Add Guest</Button>',
      'Add Guest Manually',
    ]) assert.ok(dialog.includes(piece), piece);
    assert.ok(dialog.includes('if (phoneHint) {\n                e.preventDefault();'), 'a refused keystroke blocks saving');
  });

  test('posts one guest to the selected sub-event through the guest endpoint, and only refreshes once the server confirms', () => {
    assert.ok(dialog.includes("await api.post('/contacts', { ...data, eventId: subEvent._id });"));
    const submit = dialog.slice(dialog.indexOf('const onSubmit'), dialog.indexOf('return createPortal('));
    assert.ok(submit.indexOf('await api.post') < submit.indexOf('onAdded()'), 'refresh only after the answer');
    assert.ok(submit.indexOf('onAdded()') < submit.indexOf('close()'));
    assert.ok(submit.includes("showToast('success', 'Guest added successfully');"));
    assert.ok(submit.includes("setError(contactErrorMessage(err, 'add'));"), 'a refusal is shown in the dialog, which stays open');
    assert.equal(/members|member-candidates|bulk|import/i.test(submit), false, 'no member, bulk or import call');
  });

  test('cannot send the same guest twice, and starts empty each time it opens', () => {
    assert.ok(dialog.includes('if (inFlight.current) return;\n    inFlight.current = true;'));
    assert.ok(dialog.includes('inFlight.current = false;'));
    assert.ok(dialog.includes('reset(EMPTY);\n    setError(\'\');\n    setPhoneHint(null);'));
    assert.ok(dialog.includes('[open, subEvent._id, reset]'));
    assert.ok(dialog.includes('if (!open) return null;'));
  });

  test('is an accessible dialog rendered over the window like the others, naming the sub-event', () => {
    assert.ok(dialog.includes('role="dialog" aria-modal="true" aria-labelledby="add-guest-title"'));
    assert.ok(dialog.includes('return createPortal('));
    assert.ok(dialog.includes('To {subEvent.eventName}'));
    assert.ok(dialog.includes('aria-label="Close"'));
  });
});

describe('the Members section', () => {
  test('has Add Guest after Upload, same size and style, switched off for a completed event', () => {
    const upload = members.indexOf('<Upload className="w-4 h-4 mr-1.5" /> Upload');
    const add = members.indexOf('<UserPlus className="w-4 h-4 mr-1.5" /> Add Guest');
    assert.ok(upload > 0 && add > upload, 'Upload, then Add Guest');
    const button = members.slice(members.indexOf('onClick={() => setIsAddGuestOpen(true)}'), add);
    assert.ok(button.includes('disabled={!canAdd}'));
    assert.ok(button.includes('className="text-xs px-4 py-2"'));
    assert.ok(members.includes('<div className="flex flex-wrap gap-2 shrink-0">'), 'wraps on narrow screens');
  });

  test('opens the dialog for this sub-event, and the list refreshes when a guest is added', () => {
    assert.ok(members.includes('<AddGuestDialog subEvent={subEvent} open={isAddGuestOpen} onClose={() => setIsAddGuestOpen(false)} onAdded={refresh} />'));
  });

  test('keeps Excel, PDF and Upload as they were, and still has no Add Members', () => {
    assert.ok(members.includes("onClick={() => runExport('excel')}"));
    assert.ok(members.includes("onClick={() => runExport('pdf')}"));
    assert.ok(members.includes('<MemberUploadDialog subEvent={subEvent} open={isUploadOpen}'));
    assert.equal(members.includes('Add Members'), false);
    assert.equal(members.includes('member-candidates'), false);
  });

  test('a guest added here shows as this sub-event\'s and is deleted, an assigned contact is only removed', () => {
    assert.ok(members.includes("isOwnGuestOf(subEvent._id, m) ? 'This sub-event'"));
    assert.ok(members.includes('<DeleteIconButton onClick={() => setConfirmRemove(m)} title="Delete Guest"'));
    assert.ok(members.includes('title="Remove from this sub-event"'));
  });
});

describe('telling a sub-event\'s own guest from an assigned contact', () => {
  const guestOf = (eventId: string | undefined, sourceId?: string) => ({ eventId, sourceEvent: sourceId ? { _id: sourceId, eventName: 'x' } : null });
  test('is by the event that owns the contact', () => {
    assert.equal(isOwnGuestOf('sub', guestOf('sub')), true);
    assert.equal(isOwnGuestOf('sub', guestOf('main')), false);
    assert.equal(isOwnGuestOf('sub', guestOf('other-sub')), false);
  });
  test('falls back to the named source event when the owner is not given', () => {
    assert.equal(isOwnGuestOf('sub', guestOf(undefined, 'sub')), true);
    assert.equal(isOwnGuestOf('sub', guestOf(undefined, 'main')), false);
    assert.equal(isOwnGuestOf('sub', guestOf(undefined)), false);
  });
});
