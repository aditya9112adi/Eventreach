/**
 * Connecting a WhatsApp number - the page logic (pure; no browser needed) and
 * how the page and sender choices are wired.
 *
 * Run: npx tsx --test frontend/src/utils/embeddedSignup.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  assignmentNote,
  codeFromLoginResponse,
  decideSignupOutcome,
  embeddedSignupLoginOptions,
  isMetaOrigin,
  isValidPin,
  onboardingErrorMessage,
  parseSignupMessage,
  senderStatusDisplay,
} from './embeddedSignup.ts';
import { senderChoices } from './eventContactDisplay.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const msg = (event: string, data: Record<string, unknown> = {}, origin = 'https://www.facebook.com') => ({ origin, data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data }) });

describe("the popup's messages", () => {
  test('only Meta\'s own https origin is listened to', () => {
    assert.equal(isMetaOrigin('https://www.facebook.com'), true);
    assert.equal(isMetaOrigin('https://facebook.com'), true);
    assert.equal(isMetaOrigin('https://business.facebook.com'), true);
    for (const bad of ['http://www.facebook.com', 'https://facebook.com.evil.example', 'https://evilfacebook.com', 'https://example.com', null, 42, 'not a url']) {
      assert.equal(isMetaOrigin(bad), false, String(bad));
    }
  });

  test('FINISH with a number is a finish; ids must look like Meta ids', () => {
    assert.deepEqual(parseSignupMessage(msg('FINISH', { phone_number_id: '106540352242922', waba_id: '524126980791429', business_id: '2729063490586005' })), {
      type: 'finish', wabaId: '524126980791429', phoneNumberId: '106540352242922', businessId: '2729063490586005',
    });
    assert.deepEqual(parseSignupMessage(msg('FINISH', { phone_number_id: 'abc', waba_id: '524126980791429' })), { type: 'finish_without_number', wabaId: '524126980791429' });
    assert.deepEqual(parseSignupMessage(msg('FINISH_ONLY_WABA', { waba_id: '524126980791429' })), { type: 'finish_without_number', wabaId: '524126980791429' });
    assert.deepEqual(parseSignupMessage(msg('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', { waba_id: '524126980791429' })), { type: 'coexistence', wabaId: '524126980791429' }, 'a WhatsApp Business app number is its own (unsupported) case');
  });

  test('CANCEL and ERROR are recognised; anything else, from anywhere else, or malformed, is ignored', () => {
    assert.deepEqual(parseSignupMessage(msg('CANCEL', { current_step: 'PHONE_NUMBER_SETUP' })), { type: 'cancel', currentStep: 'PHONE_NUMBER_SETUP' });
    assert.deepEqual(parseSignupMessage(msg('ERROR', { error_id: '524126', error_message: '<b>x</b>' })), { type: 'error', errorId: '524126' });
    assert.equal(parseSignupMessage(msg('FINISH', { phone_number_id: '106540352242922', waba_id: '524126980791429' }, 'https://evil.example')), null);
    assert.equal(parseSignupMessage({ origin: 'https://www.facebook.com', data: '{not json' }), null);
    assert.equal(parseSignupMessage({ origin: 'https://www.facebook.com', data: JSON.stringify({ type: 'OTHER', event: 'FINISH' }) }), null);
    assert.equal(parseSignupMessage(msg('SOMETHING_NEW')), null);
  });
});

describe('deciding what to tell the server', () => {
  const finish = { type: 'finish' as const, wabaId: '524126980791429', phoneNumberId: '106540352242922', businessId: null };

  test('completion needs BOTH the code and a FINISH with a number', () => {
    assert.deepEqual(decideSignupOutcome('the-code', finish), { kind: 'complete', body: { code: 'the-code', wabaId: '524126980791429', phoneNumberId: '106540352242922' } });
    assert.deepEqual(decideSignupOutcome(null, finish), { kind: 'cancel', body: {} }, 'no code (window closed, permission refused) is never a success');
    assert.deepEqual(decideSignupOutcome('the-code', null), { kind: 'cancel', body: {} }, 'a code without the popup\'s FINISH is not a success either');
  });

  test('cancel, error and finishing without a number each have their own outcome', () => {
    assert.deepEqual(decideSignupOutcome(null, { type: 'cancel', currentStep: 'WABA_SETUP' }), { kind: 'cancel', body: { currentStep: 'WABA_SETUP' } });
    assert.deepEqual(decideSignupOutcome('the-code', { type: 'error', errorId: '42' }), { kind: 'error', body: { errorId: '42' } });
    assert.deepEqual(decideSignupOutcome('the-code', { type: 'finish_without_number', wabaId: null }), { kind: 'no_number' });
    assert.deepEqual(decideSignupOutcome('the-code', { type: 'coexistence', wabaId: '524126980791429' }), { kind: 'coexistence_unsupported' }, 'never a success, even with a code');
  });

  test('the code is read from FB.login\'s response only when present and well-formed', () => {
    assert.equal(codeFromLoginResponse({ authResponse: { code: 'abc123' } }), 'abc123');
    for (const bad of [null, {}, { authResponse: null }, { authResponse: { code: '' } }, { authResponse: { code: 'has space' } }, { authResponse: { accessToken: 'x' } }]) {
      assert.equal(codeFromLoginResponse(bad), null, JSON.stringify(bad));
    }
  });

  test('FB.login is asked for a code with the configuration id - only public values', () => {
    const options = embeddedSignupLoginOptions('737373737373737');
    assert.equal(options.config_id, '737373737373737');
    assert.equal(options.response_type, 'code');
    assert.equal(options.override_default_response_type, true);
    // Embedded Signup v4: the configuration selects the version; Meta's v4 sample passes only setup.
    assert.deepEqual(options.extras, { setup: {} });
  });
});

describe('what the page shows', () => {
  test('every server status has its own label; an unknown one is unknown', () => {
    const labels = ['pending_registration', 'registering', 'connected', 'action_required', 'disconnected'].map((s) => senderStatusDisplay(s).label);
    assert.equal(new Set(labels).size, labels.length);
    assert.equal(senderStatusDisplay('connected').tone, 'success');
    assert.equal(senderStatusDisplay('something').label, 'Status unknown');
    assert.equal(senderStatusDisplay(null).label, 'Status unknown');
  });

  test('assignment availability is the server\'s answer, with its reason', () => {
    assert.equal(assignmentNote({ assignment: { available: true, reasons: [] } }), 'Available for your events.');
    assert.equal(assignmentNote({ assignment: { available: false, reasons: ['A Super Admin has not enabled this number for events yet.'] } }), 'A Super Admin has not enabled this number for events yet.');
    assert.equal(assignmentNote({}), 'Not available for events yet.');
  });

  test('a PIN is exactly six digits', () => {
    assert.equal(isValidPin('123456'), true);
    for (const bad of ['12345', '1234567', 'abcdef', '12 456', '']) assert.equal(isValidPin(bad), false, bad);
  });

  test('errors say nothing was connected when the server did not answer', () => {
    assert.match(onboardingErrorMessage({ message: 'Network Error' }), /Nothing was connected/);
    assert.equal(onboardingErrorMessage({ response: { status: 409, data: { error: { message: 'This number is connected to another EventReach account.' } } } }), 'This number is connected to another EventReach account.');
  });
});

describe('sender choices for an event', () => {
  const base = { displayPhoneNumber: '+91 98000 00001', verifiedName: 'Biz', listedInMeta: true };

  test('a connected number with a reason is listed disabled, with the reason; inventory behaviour is unchanged', () => {
    const choices = senderChoices([
      { _id: 'inv', ...base, enabled: true, metaStatus: 'CONNECTED' },
      { _id: 'own-ok', ...base, enabled: true, metaStatus: 'CONNECTED', source: 'embedded_signup', unavailableReasons: [] },
      { _id: 'own-pending', ...base, enabled: false, metaStatus: 'PENDING', source: 'embedded_signup', unavailableReasons: ['This number has not finished registration with WhatsApp yet.'] },
      { _id: 'inv-off', ...base, enabled: false, metaStatus: 'CONNECTED' },
    ], null);
    const by = Object.fromEntries(choices.map((c) => [c.value, c]));
    assert.equal(by.inv.available, true);
    assert.equal(by['own-ok'].available, true);
    assert.equal(by['own-pending'].available, false);
    assert.match(by['own-pending'].label, /unavailable: This number has not finished registration/);
    assert.equal(by['inv-off'], undefined, 'an unavailable inventory sender stays hidden, as before');
  });
});

describe('wiring', () => {
  const page = read('frontend/src/pages/WhatsApp/ConnectWhatsApp.tsx');
  const sdk = read('frontend/src/services/facebookSdk.ts');
  const app = read('frontend/src/App.tsx');
  const layout = read('frontend/src/layouts/DashboardLayout.tsx');
  const contact = read('frontend/src/components/ui/EventContactSettings.tsx');

  test('the route and menu are for Admins and Super Admins', () => {
    assert.ok(app.includes("<Route path=\"/whatsapp/connect\" element={<PageWrapper><RoleRoute allow={['SuperAdmin', 'Admin']}><ConnectWhatsApp /></RoleRoute></PageWrapper>} />"));
    assert.ok(layout.includes("navItems.push({ name: 'My WhatsApp Number', to: '/whatsapp/connect', icon: Smartphone });"));
  });

  test('the SDK loads only on demand, from Meta\'s URL, with public values', () => {
    assert.ok(sdk.includes("const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';"));
    assert.equal(/secret|token/i.test(sdk.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'no secret or token in the SDK loader');
  });

  test('the page starts a server session, listens only through parseSignupMessage, and forwards the result - it never decides success itself', () => {
    assert.ok(page.includes('await api.post(`${ONBOARDING_API}/sessions`)'));
    assert.ok(page.includes('const message = parseSignupMessage(event);'));
    assert.ok(page.includes("window.removeEventListener('message', onMessage)"));
    assert.ok(page.includes('decideSignupOutcome(code, lastMessage.current)'));
    assert.ok(page.includes('/complete`, outcome.body)'));
    assert.equal(/localStorage|sessionStorage/.test(page), false, 'nothing about the connection is kept in the browser');
    assert.equal(/access_token|accessToken|app_secret/.test(page), false);
  });

  test('the PIN is a password field, sent once, and cleared after the attempt', () => {
    assert.ok(page.includes('type="password"'));
    assert.ok(page.includes("setPins((p) => ({ ...p, [sender.id]: '' }));"));
  });

  test('the event contact panel disables unavailable connected numbers rather than hiding them', () => {
    assert.ok(contact.includes('disabled={!c.available && c.value !== contact.localWhatsAppSenderId}'));
  });
});
