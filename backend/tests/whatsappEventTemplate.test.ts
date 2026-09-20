/**
 * Single-guest template send from the Campaign Composer.
 *
 * These are pure unit tests: the variable builder and the template-catalog
 * lookup, with Meta's HTTP call injected. Nothing here reaches the network, so
 * no real WhatsApp message can ever be sent by running the test suite. The
 * route's authorization and duplicate-send behaviour are covered separately by
 * an HTTP-level test against the compiled backend.
 *
 * Run: npx tsx --test backend/tests/whatsappEventTemplate.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TEMPLATES,
  EventTemplateError,
  buildEventTemplateVariables,
  formatEventDate,
  formatEventTime,
  resolveEventTemplate,
} from '../src/services/eventTemplateMessage';
import {
  countPlaceholders,
  selectTemplate,
  fetchTemplateDefinition,
  clearTemplateCatalogCache,
  type CatalogHttpGet,
} from '../src/services/whatsappTemplateCatalog';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** A Date holding the given IST wall-clock time, the way events are stored. */
const ist = (iso: string) => new Date(new Date(`${iso}Z`).getTime() - IST_OFFSET_MS);

const EVENT = {
  eventName: 'Wedding',
  eventDate: new Date('2026-09-25T00:00:00.000Z'),
  eventTime: ist('2026-09-25T19:00:00.000'),
  eventVenue: 'Grand Palace, Pune',
};
const CONTACT = { fullName: 'Aditya', phoneNumber: '9876543210' };

/** assert.throws() does not hand back the error, and these assert on its fields. */
const thrown = (fn: () => unknown): EventTemplateError => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof EventTemplateError, `expected an EventTemplateError, got ${error}`);
    return error as EventTemplateError;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, it returned normally' });
};

test('template allowlist', async (t) => {
  await t.test('event_reminder maps the five approved variables in order', () => {
    assert.deepEqual(EVENT_TEMPLATES.event_reminder.fields, [
      'recipientName',
      'eventName',
      'eventDate',
      'eventTime',
      'eventVenue',
    ]);
    assert.equal(EVENT_TEMPLATES.event_reminder.languageCode, 'en');
  });

  await t.test('an approved template that is not listed cannot be sent from this page', () => {
    const error = thrown(() => resolveEventTemplate('some_other_template'));
    assert.equal(error.code, 'UNKNOWN_TEMPLATE');
    assert.equal(error.httpStatus, 400);
  });

  await t.test('a missing template name is a validation error', () => {
    const error = thrown(() => resolveEventTemplate(''));
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.field, 'templateName');
  });

  await t.test('surrounding whitespace in the name is tolerated', () => {
    assert.equal(resolveEventTemplate('  event_reminder  ').name, 'event_reminder');
  });
});

test('date and time formatting', async (t) => {
  await t.test('the stored calendar date is read in UTC, not shifted into IST', () => {
    // 25 Sep at UTC midnight: an IST shift would print the 25th as well, but
    // a *negative* shift would print the 24th. Assert the day is preserved.
    assert.equal(formatEventDate(new Date('2026-09-25T00:00:00.000Z')), '25 September 2026');
    assert.equal(formatEventDate(new Date('2026-01-01T00:00:00.000Z')), '1 January 2026');
  });

  await t.test('a legacy YYYY-MM-DD string still formats', () => {
    assert.equal(formatEventDate('2026-09-25'), '25 September 2026');
  });

  await t.test('the event time is the IST wall clock, in 12-hour form', () => {
    assert.equal(formatEventTime(ist('2026-09-25T19:00:00.000')), '7:00 PM');
    assert.equal(formatEventTime(ist('2026-09-25T09:05:00.000')), '9:05 AM');
  });

  await t.test('midnight and noon are not confused', () => {
    assert.equal(formatEventTime(ist('2026-09-25T00:00:00.000')), '12:00 AM');
    assert.equal(formatEventTime(ist('2026-09-25T12:00:00.000')), '12:00 PM');
  });

  await t.test('a legacy HH:MM string still formats', () => {
    assert.equal(formatEventTime('19:30'), '7:30 PM');
    assert.equal(formatEventTime('00:15'), '12:15 AM');
  });

  await t.test('unusable values format to empty rather than "Invalid Date"', () => {
    assert.equal(formatEventDate(undefined), '');
    assert.equal(formatEventTime(null), '');
    assert.equal(formatEventDate(new Date('nonsense')), '');
  });
});

