/**
 * The event contact panel: what it says about the POC and the WhatsApp sender.
 * Pure helpers, plus how EventContactSettings and EventDetail use them.
 *
 * Run: npx tsx --test frontend/src/utils/eventContactDisplay.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  isStatusFresh,
  pocSourceLabel,
  senderChoices,
  senderSourceLabel,
  senderStatusNote,
  SENDER_STATUS_FRESHNESS_MS,
  type EffectiveSender,
} from './eventContactDisplay.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const now = new Date().toISOString();
const sender = (overrides: Partial<EffectiveSender> = {}): EffectiveSender => ({
  displayPhoneNumber: '+91 91124 72833', verifiedName: 'EventReach', metaStatus: 'CONNECTED',
  enabled: true, listedInMeta: true, statusCheckedAt: now, statusFresh: true, ...overrides,
});

describe('where the POC and sender come from', () => {
  test('local, inherited and default are told apart', () => {
    assert.equal(senderSourceLabel('event'), 'Assigned to this event');
    assert.equal(senderSourceLabel('main-event'), 'Inherited from the Main Event');
    assert.equal(senderSourceLabel('environment'), 'Default environment sender');
    assert.equal(pocSourceLabel('event'), 'Set on this event');
    assert.equal(pocSourceLabel('main-event'), 'Inherited from the Main Event');
    assert.equal(pocSourceLabel('none'), '');
  });
});

describe('the sender status never overstates what is known', () => {
  test('connected only when CONNECTED was confirmed recently', () => {
    assert.deepEqual(senderStatusNote(sender(), 'event', true), { tone: 'ok', text: 'Connected', checkedAt: now });
  });

  test('stale, unknown, disabled, unlisted and other statuses are warnings, not "connected"', () => {
    const stale = senderStatusNote(sender({ statusFresh: false }), 'event', true);
    assert.equal(stale.tone, 'warning');
    assert.match(stale.text, /not verified in the last 15 minutes/);
    assert.equal(senderStatusNote(sender({ metaStatus: null }), 'event', true).text, 'Status unknown.');
    assert.equal(senderStatusNote(sender({ enabled: false }), 'event', true).text, 'Disabled in the sender inventory.');
    assert.equal(senderStatusNote(sender({ listedInMeta: false }), 'main-event', true).text, "Not listed in Meta's latest sync.");
    assert.equal(senderStatusNote(sender({ metaStatus: 'DISCONNECTED' }), 'event', true).text, 'Meta status: DISCONNECTED.');
    for (const s of [sender({ statusFresh: false }), sender({ metaStatus: null }), sender({ enabled: false }), sender({ listedInMeta: false })]) {
      assert.notEqual(senderStatusNote(s, 'event', true).tone, 'ok');
    }
  });

  test('the environment sender needs no enabling, as it sends today', () => {
    assert.equal(senderStatusNote(sender({ enabled: false }), 'environment', true).tone, 'ok');
  });

  test('a missing environment sender is described accurately', () => {
    assert.match(senderStatusNote(null, 'environment', true).text, /has not been synced from Meta yet/);
    assert.equal(senderStatusNote(null, 'environment', false).text, 'No environment sender is configured on the server.');
    assert.match(senderStatusNote(null, 'event', true).text, /was not found in the sender inventory/);
  });

  test('the freshness window matches the server', () => {
    const t = Date.now();
    assert.equal(SENDER_STATUS_FRESHNESS_MS, 15 * 60 * 1000);
    assert.equal(isStatusFresh(new Date(t - SENDER_STATUS_FRESHNESS_MS + 1000).toISOString(), t), true);
    assert.equal(isStatusFresh(new Date(t - SENDER_STATUS_FRESHNESS_MS).toISOString(), t), false);
    assert.equal(isStatusFresh(null, t), false);
    assert.equal(isStatusFresh('not a date', t), false);
  });
});

describe('the sender dropdown', () => {
  const s = (id: string, overrides: Record<string, any> = {}) => ({ _id: id, displayPhoneNumber: `+91 ${id}`, verifiedName: `Name ${id}`, enabled: true, listedInMeta: true, metaStatus: 'CONNECTED', ...overrides });

  test('offers only assignable senders', () => {
    const choices = senderChoices([s('a'), s('b', { enabled: false }), s('c', { listedInMeta: false }), s('d', { metaStatus: 'PENDING' })], null);
    assert.deepEqual(choices.map((c) => c.value), ['a']);
  });

  test("keeps the event's current sender visible even when it can no longer be newly assigned", () => {
    const choices = senderChoices([s('a'), s('b', { enabled: false })], 'b');
    assert.deepEqual(choices.map((c) => [c.value, c.available]), [['b', false], ['a', true]]);
    assert.match(choices[0].label, /current, not available for new assignment/);
    assert.equal(senderChoices([s('a')], 'gone')[0].label, 'Current sender (not available for new assignment)');
  });
});

describe('how the panel is wired', () => {
  const panel = read('frontend/src/components/ui/EventContactSettings.tsx');
  const detail = read('frontend/src/pages/Events/EventDetail.tsx');

  test("EventDetail passes the event's own id and its Main Event's id", () => {
    assert.ok(detail.includes('<EventContactSettings eventId={String(event._id)} parentEventId={event.parentEventId ? String(event.parentEventId) : null} />'));
  });

  test('every viewer sees the effective values; only Admins and Super Admins see editing controls', () => {
    assert.ok(panel.includes("const canEdit = user?.role === 'SuperAdmin' || user?.role === 'Admin';"));
    assert.ok(panel.includes('{canEdit && <div'));
    assert.ok(panel.includes("api.get(`/events/${eventId}/contact`)"));
  });

  test('the status note and source labels come from the tested helpers', () => {
    assert.ok(panel.includes('senderStatusNote(contact.effectiveSender, contact.assignmentSource, Boolean(contact.environmentSenderConfigured))'));
    assert.ok(panel.includes('senderSourceLabel(contact.assignmentSource)'));
    assert.ok(panel.includes('senderChoices(senders, contact.localWhatsAppSenderId)'));
    assert.equal(panel.includes("'Environment sender'"), false, 'no generic placeholder in place of the real sender');
  });

  test('clearing the POC or the sender sends null, restoring inheritance', () => {
    assert.ok(panel.includes('whatsappSenderId: senderId || null,'));
    assert.ok(/poc: name\.trim\(\) \? \{[\s\S]*?\} : null,/.test(panel));
  });
});
