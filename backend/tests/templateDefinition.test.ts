/**
 * WhatsApp template definitions, the Meta adapter and variable resolution -
 * unit tests. Pure: no database. Meta is ALWAYS mocked through injected
 * `post`/`get`, and the token is a fake sentinel checked for in every output.
 *
 * Run: npx tsx --test tests/templateDefinition.test.ts   (from backend/)
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanPlaceholders,
  validateTemplateDraft,
  buildMetaCreatePayload,
  mapMetaStatus,
  isTemplateSendable,
  type TemplateDraftInput,
} from '../src/services/templateDefinition';
import { resolveTemplateVariables, GUEST_NAME_FALLBACK } from '../src/services/templateVariables';
import { createMetaTemplate, findMetaTemplatesByName, getMetaTemplateById, MetaTemplateApiError } from '../src/services/metaTemplateApi';
import { describeWhatsAppConnection } from '../src/services/whatsappConnection';
import { EventTemplateError } from '../src/services/eventTemplateMessage';

const FAKE_TOKEN = 'EAAG-FAKE-SENTINEL-TOKEN-never-real-7f3a9c';
const CONNECTION = { accessToken: FAKE_TOKEN, wabaId: '102290129340398', phoneNumberId: '1407379562449786', apiVersion: 'v22.0' };

const WEDDING_BODY =
  'Dear {{1}},\n\nWith joy, we invite you to the wedding of Pranjali & Ankit on 30th & 31st January 2027 ' +
  'at The Aryavart Escapes, Nhavi, Pune.\n\nWith love,\nKavita Sanjeev Maheshwari & Family';

const valid = (overrides: Partial<TemplateDraftInput> = {}): TemplateDraftInput => ({
  displayName: 'Wedding invitation',
  name: 'pranjali_ankit_invite',
  language: 'en',
  category: 'MARKETING',
  body: WEDDING_BODY,
  variables: [{ position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' }],
  ...overrides,
});

const fieldsOf = (input: TemplateDraftInput) => validateTemplateDraft(input).errors.map((e) => e.field);

describe('placeholders', () => {
  test('numbered from 1 in order of appearance', () => {
    assert.deepEqual(scanPlaceholders('Hi {{1}}, see you at {{2}} on {{3}}.'), { positions: [1, 2, 3], error: null });
    assert.deepEqual(scanPlaceholders('No placeholders'), { positions: [], error: null });
  });

  for (const [label, text, pattern] of [
    ['a gap', 'Hi {{1}} at {{3}}', /no gaps/],
    ['out of order', 'Hi {{2}} at {{1}}', /in the order they appear/],
    ['not starting at 1', 'Hi {{2}}', /from \{\{1\}\}/],
    ['repeated', 'Hi {{1}}, yes {{1}}', /only once/],
    ['spaces inside', 'Hi {{ 1 }}', /Named|malformed/],
    ['named', 'Hi {{first_name}}', /Named placeholders/],
    ['unclosed', 'Hi {{1', /malformed/],
    ['stray closing braces', 'Hi }} there', /malformed/],
  ] as const) {
    test(`rejects ${label}`, () => {
      assert.match(scanPlaceholders(text).error ?? '', pattern);
    });
  }
});

describe('template validation', () => {
  test('the wedding invitation: fixed text with only the guest name dynamic', () => {
    const { value, errors } = validateTemplateDraft(valid());
    assert.deepEqual(errors, []);
    assert.equal(value!.body, WEDDING_BODY);
    assert.deepEqual(value!.variables, [{ position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' }]);
    assert.equal(value!.allowCategoryChange, false, 'Meta may not recategorize unless asked');
  });

  test('every problem is reported at once, each against its field', () => {
    const fields = fieldsOf({ displayName: '', name: 'Bad Name', language: 'english', category: 'PROMO', body: '' });
    for (const f of ['displayName', 'name', 'language', 'category', 'body']) assert.ok(fields.includes(f), f);
  });

  test("Meta's documented limits: header 60, body 1024, footer 60", () => {
    assert.ok(fieldsOf(valid({ headerText: 'x'.repeat(61) })).includes('headerText'));
    assert.ok(fieldsOf(valid({ body: 'x'.repeat(1025), variables: [] })).includes('body'));
    assert.ok(fieldsOf(valid({ footer: 'x'.repeat(61) })).includes('footer'));
    assert.deepEqual(fieldsOf(valid({ headerText: 'x'.repeat(60), footer: 'y'.repeat(60) })), []);
  });

  test('no placeholders in the header or footer', () => {
    assert.ok(fieldsOf(valid({ headerText: 'For {{1}}' })).includes('headerText'));
    assert.ok(fieldsOf(valid({ footer: 'Reply {{1}}' })).includes('footer'));
  });

  test('category changes are not offered: true is refused, false or absent is fine', () => {
    assert.ok(fieldsOf(valid({ allowCategoryChange: true })).includes('allowCategoryChange'));
    assert.ok(fieldsOf(valid({ allowCategoryChange: 'yes' })).includes('allowCategoryChange'));
    assert.deepEqual(fieldsOf(valid({ allowCategoryChange: false })), []);
    const { value } = validateTemplateDraft(valid());
    assert.equal(buildMetaCreatePayload({ ...value!, allowCategoryChange: true }).allow_category_change, false, 'never sent as true');
  });

  test('Authentication templates are refused with a reason', () => {
    const { errors } = validateTemplateDraft(valid({ category: 'AUTHENTICATION' }));
    assert.match(errors.find((e) => e.field === 'category')!.message, /one-time-password/);
  });

  test('every placeholder needs a mapping, a name and an example value', () => {
    const body = 'Dear {{1}}, join us at {{2}}.';
    assert.ok(fieldsOf(valid({ body, variables: [{ position: 1, label: 'Guest', source: 'guest.name', sample: 'Riya' }] })).includes('variables.2'));
    assert.ok(fieldsOf(valid({ body, variables: [
      { position: 1, label: '', source: 'guest.name', sample: 'Riya' },
      { position: 2, label: 'Venue', source: 'event.venue', sample: '' },
    ] })).includes('variables.2.sample'));
    assert.ok(fieldsOf(valid({ body: 'Dear {{1}}.', variables: [
      { position: 1, label: 'Guest', source: 'guest.name', sample: 'Riya' },
      { position: 2, label: 'Extra', source: 'event.venue', sample: 'Pune' },
    ] })).includes('variables'), 'a mapping for a placeholder not in the body');
  });

  test('a fixed value needs its text, and values follow Meta parameter rules', () => {
    assert.ok(fieldsOf(valid({ variables: [{ position: 1, label: 'Couple', source: 'fixed', sample: 'Pranjali & Ankit' }] })).includes('variables.1.fixedValue'));
    assert.ok(fieldsOf(valid({ variables: [{ position: 1, label: 'Guest', source: 'guest.name', sample: 'Riya\nSharma' }] })).includes('variables.1.sample'));
    assert.ok(fieldsOf(valid({ variables: [{ position: 1, label: 'Guest', source: 'nowhere', sample: 'Riya' }] })).includes('variables.1.source'));
  });

  test('a mapping cannot take its value from the request', () => {
    // There is no "request" source: values come only from the event and guest.
    assert.ok(fieldsOf(valid({ variables: [{ position: 1, label: 'Guest', source: 'request.body', sample: 'Riya' }] })).includes('variables.1.source'));
  });
});

describe('Meta create payload', () => {
  test('positional body with examples in placeholder order, plus header and footer', () => {
    const { value } = validateTemplateDraft(valid({
      headerText: 'You are invited',
      footer: 'Reply STOP to opt out',
      body: 'Dear {{1}}, see you at {{2}}.',
      variables: [
        { position: 2, label: 'Venue', source: 'event.venue', sample: 'Pune' },
        { position: 1, label: 'Guest', source: 'guest.name', sample: 'Riya' },
      ],
    }));
    assert.deepEqual(buildMetaCreatePayload(value!), {
      name: 'pranjali_ankit_invite',
      language: 'en',
      category: 'MARKETING',
      allow_category_change: false,
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'You are invited' },
        { type: 'BODY', text: 'Dear {{1}}, see you at {{2}}.', example: { body_text: [['Riya', 'Pune']] } },
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
      ],
    });
  });

  test('a body without placeholders has no example', () => {
    const { value } = validateTemplateDraft(valid({ body: 'Thank you for coming!', variables: [] }));
    assert.deepEqual(buildMetaCreatePayload(value!).components, [{ type: 'BODY', text: 'Thank you for coming!' }]);
  });
});

describe('Meta status', () => {
  test('documented statuses map to local states; anything else is Unknown', () => {
    const cases: Record<string, string> = {
      APPROVED: 'Approved', PENDING: 'Pending', IN_APPEAL: 'Pending', REJECTED: 'Rejected', LIMIT_EXCEEDED: 'Paused',
      PAUSED: 'Paused', DISABLED: 'Disabled', ARCHIVED: 'Archived', PENDING_DELETION: 'Deleted', DELETED: 'Deleted',
    };
    for (const [meta, local] of Object.entries(cases)) assert.equal(mapMetaStatus(meta), local, meta);
    assert.equal(mapMetaStatus('SOMETHING_NEW'), 'Unknown');
    assert.equal(mapMetaStatus(null), 'Unknown');
  });

  test('only a template Meta approved is sendable', () => {
    assert.equal(isTemplateSendable({ localState: 'Approved', metaStatus: 'APPROVED' }), true);
    assert.equal(isTemplateSendable({ localState: 'Approved', metaStatus: null }), false);
    for (const localState of ['Draft', 'Pending', 'Rejected', 'Paused', 'Disabled', 'Unknown', 'Submitting']) {
      assert.equal(isTemplateSendable({ localState, metaStatus: 'APPROVED' }), false, localState);
    }
  });
});

describe('variable resolution', () => {
  const event = {
    eventName: 'Wedding', eventDate: new Date('2027-01-30T00:00:00Z'), eventTime: new Date('2027-01-30T13:30:00Z'),
    eventVenue: 'The Aryavart Escapes, Nhavi, Pune', eventType: 'Wedding', organizerName: 'Kavita Maheshwari', eventDescription: '',
  };
  const mapping = [
    { position: 1, label: 'Guest name', source: 'guest.name' as const },
    { position: 2, label: 'Date', source: 'event.date' as const },
    { position: 3, label: 'Time', source: 'event.time' as const },
    { position: 4, label: 'Venue', source: 'event.venue' as const },
    { position: 5, label: 'Host', source: 'event.organizer' as const },
    { position: 6, label: 'Couple', source: 'fixed' as const, fixedValue: 'Pranjali & Ankit' },
  ];

  test('each guest gets their own greeting, from the selected event', () => {
    const riya = resolveTemplateVariables(mapping, event, { fullName: '  Riya   Sharma ' }).map((v) => v.value);
    const arjun = resolveTemplateVariables(mapping, event, { fullName: 'Arjun' }).map((v) => v.value);
    assert.deepEqual(riya, ['Riya Sharma', '30 January 2027', '7:00 PM', 'The Aryavart Escapes, Nhavi, Pune', 'Kavita Maheshwari', 'Pranjali & Ankit']);
    assert.equal(arjun[0], 'Arjun');
    assert.deepEqual(arjun.slice(1), riya.slice(1));
  });

  test('a blank guest name becomes "Guest", so the greeting reads "Dear Guest,"', () => {
    for (const fullName of ['', '   ', undefined, null]) {
      const [first] = resolveTemplateVariables(mapping.slice(0, 1), event, { fullName });
      assert.equal(first.value, GUEST_NAME_FALLBACK);
      assert.equal(first.usedFallback, true);
      assert.equal('Dear {{1}},'.replace('{{1}}', first.value), 'Dear Guest,');
    }
  });

  test('a missing event value stops the send, naming the placeholder', () => {
    assert.throws(
      () => resolveTemplateVariables([{ position: 1, label: 'Notes', source: 'event.description' }], event, { fullName: 'Riya' }),
      (e: any) => e instanceof EventTemplateError && e.code === 'INCOMPLETE_EVENT_DATA' && /"Notes" \(\{\{1\}\}\)/.test(e.message)
    );
  });

  test('a mapping fallback fills an empty value', () => {
    const [v] = resolveTemplateVariables([{ position: 1, label: 'Notes', source: 'event.description', fallback: 'See you there' }], event, { fullName: 'Riya' });
    assert.deepEqual([v.value, v.usedFallback], ['See you there', true]);
  });

  test('values are ordered by placeholder whatever order the mapping is stored in', () => {
    const values = resolveTemplateVariables([mapping[3], mapping[0]], event, { fullName: 'Riya' }).map((v) => v.position);
    assert.deepEqual(values, [1, 4]);
  });
});

describe('Meta template API adapter (mocked)', () => {
  const noLeak = (value: unknown) => assert.equal(JSON.stringify(value).includes(FAKE_TOKEN), false, 'the token never appears');

  test('create posts to the WABA, not the phone number, with the token only in the header', async () => {
    let seen: any = null;
    const result = await createMetaTemplate({ name: 'x' }, {
      connection: CONNECTION,
      post: async (url, body, options) => {
        seen = { url, body, options };
        return { data: { id: '594425479261596', status: 'PENDING', category: 'MARKETING' } };
      },
    });
    assert.equal(seen.url, 'https://graph.facebook.com/v22.0/102290129340398/message_templates');
    assert.equal(seen.options.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
    assert.deepEqual(result, { id: '594425479261596', status: 'PENDING', category: 'MARKETING' });
  });

  test('a Meta error answer is a definite rejection, scrubbed of the token', async () => {
    const error = await createMetaTemplate({}, {
      connection: CONNECTION,
      post: async () => { throw { response: { status: 400, data: { error: { code: 100, error_subcode: 2388024, message: `Invalid parameter ${FAKE_TOKEN}`, fbtrace_id: 'Atrace' } } } }; },
    }).catch((e) => e);
    assert.ok(error instanceof MetaTemplateApiError);
    assert.equal(error.kind, 'REJECTED');
    assert.equal(error.meta.subcode, 2388024);
    noLeak({ message: error.message, meta: error.meta });
  });

  test('a timeout, no answer, a 5xx or a 2xx without an id are ambiguous', async () => {
    const kinds = [];
    for (const failure of [
      () => { throw { code: 'ECONNABORTED' }; },
      () => { throw { code: 'ECONNRESET' }; },
      () => { throw { response: { status: 503, data: { error: { code: 2, message: 'Service temporarily unavailable' } } } }; },
    ]) {
      kinds.push((await createMetaTemplate({}, { connection: CONNECTION, post: async () => failure() }).catch((e) => e)).kind);
    }
    kinds.push((await createMetaTemplate({}, { connection: CONNECTION, post: async () => ({ data: {} }) }).catch((e) => e)).kind);
    assert.deepEqual(kinds, ['AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS']);
  });

  test('credential and rate-limit errors are classified, and missing configuration never calls Meta', async () => {
    const auth = await createMetaTemplate({}, { connection: CONNECTION, post: async () => { throw { response: { status: 401, data: { error: { code: 190, message: 'Invalid OAuth access token' } } } }; } }).catch((e) => e);
    const rate = await createMetaTemplate({}, { connection: CONNECTION, post: async () => { throw { response: { status: 400, data: { error: { code: 80007, message: 'Rate limit' } } } }; } }).catch((e) => e);
    let called = false;
    const config = await createMetaTemplate({}, { connection: { ...CONNECTION, wabaId: undefined }, post: async () => { called = true; return { data: {} }; } }).catch((e) => e);
    assert.deepEqual([auth.kind, rate.kind, config.kind], ['AUTHENTICATION', 'RATE_LIMITED', 'CONFIGURATION']);
    assert.match(config.message, /WHATSAPP_WABA_ID/);
    assert.equal(called, false);
  });

  test('lookup by name returns exact name matches in every language', async () => {
    let params: any = null;
    const nodes = await findMetaTemplatesByName('event_invite', {
      connection: CONNECTION,
      get: async (_url, options) => {
        params = options.params;
        return { data: { data: [
          { id: '1', name: 'event_invite', language: 'en', status: 'PENDING', category: 'MARKETING' },
          { id: '2', name: 'event_invite', language: 'hi', status: 'APPROVED', category: 'MARKETING' },
          { id: '3', name: 'event_invite_v2', language: 'en', status: 'APPROVED', category: 'MARKETING' },
        ] } };
      },
    });
    assert.equal(params.name, 'event_invite');
    assert.deepEqual(nodes.map((n) => [n.id, n.language]), [['1', 'en'], ['2', 'hi']]);
  });
});

describe('connection status', () => {
  test('reports presence only - never a value', () => {
    const env = { WHATSAPP_TOKEN: FAKE_TOKEN, WHATSAPP_PHONE_ID: '1407379562449786', WHATSAPP_WABA_ID: '102290129340398', WHATSAPP_APP_SECRET: 'sekret', WHATSAPP_VERIFY_TOKEN: 'verify' } as any;
    const status = describeWhatsAppConnection(env);
    assert.equal(status.mode, 'live');
    assert.equal(status.phoneNumberIdHint, '…9786');
    const out = JSON.stringify(status);
    for (const secret of [FAKE_TOKEN, 'sekret', 'verify"', '1407379562449786', '102290129340398']) assert.equal(out.includes(secret), false);
  });
});

describe('shared validation', () => {
  test('the editor and the API use the same rules, from @eventreach/shared', async () => {
    const shared = await import('@eventreach/shared');
    const backend = await import('../src/services/templateDefinition');
    const sendPath = await import('../src/services/whatsappTemplateService');
    assert.equal(backend.validateTemplateDraft, shared.validateTemplateDraft);
    assert.equal(backend.scanPlaceholders, shared.scanTemplatePlaceholders);
    assert.equal(backend.LIMITS, shared.WHATSAPP_TEMPLATE_LIMITS);
    // The send path keeps its own copies; they must stay identical.
    assert.equal(shared.WHATSAPP_TEMPLATE_NAME_PATTERN.source, sendPath.TEMPLATE_NAME_PATTERN.source);
    assert.equal(shared.WHATSAPP_LANGUAGE_CODE_PATTERN.source, sendPath.LANGUAGE_CODE_PATTERN.source);
  });

  test('common languages are offered, and any valid Meta-style code is accepted', async () => {
    const { COMMON_TEMPLATE_LANGUAGES } = await import('@eventreach/shared');
    assert.deepEqual(COMMON_TEMPLATE_LANGUAGES.map((l) => l.code).slice(0, 2), ['en', 'en_US']);
    for (const code of ['hi', 'mr', 'pt_BR', 'fil']) assert.deepEqual(fieldsOf(valid({ language: code })), [], code);
    for (const code of ['english', 'EN', 'en-us', 'en_us']) assert.ok(fieldsOf(valid({ language: code })).includes('language'), code);
  });

  test('every variable source has an editor label', async () => {
    const { WHATSAPP_TEMPLATE_VARIABLE_SOURCES, WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS } = await import('@eventreach/shared');
    for (const source of WHATSAPP_TEMPLATE_VARIABLE_SOURCES) assert.ok(WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS[source], source);
  });
});

describe('Meta template status lookup (mocked)', () => {
  test('GET /{template-id} with the documented fields; token only in the header', async () => {
    let seen: any = null;
    const node = await getMetaTemplateById('594425479261596', {
      connection: CONNECTION,
      get: async (url, options) => {
        seen = { url, options };
        return { data: { id: '594425479261596', name: 'x', language: 'en', status: 'APPROVED', category: 'UTILITY', rejected_reason: 'NONE' } };
      },
    });
    assert.equal(seen.url, 'https://graph.facebook.com/v22.0/594425479261596');
    assert.deepEqual(seen.options.params, { fields: 'id,name,language,status,category,rejected_reason' });
    assert.equal(seen.options.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
    assert.deepEqual(node, { id: '594425479261596', name: 'x', language: 'en', status: 'APPROVED', category: 'UTILITY', rejectedReason: 'NONE' });
  });

  test('an id of the wrong form is never sent', async () => {
    for (const id of ['', 'abc', '../me', '1/2', '1?x=1']) {
      let called = false;
      const error = await getMetaTemplateById(id, { connection: CONNECTION, get: async () => { called = true; return { data: {} }; } }).catch((e) => e);
      assert.equal(error.kind, 'CONFIGURATION', id);
      assert.equal(called, false, id);
    }
  });

  test("Meta's documented rate-limit codes, and HTTP 401/403, are classified", async () => {
    const kindFor = async (response: any) =>
      (await getMetaTemplateById('1', { connection: CONNECTION, get: async () => { throw { response }; } }).catch((e) => e)).kind;
    for (const code of [80008, 4, 17, 613]) assert.equal(await kindFor({ status: 400, data: { error: { code } } }), 'RATE_LIMITED', String(code));
    assert.equal(await kindFor({ status: 401, data: {} }), 'AUTHENTICATION');
    assert.equal(await kindFor({ status: 403, data: {} }), 'AUTHENTICATION');
    assert.equal(await kindFor({ status: 400, data: { error: { code: 200 } } }), 'AUTHENTICATION', 'permissions error');
    assert.equal(await kindFor({ status: 400, data: { error: { code: 100 } } }), 'REJECTED', 'invalid parameter');
    assert.equal(await kindFor({ status: 503, data: {} }), 'AMBIGUOUS');
  });

  test('a malformed answer is returned with empty fields for the caller to refuse', async () => {
    const node = await getMetaTemplateById('1', { connection: CONNECTION, get: async () => ({ data: 'not json' }) });
    assert.deepEqual(node, { id: '', name: '', language: '', status: null, category: null, rejectedReason: null });
  });
});
