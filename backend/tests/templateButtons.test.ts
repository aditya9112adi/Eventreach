/**
 * Template buttons: the rules (from Meta's documented BUTTONS component) and
 * the payload built from them.
 *
 * Pure unit tests of the shared validator and the payload builder - nothing
 * here reaches the network.
 *
 * Run: npx tsx --test backend/tests/templateButtons.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplateDraft, buildMetaCreatePayload } from '../src/services/templateDefinition';

const base = (buttons?: unknown) => ({
  displayName: 'Invitation',
  name: 'invitation_buttons',
  language: 'en',
  category: 'MARKETING',
  body: 'You are invited. Please reply.',
  variables: [],
  ...(buttons === undefined ? {} : { buttons }),
});

const check = (buttons?: unknown) => validateTemplateDraft(base(buttons));
const fieldsOf = (buttons: unknown) => check(buttons).errors.map((e) => e.field);
const messageFor = (buttons: unknown, field: string) => check(buttons).errors.find((e) => e.field === field)?.message ?? '';

const QR = (text = 'Yes') => ({ type: 'QUICK_REPLY', text });
const LINK = (url = 'https://example.com/rsvp', text = 'RSVP') => ({ type: 'URL', text, url });
const CALL = (phoneNumber = '+919876543210', text = 'Call us') => ({ type: 'PHONE_NUMBER', text, phoneNumber });

test('no buttons is valid, and the same as an empty list', () => {
  for (const buttons of [undefined, null, []]) {
    const { value, errors } = check(buttons);
    assert.deepEqual(errors, []);
    assert.deepEqual(value?.buttons, []);
  }
});

test('each supported type is accepted as entered', () => {
  const { value, errors } = check([QR('Yes'), QR('No')]);
  assert.deepEqual(errors, []);
  assert.deepEqual(value?.buttons, [QR('Yes'), QR('No')]);
  assert.deepEqual(check([LINK()]).value?.buttons, [LINK()]);
  assert.deepEqual(check([CALL()]).value?.buttons, [CALL()]);
});

test('a phone number is stored in one canonical form', () => {
  assert.equal(check([CALL('+91 98765-43210')]).value?.buttons[0].phoneNumber, '+919876543210');
  assert.equal(check([CALL('+1 (415) 555-0132')]).value?.buttons[0].phoneNumber, '+14155550132');
});

test('quick replies and the other types form two groups, in either order', () => {
  assert.deepEqual(check([QR(), QR('No'), LINK(), CALL()]).errors, []);
  assert.deepEqual(check([LINK(), CALL(), QR(), QR('No')]).errors, []);
  assert.deepEqual(check([LINK(), QR(), QR('No')]).errors, []);
  assert.deepEqual(fieldsOf([QR(), LINK(), QR('No')]), ['buttons'], 'a link between two quick replies makes three groups');
  assert.match(messageFor([QR(), LINK(), QR('No')], 'buttons'), /together/);
});

test('type limits: 2 links, 1 phone number, 10 buttons in all', () => {
  assert.deepEqual(check([LINK('https://a.example.com'), LINK('https://b.example.com')]).errors, []);
  assert.match(messageFor([LINK('https://a.example.com'), LINK('https://b.example.com'), LINK('https://c.example.com')], 'buttons'), /at most 2 link/);
  assert.match(messageFor([CALL(), CALL('+919876543211', 'Call again')], 'buttons'), /at most 1 phone/);
  const ten = Array.from({ length: 10 }, (_, i) => QR(`Reply ${i}`));
  assert.deepEqual(check(ten).errors, []);
  assert.match(messageFor([...ten, QR('One more')], 'buttons'), /at most 10 buttons/);
});

test('text: required, 25 characters at most, no line breaks, no placeholders', () => {
  assert.deepEqual(fieldsOf([QR('')]), ['buttons[0].text']);
  assert.deepEqual(fieldsOf([QR('x'.repeat(25))]), []);
  assert.deepEqual(fieldsOf([QR('x'.repeat(26))]), ['buttons[0].text']);
  assert.deepEqual(fieldsOf([QR('Yes\nplease')]), ['buttons[0].text']);
  assert.deepEqual(fieldsOf([QR('Hi {{1}}')]), ['buttons[0].text']);
});

test('a link must be a complete, fixed https address', () => {
  assert.deepEqual(fieldsOf([LINK('')]), ['buttons[0].url']);
  for (const bad of ['example.com/rsvp', '/rsvp', 'not a url', 'https://exa mple.com']) assert.deepEqual(fieldsOf([LINK(bad)]), ['buttons[0].url'], bad);
  assert.match(messageFor([LINK('http://example.com')], 'buttons[0].url'), /https/);
  assert.match(messageFor([LINK('https://user:pw@example.com')], 'buttons[0].url'), /user name or password/);
  assert.match(messageFor([LINK(`https://example.com/${'a'.repeat(2000)}`)], 'buttons[0].url'), /at most 2000/);
});

test('a link with a variable is refused by name: sending it needs a parameter this app does not build', () => {
  assert.match(messageFor([LINK('https://example.com/rsvp?code={{1}}')], 'buttons[0].url'), /variable is not supported/);
});

test('a phone number must be international: + and 7 to 15 digits', () => {
  assert.deepEqual(fieldsOf([CALL('')]), ['buttons[0].phoneNumber']);
  for (const bad of ['9876543210', '+0123456789', '+12', '+1234567890123456', 'call me', '+91 98765 abc']) assert.deepEqual(fieldsOf([CALL(bad)]), ['buttons[0].phoneNumber'], bad);
});

test('unsupported types are named, never silently dropped', () => {
  assert.match(messageFor([{ type: 'COPY_CODE', text: 'Copy' }], 'buttons[0].type'), /Copy-code buttons are not supported/);
  assert.match(messageFor([{ type: 'FLOW', text: 'Open' }], 'buttons[0].type'), /Choose Quick reply, Link or Phone number/);
  assert.deepEqual(fieldsOf([{ text: 'No type' }]), ['buttons[0].type']);
});

test('a malformed list is refused', () => {
  for (const bad of ['yes', 5, { type: 'URL' }]) assert.deepEqual(fieldsOf(bad), ['buttons'], String(bad));
});

test('every problem is reported at once, each against its own button', () => {
  const fields = fieldsOf([QR(''), LINK('http://x.example.com'), CALL('123')]);
  assert.deepEqual(fields.sort(), ['buttons[0].text', 'buttons[1].url', 'buttons[2].phoneNumber'].sort());
});

test('Meta payload: one BUTTONS component after the footer, with Meta\'s documented field names', () => {
  const { value } = validateTemplateDraft({ ...base([QR('Yes'), LINK(), CALL()]), footer: 'EventReach' });
  const payload: any = buildMetaCreatePayload(value!);
  assert.deepEqual(payload.components.map((c: any) => c.type), ['BODY', 'FOOTER', 'BUTTONS']);
  const buttons = payload.components[2];
  assert.deepEqual(Object.keys(buttons).sort(), ['buttons', 'type']);
  assert.deepEqual(buttons.buttons, [
    { type: 'QUICK_REPLY', text: 'Yes' },
    { type: 'URL', text: 'RSVP', url: 'https://example.com/rsvp' },
    { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919876543210' },
  ]);
  // A fixed link carries no example; Meta asks for one only when the URL has a variable.
  for (const b of buttons.buttons) assert.equal('example' in b, false);
});

test('Meta payload: no BUTTONS component when there are none, and the rest is unchanged', () => {
  const payload: any = buildMetaCreatePayload(check()!.value!);
  assert.deepEqual(payload.components.map((c: any) => c.type), ['BODY']);
  assert.equal(payload.allow_category_change, false);
});

test('buttons do not change what is refused elsewhere: media headers and named placeholders still are', () => {
  const withBoth = validateTemplateDraft({ ...base([QR()]), headerFormat: 'IMAGE', parameter_format: 'NAMED' });
  assert.deepEqual(withBoth.errors.map((e) => e.field).sort(), ['headerFormat', 'parameter_format']);
});
