/**
 * The event contact panel: what it says about the POC and the WhatsApp sender.
 * Pure helpers, plus a check that the event page no longer shows the contact card.
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
  senderRefreshMessage,
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

describe('the event page no longer shows the Point of Contact & WhatsApp Sender card', () => {
  const detail = read('frontend/src/pages/Events/EventDetail.tsx');

  test('EventDetail neither imports nor renders it, and the component file is gone', () => {
    assert.equal(detail.includes('EventContactSettings'), false);
    assert.equal(fs.existsSync('frontend/src/components/ui/EventContactSettings.tsx'), false);
  });
});

describe('"Refresh status" on the Senders page says what really happened', () => {
  test('a refresh is reported only when Meta actually answered', () => {
    assert.deepEqual(senderRefreshMessage(200, { refreshed: true, metaStatus: 'CONNECTED' }), { type: 'success', text: 'Status refreshed from Meta: CONNECTED.' });
    assert.equal(senderRefreshMessage(200, { refreshed: true, metaStatus: null }).text, 'Status refreshed from Meta: no status reported.');
    for (const [status, data] of [[429, { refreshed: false }], [502, { refreshed: false }], [200, {}], [200, { refreshed: false }], [0, undefined]] as const) {
      const m = senderRefreshMessage(status, data);
      assert.notEqual(m.type, 'success', `${status}`);
      assert.equal(/refreshed from Meta/.test(m.text), false, `${status}`);
    }
  });

  test("the server's explanation is shown for a cooldown or a failure", () => {
    assert.deepEqual(senderRefreshMessage(429, { error: 'Checked less than a minute ago. The stored status is shown; try again in 40s.' }), { type: 'warning', text: 'Checked less than a minute ago. The stored status is shown; try again in 40s.' });
    assert.equal(senderRefreshMessage(502, { error: 'Unable to refresh sender status from Meta. The stored status was not changed.' }).type, 'error');
    assert.equal(senderRefreshMessage(0, undefined).text, 'Status refresh failed. The stored status was not changed.');
  });


  test("the legacy campaign page shows the server's reason when a send is refused", () => {
    const page = read('frontend/src/pages/Campaigns/SendPreview.tsx');
    assert.ok(page.includes("await showError((err as any)?.response?.data?.error || 'Failed to send campaign');"));
  });
});
