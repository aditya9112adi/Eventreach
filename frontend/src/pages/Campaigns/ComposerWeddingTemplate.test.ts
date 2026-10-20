/**
 * The send rules for a template that takes no values (pranjali_ankit_wedding_invite is the example): shown
 * exactly as approved (no guest name), and - like every template - only sendable once the preview confirms the
 * approved body takes exactly the values this page fills. The Message tab no longer lists the built-in
 * templates (only the selected event's own); the backend allowlist is unchanged.
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

test('the Message tab no longer lists the built-in wedding template (or any general template)', () => {
  assert.equal(source.includes(NAME), false);
  assert.equal(/\bTEMPLATES\b/.test(source), false);
  assert.equal(source.includes('Pranjali & Ankit'), false);
});

test('the backend allowlist still holds the built-in templates, so existing API clients keep working', () => {
  assert.deepEqual(Object.keys(EVENT_TEMPLATES), ['event_reminder', 'event_document', 'event_image', 'event_video', NAME]);
  assert.deepEqual([...EVENT_TEMPLATES[NAME].fields], []);
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
