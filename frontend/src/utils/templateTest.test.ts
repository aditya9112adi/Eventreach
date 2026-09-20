import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplateBody,
  selectionKey,
  canSendTemplate,
  sendBlockedReason,
  describeSendError,
  variableLabel,
  type TemplatePreview,
  type SendGateState,
} from './templateTest';

const VARIABLES = [
  { index: 1, field: 'recipientName', value: 'Aditya' },
  { index: 2, field: 'eventName', value: 'Wedding' },
  { index: 3, field: 'eventDate', value: '25 September 2026' },
  { index: 4, field: 'eventTime', value: '7:00 PM' },
  { index: 5, field: 'eventVenue', value: 'Grand Palace, Pune' },
];

const preview = (overrides: Partial<TemplatePreview> = {}): TemplatePreview => ({
  templateName: 'event_reminder',
  languageCode: 'en',
  templateStatus: 'APPROVED',
  bodyText: 'Hi {{1}}, {{2}} is on {{3}} at {{4}}, {{5}}.',
  bodySource: 'meta',
  placeholderMismatch: false,
  variables: VARIABLES,
  recipient: {
    contactId: 'c1',
    fullName: 'Aditya',
    phoneNumber: '+919876543210',
    phoneValid: true,
  },
  event: { eventId: 'e1', eventName: 'Wedding' },
  ...overrides,
});

const gate = (overrides: Partial<SendGateState> = {}): SendGateState => ({
  eventId: 'e1',
  contactId: 'c1',
  templateName: 'event_reminder',
  preview: preview(),
  isSending: false,
  lastSentKey: null,
  eventSendable: true,
  ...overrides,
});

test('rendering the approved body', async (t) => {
  await t.test('substitutes every placeholder in order', () => {
    assert.equal(
      renderTemplateBody('Hi {{1}}, {{2}} is on {{3}} at {{4}}, {{5}}.', VARIABLES),
      'Hi Aditya, Wedding is on 25 September 2026 at 7:00 PM, Grand Palace, Pune.'
    );
  });

  await t.test('handles a placeholder used more than once', () => {
    assert.equal(renderTemplateBody('{{1}} — {{1}}', VARIABLES), 'Aditya — Aditya');
  });

  await t.test('tolerates inner spaces the way Meta writes them', () => {
    assert.equal(renderTemplateBody('Hi {{ 1 }}', VARIABLES), 'Hi Aditya');
  });

  await t.test('leaves a placeholder with no value visible rather than blanking it', () => {
    assert.equal(renderTemplateBody('Hi {{1}} {{9}}', VARIABLES), 'Hi Aditya {{9}}');
  });

  await t.test('a body with no placeholders is returned unchanged', () => {
    assert.equal(renderTemplateBody('See you there!', VARIABLES), 'See you there!');
  });
});

test('send gate', async (t) => {
  await t.test('allows a complete single-guest selection', () => {
    assert.equal(canSendTemplate(gate()), true);
    assert.equal(sendBlockedReason(gate()), '');
  });

  await t.test('blocks with no guest selected', () => {
    assert.equal(canSendTemplate(gate({ contactId: '' })), false);
    assert.match(sendBlockedReason(gate({ contactId: '' })), /exactly one guest/i);
  });

  await t.test('blocks until the preview has loaded', () => {
    assert.equal(canSendTemplate(gate({ preview: null })), false);
    assert.match(sendBlockedReason(gate({ preview: null })), /preview/i);
  });

  await t.test('blocks while a preview from the previously selected guest is showing', () => {
    const stale = gate({ contactId: 'c2' });
    assert.equal(canSendTemplate(stale), false);
    assert.match(sendBlockedReason(stale), /preview/i);
  });

  await t.test('blocks an unusable phone number and says why', () => {
    const bad = gate({
      preview: preview({
        recipient: {
          contactId: 'c1',
          fullName: 'Aditya',
          phoneNumber: '12345',
          phoneValid: false,
          phoneError: 'must be 10 digits',
        },
      }),
    });
    assert.equal(canSendTemplate(bad), false);
    assert.match(sendBlockedReason(bad), /must be 10 digits/);
  });

  await t.test('blocks when the approved template takes a different number of values', () => {
    assert.equal(canSendTemplate(gate({ preview: preview({ placeholderMismatch: true }) })), false);
  });

  await t.test('blocks a second click while the first send is in flight', () => {
    assert.equal(canSendTemplate(gate({ isSending: true })), false);
  });

  await t.test('blocks the same selection twice after a successful send', () => {
    const sent = gate({ lastSentKey: selectionKey('e1', 'c1', 'event_reminder') });
    assert.equal(canSendTemplate(sent), false);
    assert.match(sendBlockedReason(sent), /already sent/i);
  });

  await t.test('a different guest is sendable again after a send', () => {
    const next = gate({
      contactId: 'c2',
      preview: preview({
        recipient: { contactId: 'c2', fullName: 'Riya', phoneNumber: '+919812345678', phoneValid: true },
      }),
      lastSentKey: selectionKey('e1', 'c1', 'event_reminder'),
    });
    assert.equal(canSendTemplate(next), true);
  });

  await t.test('blocks an event that is no longer accepting messages', () => {
    assert.equal(canSendTemplate(gate({ eventSendable: false })), false);
  });
});

test('error messages', async (t) => {
  await t.test("uses the backend's own message", () => {
    const error = {
      response: { data: { error: { code: 'CONTACT_NOT_FOUND', message: 'That guest is not part of the selected event.' } } },
    };
    assert.equal(describeSendError(error), 'That guest is not part of the selected event.');
  });

  await t.test("appends Meta's error code when the rejection came from Meta", () => {
    const error = {
      response: {
        data: {
          error: {
            code: 'TEMPLATE_NOT_AVAILABLE',
            message: 'Template "event_reminder" is not available in en.',
            meta: { code: 132001, fbtraceId: 'abc' },
          },
        },
      },
    };
    assert.equal(
      describeSendError(error),
      'Template "event_reminder" is not available in en. (Meta error 132001)'
    );
  });

  await t.test('falls back to a plain-string error body', () => {
    assert.equal(
      describeSendError({ response: { data: { error: 'Access denied.' } } }),
      'Access denied.'
    );
  });

  await t.test('falls back to a network error with no response at all', () => {
    assert.equal(describeSendError({ message: 'Network Error' }), 'Network Error');
  });

  await t.test('always produces something to show', () => {
    assert.equal(describeSendError({}), 'Failed to send the template message.');
  });
});

test('variable labels', () => {
  assert.equal(variableLabel('eventVenue'), 'Venue');
  assert.equal(variableLabel('somethingNew'), 'somethingNew');
});
