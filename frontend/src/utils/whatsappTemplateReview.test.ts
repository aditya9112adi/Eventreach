/**
 * Template buttons, the payload review and the Meta account list - the page
 * logic (pure; no browser needed).
 *
 * Run: npx tsx --test frontend/src/utils/whatsappTemplateReview.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_FORM,
  accountListParams,
  accountUsabilityNote,
  addableButtonTypes,
  appendAccountPage,
  buildTemplatePayload,
  canBrowseAccount,
  canConfirmSubmission,
  emptyButtonRow,
  formFromTemplate,
  metaStatusDisplay,
  parseAccountPage,
  parseReview,
  prettyPayload,
  submitBody,
  validateForm,
  type AccountTemplateView,
  type ButtonRow,
  type TemplateForm,
  type TemplateView,
} from './whatsappTemplates.ts';

const HASH = 'b'.repeat(64);

const form = (buttons: ButtonRow[] = []): TemplateForm => ({
  ...EMPTY_FORM, displayName: 'Invite', name: 'invite', body: 'You are invited. Please reply.', buttons,
});

const row = (over: Partial<ButtonRow>): ButtonRow => ({ ...emptyButtonRow('QUICK_REPLY'), ...over });

describe('buttons in the form', () => {
  test('are sent with only the fields their type uses', () => {
    const payload: any = buildTemplatePayload(form([
      row({ text: ' Yes ' }),
      row({ type: 'URL', text: 'RSVP', url: ' https://example.com/rsvp ', phoneNumber: 'ignored' }),
      row({ type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+919876543210', url: 'ignored' }),
    ]));
    assert.deepEqual(payload.buttons, [
      { type: 'QUICK_REPLY', text: 'Yes' },
      { type: 'URL', text: 'RSVP', url: 'https://example.com/rsvp' },
      { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+919876543210' },
    ]);
  });

  test('a template without buttons sends an empty list, so removing the last one is saved', () => {
    assert.deepEqual((buildTemplatePayload(form()) as any).buttons, []);
  });

  test('the shared validation the API runs is applied: each problem against its own button', () => {
    assert.deepEqual(validateForm(form([row({ text: 'Yes' })])), {});
    const errors = validateForm(form([row({ text: '' }), row({ type: 'URL', text: 'Go', url: 'http://insecure.example.com' }), row({ type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '12' })]));
    assert.deepEqual(Object.keys(errors).sort(), ['buttons[0].text', 'buttons[1].url', 'buttons[2].phoneNumber']);
  });

  test('a stored template round-trips into the form and back', () => {
    const stored = { ...baseTemplate(), buttons: [{ type: 'URL', text: 'RSVP', url: 'https://example.com/rsvp' }, { type: 'QUICK_REPLY', text: 'Yes' }] } as any;
    const f = formFromTemplate(stored);
    assert.deepEqual(f.buttons, [
      { type: 'URL', text: 'RSVP', url: 'https://example.com/rsvp', phoneNumber: '' },
      { type: 'QUICK_REPLY', text: 'Yes', url: '', phoneNumber: '' },
    ]);
    assert.deepEqual((buildTemplatePayload(f) as any).buttons, stored.buttons);
    assert.deepEqual(formFromTemplate({ ...baseTemplate(), buttons: undefined } as any).buttons, [], 'an older answer without buttons is read as none');
  });

  test('only the types that still fit can be added', () => {
    assert.deepEqual(addableButtonTypes([]), ['QUICK_REPLY', 'URL', 'PHONE_NUMBER']);
    assert.deepEqual(addableButtonTypes([row({ type: 'PHONE_NUMBER' })]), ['QUICK_REPLY', 'URL']);
    assert.deepEqual(addableButtonTypes([row({ type: 'URL' }), row({ type: 'URL' })]), ['QUICK_REPLY', 'PHONE_NUMBER']);
    assert.deepEqual(addableButtonTypes(Array.from({ length: 10 }, () => row({}))), []);
  });
});

const baseTemplate = (): Partial<TemplateView> => ({
  id: 't1', displayName: 'Invite', name: 'invite', language: 'en', category: 'MARKETING', body: 'Hi', variables: [], headerText: null, footer: null, eventId: null, ownerAdminId: null,
});

describe('the payload review', () => {
  const good = { template: baseTemplate(), payload: { name: 'invite', components: [] }, payloadHash: HASH, canSubmit: true, blockers: [] };

  test('a well-formed review can be confirmed only once it is ticked, and not while busy', () => {
    const review = parseReview(good)!;
    assert.equal(canConfirmSubmission(review, true, false), true);
    assert.equal(canConfirmSubmission(review, false, false), false, 'no tick, no submit');
    assert.equal(canConfirmSubmission(review, true, true), false);
    assert.equal(canConfirmSubmission(null, true, false), false);
  });

  test('a review that is blocked, or malformed, can never be confirmed', () => {
    assert.equal(canConfirmSubmission(parseReview({ ...good, canSubmit: false, blockers: ['Already submitted'] }), true, false), false);
    assert.equal(canConfirmSubmission(parseReview({ ...good, payloadHash: 'nope' }), true, false), false, 'a missing or malformed hash disables it');
    assert.equal(canConfirmSubmission(parseReview({ ...good, payload: null }), true, false), false);
    assert.equal(canConfirmSubmission(parseReview({ ...good, canSubmit: 'yes' }), true, false), false);
    assert.equal(parseReview(null), null);
    assert.equal(parseReview({ canSubmit: 'maybe' }), null);
  });

  test('the submission carries the hash that was reviewed, and the payload is shown as the server built it', () => {
    const review = parseReview(good)!;
    assert.deepEqual(submitBody(review), { confirmPayloadHash: HASH });
    assert.equal(prettyPayload(review.payload), JSON.stringify({ name: 'invite', components: [] }, null, 2));
  });

  test('blockers and field errors are kept for display, and only as text', () => {
    const review = parseReview({ ...good, canSubmit: false, blockers: ['A', 5, 'B'], errors: [{ field: 'body', message: 'Required' }] })!;
    assert.deepEqual(review.blockers, ['A', 'B']);
    assert.equal(review.errors?.[0].field, 'body');
  });
});

describe('the Meta account list', () => {
  const t = (over: Partial<AccountTemplateView> = {}): AccountTemplateView => ({
    id: '1', name: 'invite', language: 'en', status: 'APPROVED', category: 'MARKETING', rejectedReason: null, headerFormat: null, headerText: null, bodyText: 'Hi', footerText: null,
    buttons: [], localTemplateId: 'local1', sendableFromHere: true, ...over,
  });

  test('only a Super Admin is offered it', () => {
    assert.equal(canBrowseAccount({ role: 'SuperAdmin' }), true);
    assert.equal(canBrowseAccount({ role: 'Admin', canManageWhatsAppTemplates: true }), false);
    assert.equal(canBrowseAccount(null), false);
  });

  test('a page is read defensively and a missing cursor means the end', () => {
    const page = parseAccountPage({ templates: [{ id: '1', name: 'a' }, null, { name: 'no id' }, 'x'], nextCursor: '', skipped: 2, fetchedAt: '2026-10-13T10:00:00Z' });
    assert.deepEqual(page.templates.map((x) => x.id), ['1']);
    assert.equal(page.nextCursor, null);
    assert.equal(page.skipped, 2);
    assert.deepEqual(parseAccountPage(undefined), { templates: [], nextCursor: null, skipped: 0, fetchedAt: null });
    assert.equal(parseAccountPage({ templates: [], nextCursor: 'CUR' }).nextCursor, 'CUR');
  });

  test('loading more appends without repeating a template and carries the new cursor', () => {
    const first = parseAccountPage({ templates: [t({ id: '1' }), t({ id: '2' })], nextCursor: 'A', skipped: 1 });
    const second = parseAccountPage({ templates: [t({ id: '2' }), t({ id: '3' })], nextCursor: null, skipped: 1 });
    const merged = appendAccountPage(first, second);
    assert.deepEqual(merged.templates.map((x) => x.id), ['1', '2', '3']);
    assert.equal(merged.nextCursor, null);
    assert.equal(merged.skipped, 2);
    assert.equal(appendAccountPage(null, second), second);
  });

  test('the request asks for the first page, or for exactly the cursor it was given', () => {
    assert.deepEqual(accountListParams(null), { limit: 25 });
    assert.deepEqual(accountListParams('CUR', 10), { limit: 10, after: 'CUR' });
  });

  test("Meta's statuses are shown as Meta's, and an unrecognised one is unknown rather than guessed", () => {
    assert.equal(metaStatusDisplay('APPROVED').label, 'Approved by Meta');
    assert.equal(metaStatusDisplay('PENDING').variant, 'warning');
    assert.equal(metaStatusDisplay('REJECTED').variant, 'error');
    assert.equal(metaStatusDisplay('SOMETHING_NEW').label, 'Unknown status (SOMETHING_NEW)');
    assert.equal(metaStatusDisplay(null).label, 'Status unknown');
    assert.equal(metaStatusDisplay(undefined).variant, 'default');
  });

  test('a template is never described as usable unless the server says it is', () => {
    assert.equal(accountUsabilityNote(t()), '');
    assert.match(accountUsabilityNote(t({ localTemplateId: null, sendableFromHere: false })), /only at Meta/);
    assert.match(accountUsabilityNote(t({ status: 'PAUSED', sendableFromHere: false })), /paused by meta/);
    assert.match(accountUsabilityNote(t({ sendableFromHere: false })), /not recorded it as approved/);
  });
});
