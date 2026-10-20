/**
 * The Event ID field on Create Template, as the page wires it. There is no DOM test runner in this
 * repo, so - like the other page tests - this checks the markup and wiring in the source; the rules
 * themselves (required, trimmed, shape) run for real in utils/whatsappTemplates.test.ts, and the
 * server's lookup, authorization and persistence are in tests/eventScopedTemplates.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/pages/WhatsApp/TemplateEventId.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { EVENT_BUSINESS_ID_PATTERN, EVENT_BUSINESS_ID_PLACEHOLDER, checkEventBusinessId } from '@eventreach/shared';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const editor = read('frontend/src/pages/WhatsApp/TemplateEditor.tsx');
const list = read('frontend/src/pages/WhatsApp/Templates.tsx');
const detail = read('frontend/src/pages/WhatsApp/TemplateDetail.tsx');

describe('the Event ID input', () => {
  test('is a text input labelled "Event ID" with the specified placeholder', () => {
    assert.equal(EVENT_BUSINESS_ID_PLACEHOLDER, 'Enter Event ID (e.g., EVT-0000017)');
    assert.ok(editor.includes('htmlFor="tpl-event-id">Event ID'));
    assert.ok(editor.includes('id="tpl-event-id"'));
    assert.ok(editor.includes('placeholder={EVENT_BUSINESS_ID_PLACEHOLDER}'));
    const input = editor.slice(editor.indexOf('id="tpl-event-id"') - 40, editor.indexOf('id="tpl-event-id"') + 700);
    assert.ok(input.includes('<input'), 'a text input');
    assert.equal(/type="(?!text)/.test(input.split('/>')[0]), false);
    assert.ok(input.includes('required'));
    assert.ok(input.includes('aria-required="true"'));
    assert.ok(input.includes('autoComplete="off"'));
  });

  test('is the first field of the form', () => {
    const eventField = editor.indexOf('id="tpl-event-id"');
    for (const later of ['id="tpl-display-name"', 'id="tpl-name"', 'id="tpl-language"', 'id="tpl-category"', 'id="tpl-owner"']) {
      assert.ok(eventField > 0 && eventField < editor.indexOf(later), `before ${later}`);
    }
  });

  test('is not a dropdown or an autocomplete, and the event list is no longer loaded', () => {
    assert.equal(editor.includes('id="tpl-event"'), false);
    assert.equal(editor.includes('Reusable across events'), false);
    assert.equal(editor.includes('eventOptions'), false);
    assert.equal(/<datalist|list="/.test(editor), false);
    assert.equal(editor.includes("api\n      .get('/events'"), false);
    assert.equal(editor.includes("'/events'"), false);
  });

  test('is trimmed when the field is left, and again in the payload; the error shows beneath it', () => {
    assert.ok(editor.includes('onBlur={() => form.eventId !== form.eventId.trim() && update({ eventId: form.eventId.trim() })}'));
    assert.ok(read('frontend/src/utils/whatsappTemplates.ts').includes('eventId: form.eventId.trim(),'));
    assert.ok(editor.includes('<FieldError message={errors.eventId} />'));
  });

  test('a refusal from the server (unknown, outside your scope) lands on the same field', () => {
    assert.ok(editor.includes('setErrors(problem.fieldErrors);'));
    // toApiProblem keys the API's { field, message } errors by field name, so errors.eventId is the server's sentence.
    assert.ok(read('frontend/src/utils/whatsappTemplates.ts').includes('fieldErrorMap'));
  });

  test('changing the owner no longer clears it', () => {
    assert.equal(editor.includes("update({ ownerAdminId: e.target.value, eventId: '' })"), false);
  });
});

describe('the format check is the Event model\'s own convention', () => {
  test('matches EVT- and at least six digits, and nothing else', () => {
    assert.equal(EVENT_BUSINESS_ID_PATTERN.source, '^EVT-\\d{6,}$');
    const model = read('backend/src/models/Event.ts');
    assert.ok(model.includes('match: /^EVT-\\d{6,}$/'), 'the backend model enforces the same pattern');
    assert.ok(read('backend/src/models/Counter.ts').includes('`EVT-${String(seq).padStart(6, \'0\')}`'), 'and generates ids that satisfy it');
  });

  test('trims, then accepts only a well-formed id', () => {
    assert.deepEqual(checkEventBusinessId('  EVT-0000017 '), { ok: true, value: 'EVT-0000017' });
    for (const bad of ['', '  ', 'evt-0000017', 'EVT-17', 'EVT-0000017;', 'EVT-0000017 EVT-0000018', null, undefined, 17, {}]) {
      assert.equal(checkEventBusinessId(bad).ok, false, String(bad));
    }
  });
});

describe('where templates show their event', () => {
  test('the list shows the business Event ID, and "No event" for a template made before templates were tied to events', () => {
    assert.ok(list.includes('<span className="font-mono text-xs">{t.eventId}</span>'));
    assert.ok(list.includes('>No event</span>'));
    assert.equal(list.includes('Reusable'), false);
    assert.ok(list.includes('eventName.get(t.eventObjectId)'), 'the name is looked up by the event\'s _id');
  });

  test('the detail page looks the event up by its _id and shows both the Event ID and the name', () => {
    assert.ok(detail.includes('.get(`/events/${template.eventObjectId}`)'));
    assert.ok(detail.includes('<span className="font-mono">{template.eventId}</span>'));
    assert.equal(detail.includes('Reusable across events'), false);
  });
});
