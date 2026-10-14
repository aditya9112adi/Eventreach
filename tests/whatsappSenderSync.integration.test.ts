import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WhatsAppSender } = require('../backend/dist/models/WhatsAppSender');
const { syncWhatsAppSenders, refreshSenderStatusIfStale } = require('../backend/dist/services/whatsappSenderSyncService');

test('sender sync uses injected Meta responses, creates disabled records, and marks missing numbers unlisted', async () => {
  const originalUpdateOne = WhatsAppSender.updateOne;
  const originalUpdateMany = WhatsAppSender.updateMany;
  const updates: any[] = [];
  let missingUpdate: any;
  WhatsAppSender.updateOne = async (...args: any[]) => { updates.push(args); return { acknowledged: true, upsertedCount: 1 }; };
  WhatsAppSender.updateMany = async (...args: any[]) => { missingUpdate = args; return { acknowledged: true, modifiedCount: 1 }; };
  try {
    const fakeMeta = {
      listPhoneNumbers: async (wabaId: string) => {
        assert.equal(wabaId, 'test-waba');
        return [{ id: 'phone-123', display_phone_number: '+91 98765 43210', verified_name: 'Test Sender', quality_rating: 'GREEN', status: 'CONNECTED' }];
      },
      getPhoneNumberStatus: async () => 'CONNECTED',
    };
    const result = await syncWhatsAppSenders(fakeMeta, 'test-waba');
    assert.deepEqual({ discovered: result.discovered, upserted: result.upserted }, { discovered: 1, upserted: 1 });
    assert.equal(updates[0][0].phoneNumberId, 'phone-123');
    assert.equal(updates[0][1].$setOnInsert.enabled, false);
    assert.deepEqual(updates[0][1].$setOnInsert.allowedAdminIds, []);
    assert.equal(missingUpdate[0].phoneNumberId.$nin[0], 'phone-123');
    assert.equal(missingUpdate[1].$set.listedInMeta, false);
  } finally {
    WhatsAppSender.updateOne = originalUpdateOne;
    WhatsAppSender.updateMany = originalUpdateMany;
  }
});

test('status freshness checks use a mocked Meta client and refresh only stale records', async () => {
  const originalUpdateOne = WhatsAppSender.updateOne;
  const writes: any[] = [];
  WhatsAppSender.updateOne = async (...args: any[]) => { writes.push(args); return { acknowledged: true }; };
  try {
    let calls = 0;
    const fakeMeta = {
      listPhoneNumbers: async () => [],
      getPhoneNumberStatus: async () => { calls += 1; return 'CONNECTED'; },
    };
    const fresh = await refreshSenderStatusIfStale({ phoneNumberId: 'phone-fresh', metaStatus: 'CONNECTED', statusCheckedAt: new Date() }, fakeMeta);
    assert.equal(fresh, 'CONNECTED');
    assert.equal(calls, 0);
    const stale = await refreshSenderStatusIfStale({ phoneNumberId: 'phone-stale', metaStatus: 'CONNECTED', statusCheckedAt: new Date(Date.now() - 16 * 60 * 1000) }, fakeMeta);
    assert.equal(stale, 'CONNECTED');
    assert.equal(calls, 1);
    assert.equal(writes.length, 1);
  } finally {
    WhatsAppSender.updateOne = originalUpdateOne;
  }
});
