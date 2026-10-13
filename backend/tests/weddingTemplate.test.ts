/**
 * pranjali_ankit_wedding_invite: an approved MARKETING template ("en", no
 * header, no buttons) whose body takes one value, the guest's name ({{1}}).
 *
 * Pure unit tests: the registry entry, the variable builder, the payload Meta
 * would receive and the template-catalog lookup, with Meta's answer supplied
 * here as a MOCK. The mocked body text is invented for the test - only its
 * placeholders matter - and is never the approved wording. Nothing here
 * reaches the network.
 *
 * Run: npx tsx --test backend/tests/weddingTemplate.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TEMPLATES,
  EventTemplateError,
  buildEventTemplateVariables,
  resolveEventTemplate,
} from '../src/services/eventTemplateMessage';
import { selectTemplate } from '../src/services/whatsappTemplateCatalog';
import { buildTemplatePayload, validateTemplateMessage } from '../src/services/whatsappTemplateService';

const NAME = 'pranjali_ankit_wedding_invite';

/** A mocked catalog entry: Meta's shape, with a placeholder-only body. */
const mockMetaTemplate = (body: string, extra: Record<string, unknown> = {}) => ({
  name: NAME,
  language: 'en',
  status: 'APPROVED',
  category: 'MARKETING',
  id: '1129562792755797',
  components: [{ type: 'BODY', text: body }],
  ...extra,
});

test('the wedding template is registered for the Composer', async (t) => {
  await t.test('resolves by name, in "en", with no declared header', () => {
    const { name, spec } = resolveEventTemplate(NAME);
    assert.equal(name, NAME);
    assert.equal(spec.languageCode, 'en');
    assert.equal(spec.headerFormat, undefined);
  });

  await t.test('fills exactly one value: the guest name', () => {
    assert.deepEqual([...EVENT_TEMPLATES[NAME].fields], ['recipientName']);
  });

  await t.test('carries no event restriction: the spec holds only its language and fields', () => {
    assert.deepEqual(Object.keys(EVENT_TEMPLATES[NAME]).sort(), ['fields', 'languageCode']);
  });

  await t.test('the existing templates are unchanged', () => {
    assert.deepEqual(EVENT_TEMPLATES.event_reminder, {
      languageCode: 'en',
      fields: ['recipientName', 'eventName', 'eventDate', 'eventTime', 'eventVenue'],
    });
    assert.deepEqual(EVENT_TEMPLATES.event_document, { languageCode: 'en', fields: [], headerFormat: 'DOCUMENT' });
    assert.deepEqual(EVENT_TEMPLATES.event_image, { languageCode: 'en', fields: [], headerFormat: 'IMAGE' });
    assert.deepEqual(EVENT_TEMPLATES.event_video, { languageCode: 'en', fields: [], headerFormat: 'VIDEO' });
    assert.deepEqual(Object.keys(EVENT_TEMPLATES), ['event_reminder', 'event_document', 'event_image', 'event_video', NAME]);
  });
});

test('{{1}} is the guest name, for any event', async (t) => {
  const events = [
    { eventName: 'Wedding', eventDate: new Date('2027-01-30T00:00:00.000Z'), eventVenue: 'The Aryavart Escapes, Nhavi, Pune' },
    { eventName: 'Corporate Gala', eventDate: new Date('2026-12-05T00:00:00.000Z'), eventVenue: 'Mumbai' },
    // Only the guest name is used, so missing event fields do not matter.
    {},
  ];

  await t.test('each event gives the same single value, taken from the guest', () => {
    for (const event of events) {
      assert.deepEqual(buildEventTemplateVariables(NAME, event, { fullName: 'Riya Sharma' }), [
        { index: 1, field: 'recipientName', value: 'Riya Sharma' },
      ]);
    }
  });

  await t.test('whitespace Meta would reject is collapsed', () => {
    assert.equal(buildEventTemplateVariables(NAME, {}, { fullName: '  Riya \n\t Sharma  ' })[0].value, 'Riya Sharma');
  });

  await t.test('a guest with no name is refused, naming the field, rather than sent with a gap', () => {
    for (const fullName of ['', '   ', undefined]) {
      assert.throws(
        () => buildEventTemplateVariables(NAME, events[0], { fullName }),
        (error: unknown) =>
          error instanceof EventTemplateError && error.code === 'INCOMPLETE_EVENT_DATA' && error.field === 'recipientName'
      );
    }
  });
});

test('the message Meta would receive', async (t) => {
  const payload: any = buildTemplatePayload(
    validateTemplateMessage({ to: '+919876543210', templateName: NAME, languageCode: 'en', variables: ['Riya Sharma'] })
  );

  await t.test('is the approved template by name, in "en"', () => {
    assert.equal(payload.type, 'template');
    assert.equal(payload.template.name, NAME);
    assert.deepEqual(payload.template.language, { code: 'en' });
    assert.equal(payload.text, undefined, 'never free-form text');
  });

  await t.test('has one body component with the guest name, and no header or button component', () => {
    assert.equal(payload.template.components.length, 1);
    const [body] = payload.template.components;
    assert.equal(body.type, 'body');
    assert.equal(body.parameters.length, 1);
    assert.equal(body.parameters[0].type, 'text');
    assert.equal(body.parameters[0].text, 'Riya Sharma');
  });
});

test('the approved definition, as the catalog reads it (mocked Meta answer)', async (t) => {
  await t.test('a one-placeholder body with no header matches the one value filled', () => {
    const definition = selectTemplate([mockMetaTemplate('Dear {{1}}, [mock body].')], NAME, 'en');
    assert.ok(definition);
    assert.equal(definition.languageCode, 'en');
    assert.equal(definition.status, 'APPROVED');
    assert.equal(definition.header, null);
    assert.equal(definition.placeholderCount, EVENT_TEMPLATES[NAME].fields.length);
  });

  await t.test('a body taking a different number of values does not match', () => {
    for (const body of ['Dear {{1}}, see you on {{2}}. [mock]', 'Dear guest. [mock, no placeholder]']) {
      const definition = selectTemplate([mockMetaTemplate(body)], NAME, 'en');
      assert.ok(definition);
      assert.notEqual(definition.placeholderCount, EVENT_TEMPLATES[NAME].fields.length, body);
    }
  });

  await t.test('another language version is not taken for "en" when "en" exists', () => {
    const definition = selectTemplate(
      [mockMetaTemplate('Hola {{1}} {{2}} [mock]', { language: 'es' }), mockMetaTemplate('Dear {{1}} [mock]')],
      NAME,
      'en'
    );
    assert.equal(definition?.languageCode, 'en');
    assert.equal(definition?.placeholderCount, 1);
  });
});
