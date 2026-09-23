import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplateBody,
  selectionKey,
  canSendTemplate,
  sendBlockedReason,
  describeSendError,
  summarizeSendResult,
  filterGuests,
  guestSelectionLabel,
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
  contactIds: ['c1'],
  templateName: 'event_reminder',
  preview: preview(),
  isSending: false,
  lastSentKey: null,
  eventSendable: true,
  ...overrides,
});

const GUESTS = [
  { _id: 'c1', fullName: 'Shubham Suryavanshi', phoneNumber: '+918530808862' },
  { _id: 'c2', fullName: 'Aditya Shankar Kshirsagar', phoneNumber: '+919112472833' },
  { _id: 'c3', fullName: 'Riya Patil', phoneNumber: '+919812345678' },
];

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

test('guest picker', async (t) => {
  await t.test('the closed selector shows a count, never a list of names', () => {
    assert.equal(guestSelectionLabel(0), 'Select guests...');
    assert.equal(guestSelectionLabel(1), '1 guest selected');
    assert.equal(guestSelectionLabel(2), '2 guests selected');
    assert.equal(guestSelectionLabel(5), '5 guests selected');
  });

  await t.test('an empty search shows every guest', () => {
    assert.deepEqual(filterGuests(GUESTS, '').map((g) => g._id), ['c1', 'c2', 'c3']);
    assert.deepEqual(filterGuests(GUESTS, '   ').map((g) => g._id), ['c1', 'c2', 'c3']);
  });

  await t.test('filters by name, ignoring case', () => {
    assert.deepEqual(filterGuests(GUESTS, 'aditya').map((g) => g._id), ['c2']);
    assert.deepEqual(filterGuests(GUESTS, 'SURYA').map((g) => g._id), ['c1']);
  });

  await t.test('filters by phone number, with or without the country code', () => {
    assert.deepEqual(filterGuests(GUESTS, '+9185308').map((g) => g._id), ['c1']);
    assert.deepEqual(filterGuests(GUESTS, '9112472833').map((g) => g._id), ['c2']);
    assert.deepEqual(filterGuests(GUESTS, '8530 808').map((g) => g._id), ['c1']);
  });

  await t.test('a search that matches nothing returns an empty list, not everything', () => {
    assert.deepEqual(filterGuests(GUESTS, 'zzz'), []);
  });

  await t.test('filtering does not touch the source list, so selections survive it', () => {
    const before = GUESTS.map((g) => g._id);
    filterGuests(GUESTS, 'riya');
    assert.deepEqual(GUESTS.map((g) => g._id), before);
  });
});

