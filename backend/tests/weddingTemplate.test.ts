/**
 * pranjali_ankit_wedding_invite: an approved MARKETING template ("en", no
 * header, no buttons), sent exactly as approved - nothing is filled in, no
 * guest name - so no body parameters are sent.
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
  buildEventTemplateVariables,
  resolveEventTemplate,
} from '../src/services/eventTemplateMessage';
import { countPlaceholders, selectTemplate } from '../src/services/whatsappTemplateCatalog';
import { buildTemplatePayload, validateTemplateMessage } from '../src/services/whatsappTemplateService';

const NAME = 'pranjali_ankit_wedding_invite';
const GUEST = 'Riya Sharma';

/** A mocked catalog entry: Meta's shape, with an invented body. */
const mockMetaTemplate = (body: string, extra: Record<string, unknown> = {}) => ({
  name: NAME,
  language: 'en',
  status: 'APPROVED',
  category: 'MARKETING',
  id: '1129562792755797',
  components: [{ type: 'BODY', text: body }],
  ...extra,
});

test('the wedding template is registered for the Composer, filling nothing', async (t) => {
  await t.test('resolves by name, in "en", with no declared header', () => {
    const { name, spec } = resolveEventTemplate(NAME);
    assert.equal(name, NAME);
    assert.equal(spec.languageCode, 'en');
    assert.equal(spec.headerFormat, undefined);
  });

  await t.test('fills no values - no guest name, no event field', () => {
    assert.deepEqual([...EVENT_TEMPLATES[NAME].fields], []);
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

test('nothing is personalised, for any event or guest', async (t) => {
  const events = [
    { eventName: 'Wedding', eventDate: new Date('2027-01-30T00:00:00.000Z'), eventVenue: 'The Aryavart Escapes, Nhavi, Pune' },
    { eventName: 'Corporate Gala', eventDate: new Date('2026-12-05T00:00:00.000Z'), eventVenue: 'Mumbai' },
    {},
  ];

  await t.test('no values are built, whoever the guest is', () => {
    for (const event of events) {
      for (const fullName of [GUEST, '', undefined]) {
        assert.deepEqual(buildEventTemplateVariables(NAME, event, { fullName }), []);
      }
    }
  });
});

test('the message Meta would receive', async (t) => {
  const payload: any = buildTemplatePayload(
    validateTemplateMessage({ to: '+919876543210', templateName: NAME, languageCode: 'en', variables: [] })
  );

  await t.test('is the approved template by name, in "en"', () => {
    assert.equal(payload.type, 'template');
    assert.equal(payload.to, '+919876543210');
    assert.equal(payload.template.name, NAME);
    assert.deepEqual(payload.template.language, { code: 'en' });
    assert.equal(payload.text, undefined, 'never free-form text');
  });

  await t.test('has no components at all: no body parameters, no header, no buttons', () => {
    assert.equal(payload.template.components, undefined);
    assert.deepEqual(Object.keys(payload.template).sort(), ['language', 'name']);
  });
});

test('placeholders are counted whether numbered or named', async (t) => {
  await t.test('named placeholders count, each name once', () => {
    assert.equal(countPlaceholders('Dear {{guest_name}}, welcome.'), 1);
    assert.equal(countPlaceholders('{{ guest_name }} and {{guest_name}} again'), 1);
    assert.equal(countPlaceholders('{{guest_name}} on {{event_date}}'), 2);
  });

  await t.test('numbered and named together are all counted', () => {
    assert.equal(countPlaceholders('{{1}} at {{venue}}'), 2);
  });

  await t.test('numbered placeholders count as before', () => {
    assert.equal(countPlaceholders('Hi {{1}}, {{2}} on {{3}} at {{4}}, {{5}}'), 5);
    assert.equal(countPlaceholders('{{1}} and {{1}} again'), 1);
    assert.equal(countPlaceholders('{{01}} and {{1}}'), 1);
    assert.equal(countPlaceholders('no placeholders here'), 0);
  });

  await t.test('text that is not a placeholder is not counted', () => {
    assert.equal(countPlaceholders('braces { like } these, {single}, {{}} and {{two words}}'), 0);
  });
});

test('the approved definition, as the catalog reads it (mocked Meta answer)', async (t) => {
  const fills = EVENT_TEMPLATES[NAME].fields.length;

  await t.test('a body with no placeholders matches: nothing to fill, nothing filled', () => {
    const definition = selectTemplate([mockMetaTemplate('You are warmly invited. [mocked body for the test]')], NAME, 'en');
    assert.ok(definition);
    assert.equal(definition.languageCode, 'en');
    assert.equal(definition.status, 'APPROVED');
    assert.equal(definition.header, null);
    assert.equal(definition.placeholderCount, fills);
  });

  await t.test('a body taking a value - numbered or named - does not match, so sending is blocked', () => {
    for (const body of ['Dear {{1}}, you are invited. [mock]', 'Dear {{guest_name}}, you are invited. [mock]', '{{1}} and {{2}} [mock]']) {
      const definition = selectTemplate([mockMetaTemplate(body)], NAME, 'en');
      assert.ok(definition);
      assert.notEqual(definition.placeholderCount, fills, body);
    }
  });

  await t.test('the "en" version is the one checked when another language also exists', () => {
    const definition = selectTemplate(
      [mockMetaTemplate('Hola {{1}} [mock]', { language: 'es' }), mockMetaTemplate('Invited. [mock]')],
      NAME,
      'en'
    );
    assert.equal(definition?.languageCode, 'en');
    assert.equal(definition?.placeholderCount, 0);
  });
});
