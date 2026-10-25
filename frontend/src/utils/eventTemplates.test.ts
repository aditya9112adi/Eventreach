/**
 * The Message tab's rules for event-specific templates (utils/eventTemplates.ts), with no browser:
 * how a choice is told apart and sent, and which choice survives a change of event.
 *
 * What the server lists and accepts is in tests/eventScopedTemplates.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/utils/eventTemplates.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TEMPLATE_KEY_PREFIX,
  describeEventTemplate,
  eventTemplateIdOf,
  eventTemplateKey,
  isEventTemplateKey,
  readEventTemplates,
  reconcileTemplateKey,
  SELECT_EVENT_FOR_TEMPLATES_TEXT,
  templatePlaceholder,
  templateRequestFields,
  type EventTemplateOption,
} from './eventTemplates.ts';

const option = (id: string, extra: Partial<EventTemplateOption> = {}): EventTemplateOption => ({
  id, name: `tpl_${id}`, displayName: `Template ${id}`, language: 'en', category: 'UTILITY', body: 'Dear {{1}}', headerText: null, footer: null, variableCount: 1, ...extra,
});
const DEFAULT = '';

describe('telling an event template from a built-in one', () => {
  test('an event template is its id under a prefix a WhatsApp template name cannot contain', () => {
    assert.equal(eventTemplateKey('abc123'), 'event-template:abc123');
    assert.equal(isEventTemplateKey('event-template:abc123'), true);
    assert.equal(eventTemplateIdOf('event-template:abc123'), 'abc123');
    assert.match(EVENT_TEMPLATE_KEY_PREFIX, /[^a-z0-9_]/, 'a real template name can never look like this');
  });

  test('a built-in template name is never read as an event template', () => {
    for (const name of ['event_reminder', 'event_document', 'pranjali_ankit_wedding_invite', '']) {
      assert.equal(isEventTemplateKey(name), false, name);
      assert.equal(eventTemplateIdOf(name), null, name);
    }
    assert.equal(isEventTemplateKey('event-template:'), false, 'the prefix alone is not a choice');
  });
});

describe('what a send or preview asks for', () => {
  test('an event template is sent by its id, and by nothing else', () => {
    assert.deepEqual(templateRequestFields(eventTemplateKey('abc123')), { templateId: 'abc123' });
    assert.equal('templateName' in templateRequestFields(eventTemplateKey('abc123')), false);
  });
});

describe('the choice after the event changes', () => {
  const eventA = [option('a1'), option('a2')];
  const eventB = [option('b1')];

  test("a template of the event now selected stays selected", () => {
    assert.equal(reconcileTemplateKey(eventTemplateKey('a2'), eventA, DEFAULT), eventTemplateKey('a2'));
  });

  test("the previous event's template is cleared when the event changes", () => {
    assert.equal(reconcileTemplateKey(eventTemplateKey('a1'), eventB, DEFAULT), DEFAULT);
  });

  test('with no event, or while the new event\'s templates have not arrived, no event template can stay selected', () => {
    assert.equal(reconcileTemplateKey(eventTemplateKey('a1'), [], DEFAULT), DEFAULT);
  });

  test('a template that is no longer in the list (unapproved since) is cleared', () => {
    assert.equal(reconcileTemplateKey(eventTemplateKey('a2'), [option('a1')], DEFAULT), DEFAULT);
  });

  test('nothing but a template of the selected event can be chosen: a built-in name or any stray value is cleared', () => {
    for (const options of [eventA, eventB, []]) {
      for (const stray of ['event_image', 'event_reminder', 'anything', 'event-template:', 'event-template:missing']) {
        assert.equal(reconcileTemplateKey(stray, options, DEFAULT), DEFAULT, stray);
      }
    }
    assert.equal(reconcileTemplateKey('', eventA, DEFAULT), DEFAULT, 'no choice stays no choice');
  });

  test('switching A -> B -> A never carries a template across', () => {
    let key = eventTemplateKey('a1');
    key = reconcileTemplateKey(key, [], DEFAULT); // A's list is dropped the moment the event changes
    key = reconcileTemplateKey(key, eventB, DEFAULT);
    assert.equal(key, DEFAULT);
    key = reconcileTemplateKey(key, eventA, DEFAULT);
    assert.equal(key, DEFAULT, 'and returning to A does not bring it back by itself');
  });
});

describe('the picker\'s wording', () => {
  test('says what to do in each state', () => {
    assert.equal(templatePlaceholder('', 'idle', 0), 'Select an event first');
    assert.equal(templatePlaceholder('e1', 'loading', 0), 'Loading templates...');
    assert.equal(templatePlaceholder('e1', 'error', 0), 'Templates could not be loaded');
    assert.equal(templatePlaceholder('e1', 'ready', 0), 'No approved templates for this event');
    assert.equal(templatePlaceholder('e1', 'ready', 3), 'Select a template');
    assert.match(SELECT_EVENT_FOR_TEMPLATES_TEXT, /Select an event/);
  });
});

describe("reading the server's answer", () => {
  test('keeps well-formed templates and reads anything else as none', () => {
    assert.deepEqual(readEventTemplates({ templates: [option('a1')] }).map((t) => t.id), ['a1']);
    for (const bad of [null, undefined, 'x', 3, {}, { templates: 'no' }, { templates: null }]) assert.deepEqual(readEventTemplates(bad), []);
    assert.deepEqual(readEventTemplates({ templates: [null, 7, { id: 1 }, option('ok')] }).map((t) => t.id), ['ok']);
  });

  test('describes the chosen template without inventing wording', () => {
    const text = describeEventTemplate(option('a1', { category: 'MARKETING', language: 'hi' }));
    assert.match(text, /Template a1/);
    assert.match(text, /Marketing template, language hi/);
    assert.match(text, /cannot be edited here/);
    assert.doesNotMatch(text, /Attach/, 'a template with no media header asks for no file');
  });

  test('says which file a media header needs, so the person knows before choosing guests', () => {
    assert.match(describeEventTemplate(option('m1', { headerFormat: 'IMAGE' })), /Attach an image to send it\.$/);
    assert.match(describeEventTemplate(option('m2', { headerFormat: 'VIDEO' })), /Attach a video to send it\.$/);
    assert.match(describeEventTemplate(option('m3', { headerFormat: 'DOCUMENT' })), /Attach a document \(PDF\) to send it\.$/);
    // The rest of the description is unchanged by it.
    assert.match(describeEventTemplate(option('m1', { headerFormat: 'IMAGE' })), /Template m1 - Utility template, language en\. Approved by WhatsApp for this event; its wording cannot be edited here\./);
  });

  test('a null, absent or unrecognised header format asks for no file', () => {
    for (const headerFormat of [null, undefined, 'TEXT', 'LOCATION', '']) {
      assert.doesNotMatch(describeEventTemplate(option('t1', { headerFormat })), /Attach/, String(headerFormat));
    }
  });

  test('the server\'s answer keeps the header format of each template, and a template without one reads as before', () => {
    const read = readEventTemplates({ templates: [option('m1', { headerFormat: 'VIDEO' }), option('p1')] });
    assert.deepEqual(read.map((t) => [t.id, t.headerFormat ?? null]), [['m1', 'VIDEO'], ['p1', null]]);
  });
});