test('send gate', async (t) => {
  await t.test('allows one selected guest', () => {
    assert.equal(canSendTemplate(gate()), true);
    assert.equal(sendBlockedReason(gate()), '');
  });

  await t.test('allows several selected guests', () => {
    assert.equal(canSendTemplate(gate({ contactIds: ['c1', 'c2', 'c3'] })), true);
  });

  await t.test('blocks with no guest selected', () => {
    assert.equal(canSendTemplate(gate({ contactIds: [] })), false);
    assert.match(sendBlockedReason(gate({ contactIds: [] })), /at least one guest/i);
  });

  await t.test('blocks until the preview has loaded', () => {
    assert.equal(canSendTemplate(gate({ preview: null })), false);
    assert.match(sendBlockedReason(gate({ preview: null })), /preview/i);
  });

  await t.test('blocks while a preview from a previous selection is showing', () => {
    const stale = gate({ contactIds: ['c2', 'c1'] });
    assert.equal(canSendTemplate(stale), false);
    assert.match(sendBlockedReason(stale), /preview/i);
  });

  await t.test('blocks a lone guest whose phone number cannot be used, and says why', () => {
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

  await t.test('a bad number in a batch does not block the other guests', () => {
    const batch = gate({
      contactIds: ['c1', 'c2'],
      preview: preview({
        recipient: { contactId: 'c1', fullName: 'Aditya', phoneNumber: '12345', phoneValid: false },
      }),
    });
    assert.equal(canSendTemplate(batch), true);
  });

  await t.test('blocks when the approved template takes a different number of values', () => {
    assert.equal(canSendTemplate(gate({ preview: preview({ placeholderMismatch: true }) })), false);
  });

  await t.test('blocks a second click while the first send is in flight', () => {
    assert.equal(canSendTemplate(gate({ isSending: true })), false);
  });

  await t.test('blocks the same selection twice after a send', () => {
    const sent = gate({
      contactIds: ['c1', 'c2'],
      lastSentKey: selectionKey('e1', ['c1', 'c2'], 'event_reminder'),
    });
    assert.equal(canSendTemplate(sent), false);
    assert.match(sendBlockedReason(sent), /already sent/i);
  });

  await t.test('the selection key ignores the order guests were ticked in', () => {
    assert.equal(
      selectionKey('e1', ['c2', 'c1'], 'event_reminder'),
      selectionKey('e1', ['c1', 'c2'], 'event_reminder')
    );
  });

  await t.test('adding a guest makes the selection sendable again', () => {
    const next = gate({
      contactIds: ['c1', 'c2', 'c3'],
      lastSentKey: selectionKey('e1', ['c1', 'c2'], 'event_reminder'),
    });
    assert.equal(canSendTemplate(next), true);
  });

  await t.test('blocks an event that is no longer accepting messages', () => {
    assert.equal(canSendTemplate(gate({ eventSendable: false })), false);
    assert.equal(canSendTemplate(gate({ contactIds: ['c1', 'c2'], eventSendable: false })), false);
  });
});

test('reporting the result', async (t) => {
  const sent = (id: string, name: string) => ({
    contactId: id,
    fullName: name,
    messageId: `wamid.${id}`,
    status: 'accepted',
  });
  const failed = (id: string, name: string | null, reason: string) => ({
    contactId: id,
    fullName: name,
    reason,
    code: 'RECIPIENT_NOT_ALLOWED',
  });

  await t.test('one guest, sent', () => {
    const summary = summarizeSendResult({ sent: [sent('c1', 'Aditya')], failed: [] });
    assert.equal(summary.tone, 'success');
    assert.equal(summary.headline, 'WhatsApp accepted the message for Aditya.');
  });

  await t.test('several guests, all sent', () => {
    const summary = summarizeSendResult({
      sent: [sent('c1', 'A'), sent('c2', 'B'), sent('c3', 'C')],
      failed: [],
    });
    assert.equal(summary.tone, 'success');
    assert.equal(summary.headline, 'WhatsApp accepted all 3 messages.');
  });

  await t.test('a partial failure is never reported as a success', () => {
    const summary = summarizeSendResult({
      sent: [sent('c1', 'A'), sent('c2', 'B'), sent('c3', 'C'), sent('c4', 'D')],
      failed: [failed('c5', 'E', 'This number is not allowed to receive messages.')],
    });
    assert.equal(summary.tone, 'partial');
    assert.equal(summary.headline, '4 of 5 messages sent — 1 guest failed.');
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].reason, 'This number is not allowed to receive messages.');
  });

  await t.test('every guest failing is an error, with each reason kept', () => {
    const summary = summarizeSendResult({
      sent: [],
      failed: [failed('c1', 'A', 'Template not available.'), failed('c2', 'B', 'Template not available.')],
    });
    assert.equal(summary.tone, 'error');
    assert.equal(summary.headline, 'No messages were sent — 2 guests failed.');
    assert.equal(summary.failed.length, 2);
  });

  await t.test('a guest that could not even be resolved still appears', () => {
    const summary = summarizeSendResult({ sent: [], failed: [failed('c9', null, 'That guest is not part of the selected event.')] });
    assert.equal(summary.failed[0].fullName, null);
    assert.equal(summary.headline, 'No messages were sent — 1 guest failed.');
  });

  await t.test("Meta's error number is shown with the reason it belongs to", () => {
    const summary = summarizeSendResult({
      sent: [sent('c1', 'A')],
      failed: [{ contactId: 'c2', fullName: 'B', reason: 'This number cannot receive messages.', code: 'RECIPIENT_NOT_ALLOWED', metaCode: 131030 }],
    });
    assert.equal(summary.failed[0].reason, 'This number cannot receive messages. (Meta error 131030)');
  });

  await t.test('a failure without a Meta number is left alone', () => {
    const summary = summarizeSendResult({ sent: [], failed: [failed('c1', 'A', 'That guest is not part of the selected event.')] });
    assert.equal(summary.failed[0].reason, 'That guest is not part of the selected event.');
  });

  await t.test('a body with no lists does not throw', () => {
    const summary = summarizeSendResult({});
    assert.equal(summary.tone, 'success');
    assert.deepEqual(summary.sent, []);
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
