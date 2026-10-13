/**
 * pranjali_ankit_wedding_invite in the Composer's template dropdown: offered
 * for every event, mirrored from the backend allowlist, sent exactly as
 * approved (nothing filled in, no guest name) - and, like every template,
 * only sendable once the preview confirms the approved body takes exactly the
 * values this page fills: here, none.
 *
 * Run: npx tsx --test frontend/src/pages/Campaigns/ComposerWeddingTemplate.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { EVENT_TEMPLATES } from '../../../../backend/src/services/eventTemplateMessage';
import {
  canSendTemplate,
  renderTemplateBody,
  sendBlockedReason,
  type SendGateState,
  type TemplatePreview,
} from '../../utils/templateTest';

const NAME = 'pranjali_ankit_wedding_invite';
const source = fs.readFileSync('frontend/src/pages/Campaigns/Composer.tsx', 'utf-8').split('\r\n').join('\n');

/** The names in the page's TEMPLATES list, in order. */
const listedNames = (): string[] => {
  const list = /const TEMPLATES = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(list, 'the TEMPLATES list is present');
  return [...list[1].matchAll(/name: '([a-z0-9_]+)'/g)].map((m) => m[1]);
};

test('the dropdown offers the wedding template, described as sent exactly as approved', () => {
  assert.ok(listedNames().includes(NAME));
  assert.ok(source.includes("label: 'Pranjali & Ankit wedding invite',"));
  assert.ok(
    source.includes(
      "'Approved marketing template, sent exactly as approved. Nothing is filled in or personalised; its wording is set by the approved template and cannot be edited here.',"
    )
  );
  assert.equal(source.includes('Fills the guest name; the rest of its wording'), false, 'no claim that it is personalised');
});

test('the dropdown lists exactly what the backend will send, existing templates first and unchanged', () => {
  assert.deepEqual(listedNames(), ['event_reminder', 'event_document', 'event_image', 'event_video', NAME]);
  assert.deepEqual(listedNames(), Object.keys(EVENT_TEMPLATES));
});

test('the backend fills nothing for it', () => {
  assert.deepEqual([...EVENT_TEMPLATES[NAME].fields], []);
});

test('it is offered for any event: the list is rendered whole, never filtered by event', () => {
  assert.ok(source.includes('{TEMPLATES.map((template) => ('));
  assert.equal(/TEMPLATES\.filter\(/.test(source), false, 'no per-event filtering of templates');
  assert.equal(source.split(NAME).length - 1, 1, 'named once, in the list - no special case elsewhere on the page');
});

const APPROVED_BODY = 'You are warmly invited to celebrate with us. [mocked body for the test]';

const preview = (overrides: Partial<TemplatePreview> = {}): TemplatePreview => ({
  templateName: NAME,
  languageCode: 'en',
  templateStatus: 'APPROVED',
  bodyText: APPROVED_BODY,
  bodySource: 'meta',
  placeholderMismatch: false,
  header: null,
  variables: [],
  recipient: { contactId: 'c1', fullName: 'Riya Sharma', phoneNumber: '+919876543210', phoneValid: true },
  event: { eventId: 'any-event', eventName: 'Corporate Gala' },
  ...overrides,
});

const gate = (overrides: Partial<SendGateState> = {}): SendGateState => ({
  eventId: 'any-event',
  contactIds: ['c1'],
  templateName: NAME,
  preview: preview(),
  isSending: false,
  lastSentKey: null,
  eventSendable: true,
  attachment: null,
  ...overrides,
});

test('the phone preview shows the approved wording unchanged - no guest name substituted', () => {
  const shown = renderTemplateBody(APPROVED_BODY, preview().variables);
  assert.equal(shown, APPROVED_BODY);
  assert.equal(shown.includes('Riya Sharma'), false);
});

test('Send is enabled when the approved body takes no values, with no file needed', () => {
  assert.equal(canSendTemplate(gate()), true);
  assert.equal(sendBlockedReason(gate()), '');
});

test('Send stays disabled when the approved body takes values this page does not fill', () => {
  const mismatched = gate({ preview: preview({ placeholderMismatch: true }) });
  assert.equal(canSendTemplate(mismatched), false);
  assert.equal(sendBlockedReason(mismatched), 'The approved template expects a different number of values than this page fills.');
});
