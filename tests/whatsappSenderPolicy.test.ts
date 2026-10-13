import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSenderStatusFresh, SENDER_STATUS_FRESHNESS_MS } from '../backend/src/services/whatsappSenderPolicy.ts';

test('sender status is fresh for less than 15 minutes', () => {
  const now = Date.now();
  assert.equal(isSenderStatusFresh(new Date(now - SENDER_STATUS_FRESHNESS_MS + 1), now), true);
  assert.equal(isSenderStatusFresh(new Date(now - SENDER_STATUS_FRESHNESS_MS - 1), now), false);
});

test('missing, invalid, or old timestamps do not count as fresh', () => {
  const now = Date.now();
  assert.equal(isSenderStatusFresh(null, now), false);
  assert.equal(isSenderStatusFresh(undefined, now), false);
  assert.equal(isSenderStatusFresh(new Date('invalid'), now), false);
  assert.equal(isSenderStatusFresh(new Date(now - 24 * 60 * 60 * 1000), now), false);
});

test('status freshness uses the exact 15-minute boundary as stale', () => {
  const now = Date.now();
  assert.equal(isSenderStatusFresh(new Date(now - SENDER_STATUS_FRESHNESS_MS), now), false);
});
