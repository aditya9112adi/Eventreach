/**
 * POC test send - the page logic (pure; no browser needed).
 *
 * Run: npx tsx --test frontend/src/utils/pocTestSend.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SELECTION,
  activeRecipients,
  canPreview,
  canReconcile,
  canSend,
  deliveryDisplay,
  outcomeDisplay,
  parsePocRecipients,
  parsePocSenders,
  parsePocTemplates,
  parsePreview,
  problemText,
  previewRequest,
  retryAdvice,
  selectableTemplates,
  selectionKey,
  sendNoAnswer,
  sendRequest,
  senderSelectable,
  valueErrors,
  type PocTemplateView,
  type PreviewView,
  type Selection,
  type TestSendView,
} from './pocTestSend.ts';

const HASH = 'a'.repeat(64);

const template = (over: Partial<PocTemplateView> = {}): PocTemplateView => ({
  id: 't1', name: 'invite', displayName: 'Invite', language: 'en', category: 'MARKETING', body: 'Dear {{1}}', localState: 'Approved', metaStatus: 'APPROVED',
  variables: [{ position: 1, label: 'Guest name', sample: 'Riya' }], buttons: [], sendable: true, reasons: [], ...over,
});

const selection = (over: Partial<Selection> = {}): Selection => ({ senderId: 's1', templateId: 't1', recipientId: 'r1', values: ['Riya'], ...over });

const preview = (over: Partial<PreviewView> = {}): PreviewView => ({
  preview: {
    sender: { id: 's1', label: 'POC', numberMasked: '+91******1111', status: 'CONNECTED' },
    template: { id: 't1', name: 'invite', language: 'en', category: 'MARKETING', status: 'APPROVED' },
    recipient: { id: 'r1', label: 'Riya', numberMasked: '+91******3210', consent: 'Agreed' },
    renderedBody: 'Dear Riya', footer: null, buttons: [], variableCount: 1,
  },
  confirmation: { previewHash: HASH, idempotencyKey: 'key-0123456789abcdef' },
  duplicateRisk: null,
  notice: 'Nothing has been sent.',
  ...over,
});

const send = (over: Partial<TestSendView> = {}): TestSendView => ({
  id: 'x1', outcome: 'accepted', state: 'Accepted', message: 'ok', template: { id: 't1', name: 'invite', language: 'en' }, senderId: 's1',
  recipient: { id: 'r1', numberMasked: '+91******3210' }, variableCount: 1, messageId: 'wamid.X', delivery: null, deliveryUpdatedAt: null, errorCategory: null,
  metaErrorCode: null, outcomeCode: 'ACCEPTED', claimedAt: '2026-10-13T10:00:00Z', completedAt: null, reconciledAt: null, retry: { safe: false, reason: 'Accepted.' }, ...over,
});

const ready = (over: Record<string, unknown> = {}) => ({ preview: preview(), previewKey: selectionKey(selection()), currentKey: selectionKey(selection()), confirmed: true, acknowledgedDuplicate: false, busy: false, ...over });

describe('what the server returns is read defensively', () => {
  test('malformed answers become empty lists and never enable anything', () => {
    assert.deepEqual(parsePocSenders(null).senders, []);
    assert.deepEqual(parsePocSenders({ senders: 'x' }).config.missing, []);
    assert.deepEqual(parsePocTemplates({ templates: [null, 5, {}] }), []);
    assert.deepEqual(parsePocRecipients(undefined), []);
  });

  test('a template is sendable only when the server said so, exactly', () => {
    const parsed = parsePocTemplates({ templates: [{ id: 'a', name: 'a', sendable: 'true' }, { id: 'b', name: 'b', sendable: true }, { id: 'c', name: 'c' }] });
    assert.deepEqual(selectableTemplates(parsed).map((t) => t.id), ['b']);
  });

  test('a sender is selectable only when eligible is exactly true', () => {
    const base: any = { id: 's', capabilities: {}, reasons: [] };
    assert.equal(senderSelectable({ ...base, eligible: true }), true);
    assert.equal(senderSelectable({ ...base, eligible: 'yes' }), false);
    assert.equal(senderSelectable({ ...base, eligible: undefined }), false);
  });

  test('a preview without the hash and key the send needs is not a preview', () => {
    assert.equal(parsePreview({ preview: {}, confirmation: {} }), null);
    assert.equal(parsePreview({ preview: {}, confirmation: { previewHash: 'short', idempotencyKey: 'key-0123456789abcdef' } }), null);
    assert.equal(parsePreview({ preview: {}, confirmation: { previewHash: HASH, idempotencyKey: 'x' } }), null);
    assert.equal(parsePreview({ confirmation: { previewHash: HASH, idempotencyKey: 'key-0123456789abcdef' } }), null);
    assert.ok(parsePreview(preview()));
  });

  test('only active recipients are offered', () => {
    const recipients: any[] = [{ id: 'a', status: 'active' }, { id: 'b', status: 'revoked' }];
    assert.deepEqual(activeRecipients(recipients).map((r) => r.id), ['a']);
  });
});

describe('values', () => {
  test('every placeholder needs a value; no line breaks, tabs or long runs of spaces', () => {
    const t = template({ variables: [{ position: 1, label: 'A', sample: '' }, { position: 2, label: 'B', sample: '' }] });
    assert.deepEqual(Object.keys(valueErrors(t, ['x', 'y'])), []);
    assert.deepEqual(Object.keys(valueErrors(t, ['x', ''])), ['1']);
    assert.deepEqual(Object.keys(valueErrors(t, ['x', '   '])), ['1']);
    assert.deepEqual(Object.keys(valueErrors(t, ['a\nb', 'y'])), ['0']);
    assert.deepEqual(Object.keys(valueErrors(t, ['a     b', 'y'])), ['0']);
    assert.deepEqual(Object.keys(valueErrors(t, ['x'.repeat(1025), 'y'])), ['0']);
    assert.deepEqual(valueErrors(null, []), {});
  });
});

describe('previewing', () => {
  test('needs a sender, a sendable template, a recipient and every value; not while busy', () => {
    const t = template();
    assert.equal(canPreview(selection(), t, false), true);
    assert.equal(canPreview(selection({ senderId: '' }), t, false), false);
    assert.equal(canPreview(selection({ templateId: '' }), t, false), false);
    assert.equal(canPreview(selection({ recipientId: '' }), t, false), false);
    assert.equal(canPreview(selection({ values: [''] }), t, false), false);
    assert.equal(canPreview(selection(), template({ sendable: false }), false), false, 'an unsendable template never previews');
    assert.equal(canPreview(selection(), null, false), false);
    assert.equal(canPreview(selection(), t, true), false);
    assert.equal(canPreview(EMPTY_SELECTION, t, false), false);
  });

  test('the preview request trims the values and carries no confirmation', () => {
    assert.deepEqual(previewRequest(selection({ values: ['  Riya  '] })), { senderId: 's1', templateId: 't1', recipientId: 'r1', variables: ['Riya'] });
  });
});

describe('sending needs a fresh preview and an explicit confirmation', () => {
  test('all conditions together enable it', () => assert.equal(canSend(ready()), true));

  test('each missing condition disables it', () => {
    assert.equal(canSend(ready({ preview: null })), false);
    assert.equal(canSend(ready({ confirmed: false })), false, 'no tick, no send');
    assert.equal(canSend(ready({ busy: true })), false);
    assert.equal(canSend(ready({ previewKey: null })), false);
  });

  test('a preview made for another selection is void', () => {
    const changed = selectionKey(selection({ values: ['Someone else'] }));
    assert.equal(canSend(ready({ currentKey: changed })), false);
    for (const other of [selection({ senderId: 's2' }), selection({ templateId: 't2' }), selection({ recipientId: 'r2' })]) {
      assert.notEqual(selectionKey(other), selectionKey(selection()));
    }
    assert.equal(selectionKey(selection({ values: [' Riya '] })), selectionKey(selection()), 'trimming does not make a new message');
  });

  test('a duplicate risk must be acknowledged on top of the confirmation', () => {
    const risky = preview({ duplicateRisk: { sendId: 'x', state: 'Unknown', claimedAt: '2026-10-13T10:00:00Z' } });
    assert.equal(canSend(ready({ preview: risky })), false);
    assert.equal(canSend(ready({ preview: risky, acknowledgedDuplicate: true })), true);
  });

  test('the request carries the reviewed hash, the key, the confirmation, and the acknowledgement only when given', () => {
    const body: any = sendRequest(selection(), preview(), false);
    assert.equal(body.confirmed, true);
    assert.equal(body.previewHash, HASH);
    assert.equal(body.idempotencyKey, 'key-0123456789abcdef');
    assert.equal('acknowledgeDuplicateRisk' in body, false);
    assert.equal((sendRequest(selection(), preview(), true) as any).acknowledgeDuplicateRisk, true);
  });
});

describe('results never claim more than was reported', () => {
  test('accepted is not delivered; delivery shows only what WhatsApp reported', () => {
    assert.equal(outcomeDisplay('accepted').label, 'Accepted by WhatsApp');
    assert.notEqual(outcomeDisplay('accepted').variant, 'success');
    assert.equal(deliveryDisplay(null).label, 'No delivery report yet');
    assert.equal(deliveryDisplay('delivered').variant, 'success');
    assert.equal(deliveryDisplay('failed').variant, 'error');
  });

  test('failed, unknown and in-progress are distinct and unrecognised outcomes read as unknown', () => {
    const labels = ['failed', 'unknown', 'in_progress', 'confirmed_received', 'confirmed_not_received'].map((o) => outcomeDisplay(o).label);
    assert.equal(new Set(labels).size, labels.length);
    assert.equal(outcomeDisplay('bogus').label, 'Result unknown');
  });

  test('only an unknown send can be reconciled', () => {
    assert.equal(canReconcile(send({ outcome: 'unknown' })), true);
    for (const outcome of ['accepted', 'failed', 'in_progress', 'confirmed_received'] as const) assert.equal(canReconcile(send({ outcome })), false);
  });

  test('retry is offered only when the server says it is safe', () => {
    assert.equal(retryAdvice(send({ outcome: 'failed', retry: { safe: true, reason: 'Not sent.' } })).offer, true);
    assert.equal(retryAdvice(send({ outcome: 'unknown', retry: { safe: false, reason: 'May have been sent.' } })).offer, false);
    assert.equal(retryAdvice(send({ retry: undefined as any })).offer, false);
  });

  test('no answer at all is reported as possibly sent, not as failed; a refusal says why', () => {
    const noAnswer = { message: 'Network Error' };
    assert.equal(sendNoAnswer(noAnswer), true);
    assert.match(problemText(noAnswer), /may or may not have been sent/);
    const refused = { response: { status: 409, data: { error: { code: 'PREVIEW_CHANGED', message: 'Something changed. Nothing was sent.' } } } };
    assert.equal(sendNoAnswer(refused), false);
    assert.equal(problemText(refused), 'Something changed. Nothing was sent.');
    assert.equal(problemText({ response: { status: 500, data: {} } }), 'Something went wrong. Please try again.');
  });
});
