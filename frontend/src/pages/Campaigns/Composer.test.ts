/**
 * The Message page offers one message type: an approved WhatsApp template.
 * The free-text "Custom Message" option - its message box, attachments,
 * Save Draft and Proceed to Send - has been removed from it.
 *
 * Run: npx tsx --test frontend/src/pages/Campaigns/Composer.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const source = fs.readFileSync('frontend/src/pages/Campaigns/Composer.tsx', 'utf-8').split('\r\n').join('\n');

test('WhatsApp Template is the single message type', () => {
  assert.ok(source.includes('<span className="px-4 py-2 text-sm font-medium bg-accent text-white">WhatsApp Template</span>'));
  assert.ok(source.includes('An approved WhatsApp template, sent to the guests you select.'));
  assert.equal(source.includes("label: 'Custom Message'"), false, 'no Custom Message option');
  assert.equal(/setMessageMode|messageMode/.test(source), false, 'no mode to switch between');
});

test('the Custom Message flow is gone from the page', () => {
  for (const removed of [
    'placeholder="Type your WhatsApp message here..."',
    'Save Draft',
    'Proceed to Send',
    'Previously Shared Messages',
    "navigate(`/campaigns/send-preview",
    'onFileSelect={handleFileUpload}',
  ]) {
    assert.equal(source.includes(removed), false, removed);
  }
});

test('the template flow is unchanged: template, guests, header file, preview and send', () => {
  assert.ok(source.includes('{TEMPLATES.map((template) => ('));
  assert.ok(source.includes('<GuestMultiSelect'));
  assert.ok(source.includes('onFileSelect={handleHeaderUpload}'));
  assert.ok(source.includes(".get('/whatsapp/event-template-preview', {"));
  assert.ok(source.includes("const response = await api.post('/whatsapp/event-template', {"));
  assert.ok(source.includes('onClick={handleSendTemplate}'));
  // Guests and the preview load as soon as an event is chosen.
  assert.ok(source.includes('    if (!selectedEventId) {\n      setIsContactsLoading(false);'));
  assert.ok(source.includes('    if (!selectedEventId || !previewContactId) {'));
});

test('the page heading stays "Message"', () => {
  assert.ok(source.includes('uppercase tracking-wider">Message</h2>'));
});