test('building the variables', async (t) => {
  await t.test('fills {{1}}…{{5}} from the event and the guest', () => {
    assert.deepEqual(buildEventTemplateVariables('event_reminder', EVENT, CONTACT), [
      { index: 1, field: 'recipientName', value: 'Aditya' },
      { index: 2, field: 'eventName', value: 'Wedding' },
      { index: 3, field: 'eventDate', value: '25 September 2026' },
      { index: 4, field: 'eventTime', value: '7:00 PM' },
      { index: 5, field: 'eventVenue', value: 'Grand Palace, Pune' },
    ]);
  });

  await t.test('collapses whitespace Meta would reject with error 132018', () => {
    const variables = buildEventTemplateVariables(
      'event_reminder',
      { ...EVENT, eventVenue: 'Grand\nPalace\t—   \n  Pune' },
      { ...CONTACT, fullName: '  Aditya    Kshirsagar  ' }
    );
    assert.equal(variables[0].value, 'Aditya Kshirsagar');
    assert.equal(variables[4].value, 'Grand Palace — Pune');
    for (const variable of variables) {
      assert.ok(!/[\n\r\t]/.test(variable.value), `${variable.field} still has a line break or tab`);
      assert.ok(!/ {5,}/.test(variable.value), `${variable.field} still has a long run of spaces`);
    }
  });

  await t.test('a missing venue is refused before anything is sent', () => {
    const error = thrown(() =>
      buildEventTemplateVariables('event_reminder', { ...EVENT, eventVenue: '   ' }, CONTACT)
    );
    assert.equal(error.code, 'INCOMPLETE_EVENT_DATA');
    assert.equal(error.field, 'eventVenue');
    assert.equal(error.httpStatus, 400);
  });

  await t.test('a guest with no name is refused', () => {
    const error = thrown(() => buildEventTemplateVariables('event_reminder', EVENT, { fullName: '' }));
    assert.equal(error.field, 'recipientName');
  });

  await t.test('the error body carries a code and a message, and nothing else', () => {
    const body = new EventTemplateError('ACCESS_DENIED', 'Access denied.', 403).toResponse();
    assert.deepEqual(body, { success: false, error: { code: 'ACCESS_DENIED', message: 'Access denied.' } });
  });
});

test('reading the approved body from Meta', async (t) => {
  const META_LIST = [
    {
      name: 'event_reminder',
      language: 'en',
      status: 'APPROVED',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, {{2}} is on {{3}} at {{4}}. Venue: {{5}}.' },
        { type: 'FOOTER', text: 'EventReach' },
      ],
    },
    { name: 'event_reminder', language: 'hi', status: 'APPROVED', components: [{ type: 'BODY', text: 'नमस्ते {{1}}' }] },
  ];

  await t.test('counts distinct placeholders', () => {
    assert.equal(countPlaceholders('Hi {{1}}, {{2}} on {{3}} at {{4}}, {{5}}'), 5);
    assert.equal(countPlaceholders('{{1}} and {{1}} again'), 1);
    assert.equal(countPlaceholders('no placeholders here'), 0);
  });

  await t.test('picks the requested language', () => {
    const definition = selectTemplate(META_LIST, 'event_reminder', 'en');
    assert.equal(definition?.languageCode, 'en');
    assert.equal(definition?.status, 'APPROVED');
    assert.equal(definition?.placeholderCount, 5);
    assert.match(definition!.bodyText, /^Hi \{\{1\}\}/);
  });

  await t.test('falls back to the same base language (en_US for en)', () => {
    const list = [{ ...META_LIST[0], language: 'en_US' }];
    assert.equal(selectTemplate(list, 'event_reminder', 'en')?.languageCode, 'en_US');
  });

  await t.test('returns null when the template has no body component', () => {
    const list = [{ name: 'event_reminder', language: 'en', status: 'APPROVED', components: [{ type: 'FOOTER', text: 'x' }] }];
    assert.equal(selectTemplate(list, 'event_reminder', 'en'), null);
  });

  await t.test('is skipped entirely when WHATSAPP_WABA_ID is not configured', async () => {
    clearTemplateCatalogCache();
    let called = false;
    const get: CatalogHttpGet = async () => {
      called = true;
      return { data: {} };
    };
    const definition = await fetchTemplateDefinition('event_reminder', 'en', {
      get,
      config: { accessToken: 'secret-token', phoneNumberId: '1', apiVersion: 'v22.0' },
    });
    assert.equal(definition, null);
    assert.equal(called, false, 'no request should be made without a WABA id');
  });

  await t.test('sends the token only in the Authorization header', async () => {
    clearTemplateCatalogCache();
    let seenUrl = '';
    let seenOptions: any = null;
    const get: CatalogHttpGet = async (url, options) => {
      seenUrl = url;
      seenOptions = options;
      return { data: { data: META_LIST } };
    };
    const definition = await fetchTemplateDefinition('event_reminder', 'en', {
      get,
      config: { accessToken: 'secret-token', phoneNumberId: '1', apiVersion: 'v22.0', wabaId: 'W1' },
    });
    assert.equal(definition?.placeholderCount, 5);
    assert.equal(seenUrl, 'https://graph.facebook.com/v22.0/W1/message_templates');
    assert.ok(!seenUrl.includes('secret-token'), 'token must never appear in the URL');
    assert.equal(seenOptions.headers.Authorization, 'Bearer secret-token');
    assert.equal(JSON.stringify(seenOptions.params).includes('secret-token'), false);
  });

  await t.test('caches, so a preview redraw does not re-query Meta', async () => {
    clearTemplateCatalogCache();
    let calls = 0;
    const get: CatalogHttpGet = async () => {
      calls += 1;
      return { data: { data: META_LIST } };
    };
    const config = { accessToken: 't', phoneNumberId: '1', apiVersion: 'v22.0', wabaId: 'W1' };
    await fetchTemplateDefinition('event_reminder', 'en', { get, config });
    await fetchTemplateDefinition('event_reminder', 'en', { get, config });
    assert.equal(calls, 1);
  });

  await t.test('a refusal from Meta degrades to null instead of throwing', async () => {
    clearTemplateCatalogCache();
    const get: CatalogHttpGet = async () => {
      throw Object.assign(new Error('Request failed'), {
        response: { data: { error: { code: 200, message: 'Permission denied' } } },
      });
    };
    const definition = await fetchTemplateDefinition('event_reminder', 'en', {
      get,
      config: { accessToken: 't', phoneNumberId: '1', apiVersion: 'v22.0', wabaId: 'W1' },
    });
    assert.equal(definition, null);
  });
});
