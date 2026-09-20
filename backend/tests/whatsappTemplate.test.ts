/**
 * WhatsApp template sending — unit tests.
 *
 * Meta is ALWAYS mocked: every test injects a fake `post`, so nothing here can
 * send a real WhatsApp message or read a real token. The token used is a fake
 * sentinel, checked for in every output to prove it never leaks.
 *
 * Run: npx tsx --test tests/whatsappTemplate.test.ts   (from backend/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendTemplateMessage,
  validateTemplateMessage,
  buildTemplatePayload,
  readTemplateConfig,
  WhatsAppTemplateError,
  type TemplateConfig,
  type TemplateHttpPost,
} from '../src/services/whatsappTemplateService';
import { WhatsAppSendError } from '../src/services/WhatsAppService';
import { buildTestTemplateHandler, toTemplateInput } from '../src/controllers/whatsappController';

const FAKE_TOKEN = 'EAAG-FAKE-SENTINEL-TOKEN-never-real-7f3a9c';
const CONFIG: TemplateConfig = { accessToken: FAKE_TOKEN, phoneNumberId: '1407379562449786', apiVersion: 'v22.0' };

const EVENT_REMINDER = {
  to: '+919876543210',
  templateName: 'event_reminder',
  languageCode: 'en',
  variables: ['Aditya', 'Wedding Ceremony', '25 September 2026', '7:00 PM', 'Grand Palace, Pune'],
};

const META_OK = {
  messaging_product: 'whatsapp',
  contacts: [{ input: '+919876543210', wa_id: '919876543210' }],
  messages: [{ id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSQTest', message_status: 'accepted' }],
};

/** A fake Meta that records what it was sent. */
const fakeMeta = (reply: { data?: any; error?: any } = { data: META_OK }) => {
  const calls: { url: string; body: any; options: any }[] = [];
  const post: TemplateHttpPost = async (url, body, options) => {
    calls.push({ url, body, options });
    if (reply.error) throw reply.error;
    return { data: reply.data };
  };
  return { post, calls };
};

/** What axios throws for a Meta 4xx — including the request config with the token in it. */
const axiosMetaError = (status: number, error: any) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    config: { headers: { Authorization: `Bearer ${FAKE_TOKEN}` }, data: '{}' },
    request: { _header: `POST /v22.0/x/messages\r\nAuthorization: Bearer ${FAKE_TOKEN}` },
    response: { status, data: { error } },
  });

const expectTemplateError = async (promise: Promise<unknown>, category: string, field?: string) => {
  await assert.rejects(promise, (err: any) => {
    assert.ok(err instanceof WhatsAppTemplateError, `expected WhatsAppTemplateError, got ${err?.name}`);
    assert.equal(err.category, category);
    if (field) assert.equal(err.field, field);
    return true;
  });
};

/** Captures console output so tests can prove the token is never logged. */
const captureConsole = async <T>(fn: () => Promise<T>) => {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const record = (...args: any[]) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = console.error = console.warn = console.info = record;
  try {
    return { result: await fn().catch((e) => e), lines };
  } finally {
    Object.assign(console, orig);
  }
};

// ═══ 1. valid payload ════════════════════════════════════════════════════════

test('1. a valid template request is sent to the Cloud API messages endpoint', async () => {
  const meta = fakeMeta();
  await sendTemplateMessage(EVENT_REMINDER, { post: meta.post, config: CONFIG });

  assert.equal(meta.calls.length, 1);
  const { url, body, options } = meta.calls[0];
  assert.equal(url, 'https://graph.facebook.com/v22.0/1407379562449786/messages');
  assert.deepEqual(body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '+919876543210',
    type: 'template',
    template: {
      name: 'event_reminder',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Aditya' },
            { type: 'text', text: 'Wedding Ceremony' },
            { type: 'text', text: '25 September 2026' },
            { type: 'text', text: '7:00 PM' },
            { type: 'text', text: 'Grand Palace, Pune' },
          ],
        },
      ],
    },
  });
  assert.equal(options.headers.Authorization, `Bearer ${FAKE_TOKEN}`, 'token is sent to Meta, and only there');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.ok(options.timeout > 0, 'request has a timeout');
});

test('the API version comes from WHATSAPP_API_VERSION, defaulting to v22.0 like the existing service', () => {
  assert.equal(readTemplateConfig({}).apiVersion, 'v22.0');
  assert.equal(readTemplateConfig({ WHATSAPP_API_VERSION: 'v23.0' }).apiVersion, 'v23.0');
  assert.equal(readTemplateConfig({ WHATSAPP_TOKEN: '  ' }).accessToken, undefined, 'blank counts as missing');
  assert.equal(readTemplateConfig({ WHATSAPP_TOKEN: 'x', WHATSAPP_PHONE_ID: '123' }).phoneNumberId, '123', 'reuses the existing WhatsApp variables');
});

test('a template with no variables sends no components', () => {
  const payload = buildTemplatePayload({ to: '+919876543210', templateName: 'hello_world', languageCode: 'en_US', variables: [] });
  assert.equal('components' in payload.template, false);
});

// ═══ phone numbers ═══════════════════════════════════════════════════════════

test('phone numbers become E.164 without truncation', async (t) => {
  const cases: [string, string][] = [
    ['9876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    [' +91 98765 43210 ', '+919876543210'],
  ];
  for (const [input, expected] of cases) {
    await t.test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(validateTemplateMessage({ ...EVENT_REMINDER, to: input }).to, expected);
    });
  }
});

// ═══ 2–5. validation ═════════════════════════════════════════════════════════

test('2. missing recipient is rejected before anything is sent', async () => {
  for (const to of [undefined, null, '', '   ']) {
    const meta = fakeMeta();
    await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, to }, { post: meta.post, config: CONFIG }), 'VALIDATION_ERROR', 'to');
    assert.equal(meta.calls.length, 0);
  }
});

test('3. invalid recipients are rejected with a clear error', async () => {
  for (const to of ['12345', 'abcdefghij', '+14155552671', '+9198765432', '0000000000', 12345, '98765432101']) {
    const meta = fakeMeta();
    await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, to }, { post: meta.post, config: CONFIG }), 'VALIDATION_ERROR', 'to');
    assert.equal(meta.calls.length, 0, `nothing sent for ${JSON.stringify(to)}`);
  }
});

test('4. missing or malformed template name / language is rejected', async () => {
  await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, templateName: undefined }, { post: fakeMeta().post, config: CONFIG }), 'VALIDATION_ERROR', 'templateName');
  await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, templateName: '  ' }, { post: fakeMeta().post, config: CONFIG }), 'VALIDATION_ERROR', 'templateName');
  await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, templateName: 'Event Reminder!' }, { post: fakeMeta().post, config: CONFIG }), 'VALIDATION_ERROR', 'templateName');
  await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, languageCode: '' }, { post: fakeMeta().post, config: CONFIG }), 'VALIDATION_ERROR', 'languageCode');
  await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, languageCode: 'english' }, { post: fakeMeta().post, config: CONFIG }), 'VALIDATION_ERROR', 'languageCode');
  assert.equal(validateTemplateMessage({ ...EVENT_REMINDER, languageCode: 'en_US' }).languageCode, 'en_US');
});

test('5. missing, empty or malformed variables are rejected', async () => {
  const bad: [unknown, string][] = [
    [undefined, 'variables'],
    ['Aditya', 'variables'],
    [['Aditya', '', 'x', 'y', 'z'], 'variables[1]'],
    [['Aditya', '   ', 'x', 'y', 'z'], 'variables[1]'],
    [['Aditya', 42, 'x', 'y', 'z'], 'variables[1]'],
    [['Aditya', 'Line\nbreak', 'x', 'y', 'z'], 'variables[1]'],
    [['Aditya', 'Tab\there', 'x', 'y', 'z'], 'variables[1]'],
    [['Aditya', 'too      many spaces', 'x', 'y', 'z'], 'variables[1]'],
    [['x'.repeat(1025)], 'variables[0]'],
  ];
  for (const [variables, field] of bad) {
    const meta = fakeMeta();
    await expectTemplateError(sendTemplateMessage({ ...EVENT_REMINDER, variables }, { post: meta.post, config: CONFIG }), 'VALIDATION_ERROR', field);
    assert.equal(meta.calls.length, 0);
  }
});

test('5b. the endpoint names the missing event_reminder field', () => {
  const body = { to: '+919876543210', templateName: 'event_reminder', recipientName: 'Aditya', eventName: 'Wedding', eventDate: '25 September 2026', eventTime: '7:00 PM' };
  assert.throws(() => toTemplateInput(body), (err: any) => err.category === 'VALIDATION_ERROR' && err.field === 'eventVenue');
  assert.throws(() => toTemplateInput({ ...body, eventVenue: '  ' }), (err: any) => err.field === 'eventVenue');
});

// ═══ 6. ordering ═════════════════════════════════════════════════════════════

test('6. event_reminder fields map to {{1}}..{{5}} in the right order, whatever the body order', async () => {
  // Body keys deliberately scrambled.
  const body = { eventVenue: 'Grand Palace, Pune', eventTime: '7:00 PM', to: '9876543210', eventDate: '25 September 2026', recipientName: 'Aditya', templateName: 'event_reminder', eventName: 'Wedding Ceremony' };
  const input = toTemplateInput(body);
  assert.deepEqual(input.variables, ['Aditya', 'Wedding Ceremony', '25 September 2026', '7:00 PM', 'Grand Palace, Pune']);
  assert.equal(input.languageCode, 'en', 'language defaults to en');

  const meta = fakeMeta();
  await sendTemplateMessage(input, { post: meta.post, config: CONFIG });
  const texts = meta.calls[0].body.template.components[0].parameters.map((p: any) => p.text);
  assert.deepEqual(texts, ['Aditya', 'Wedding Ceremony', '25 September 2026', '7:00 PM', 'Grand Palace, Pune']);
});

test('6b. the service is generic: any template takes an ordered variables list', async () => {
  const input = toTemplateInput({ to: '+919876543210', templateName: 'some_future_template', languageCode: 'en_US', variables: ['first', 'second'] });
  const meta = fakeMeta();
  await sendTemplateMessage(input, { post: meta.post, config: CONFIG });
  assert.equal(meta.calls[0].body.template.name, 'some_future_template');
  assert.deepEqual(meta.calls[0].body.template.components[0].parameters.map((p: any) => p.text), ['first', 'second']);
});

// ═══ 7. success ══════════════════════════════════════════════════════════════

test('7. a successful Meta response is normalised to safe fields only', async () => {
  const result = await sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta().post, config: CONFIG });
  assert.deepEqual(result, {
    success: true,
    messageId: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSQTest',
    status: 'accepted',
    recipient: '919876543210',
  });
});

test('7b. Meta accepting without a message id is treated as a failure', async () => {
  await expectTemplateError(
    sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta({ data: { messages: [] } }).post, config: CONFIG }),
    'META_API_ERROR'
  );
});

// ═══ 8. Meta errors ══════════════════════════════════════════════════════════

test('8. Meta errors become structured, safe errors', async (t) => {
  const cases: [string, any, string, number][] = [
    ['template in review / not approved (132001)', { message: '(#132001) Template name does not exist in the translation', type: 'OAuthException', code: 132001, error_data: { messaging_product: 'whatsapp', details: 'template name (event_reminder) does not exist in en' }, fbtrace_id: 'AbC123' }, 'TEMPLATE_NOT_AVAILABLE', 422],
    ['template paused (132015)', { message: 'Template is paused', code: 132015, fbtrace_id: 'x1' }, 'TEMPLATE_NOT_AVAILABLE', 422],
    ['template disabled (132016)', { message: 'Template is disabled', code: 132016, fbtrace_id: 'x2' }, 'TEMPLATE_NOT_AVAILABLE', 422],
    ['parameter count mismatch (132000)', { message: 'Number of parameters does not match', code: 132000, fbtrace_id: 'x3' }, 'TEMPLATE_PARAMETER_ERROR', 422],
    ['recipient not on test allow-list (131030)', { message: 'Recipient phone number not in allowed list', code: 131030, fbtrace_id: 'x4' }, 'RECIPIENT_NOT_ALLOWED', 422],
    ['expired token (190)', { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'x5' }, 'AUTHENTICATION_ERROR', 502],
    ['rate limited (130429)', { message: 'Rate limit hit', code: 130429, fbtrace_id: 'x6' }, 'RATE_LIMITED', 429],
    ['anything else', { message: 'Something unexpected', code: 1, fbtrace_id: 'x7' }, 'META_API_ERROR', 502],
  ];
  for (const [name, metaError, category, httpStatus] of cases) {
    await t.test(name, async () => {
      const { result: err } = await captureConsole(() =>
        sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta({ error: axiosMetaError(400, metaError) }).post, config: CONFIG })
      );
      assert.ok(err instanceof WhatsAppTemplateError);
      assert.ok(err instanceof WhatsAppSendError, 'still a WhatsAppSendError for existing handlers');
      assert.equal(err.category, category);
      assert.equal(err.httpStatus, httpStatus);
      assert.notEqual(err.httpStatus, 401, 'never 401 — the frontend would log the Super Admin out');
      assert.equal(err.meta.code, metaError.code);
      assert.equal(err.meta.fbtraceId, metaError.fbtrace_id);
      const body = err.toResponse();
      assert.equal(body.success, false);
      assert.equal(body.error.code, category);
      assert.equal(body.error.meta.code, metaError.code);
    });
  }
});

test('8b. template not approved yet: the message explains it, including In review', async () => {
  const err: any = await sendTemplateMessage(EVENT_REMINDER, {
    post: fakeMeta({ error: axiosMetaError(404, { message: '(#132001) Template name does not exist in the translation', code: 132001, error_data: { details: 'template name (event_reminder) does not exist in en' }, fbtrace_id: 'T1' }) }).post,
    config: CONFIG,
  }).catch((e) => e);
  assert.match(err.message, /event_reminder/);
  assert.match(err.message, /In review/);
  assert.equal(err.meta.details, 'template name (event_reminder) does not exist in en');
});

test('8c. network failure / timeout with no Meta response', async () => {
  const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED', config: { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } } });
  const { result: err } = await captureConsole(() => sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta({ error: timeout }).post, config: CONFIG }));
  assert.equal(err.category, 'NETWORK_ERROR');
  assert.equal(err.httpStatus, 504);
});

// ═══ 9. missing configuration ════════════════════════════════════════════════

test('9. missing configuration is reported by name, and nothing is sent', async (t) => {
  for (const [label, config, missing] of [
    ['no token', { ...CONFIG, accessToken: undefined }, ['WHATSAPP_TOKEN']],
    ['no phone number id', { ...CONFIG, phoneNumberId: undefined }, ['WHATSAPP_PHONE_ID']],
    ['neither', { apiVersion: 'v22.0' }, ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID']],
  ] as [string, TemplateConfig, string[]][]) {
    await t.test(label, async () => {
      const meta = fakeMeta();
      const err: any = await sendTemplateMessage(EVENT_REMINDER, { post: meta.post, config }).catch((e) => e);
      assert.equal(err.category, 'CONFIGURATION_ERROR');
      assert.equal(err.httpStatus, 503);
      for (const name of missing) assert.match(err.message, new RegExp(name));
      assert.equal(meta.calls.length, 0);
    });
  }

  await t.test('reads the real environment when no config is injected', async () => {
    const saved = { t: process.env.WHATSAPP_TOKEN, p: process.env.WHATSAPP_PHONE_ID };
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_ID;
    try {
      const meta = fakeMeta();
      const err: any = await sendTemplateMessage(EVENT_REMINDER, { post: meta.post }).catch((e) => e);
      assert.equal(err.category, 'CONFIGURATION_ERROR');
      assert.equal(meta.calls.length, 0);
    } finally {
      if (saved.t !== undefined) process.env.WHATSAPP_TOKEN = saved.t;
      if (saved.p !== undefined) process.env.WHATSAPP_PHONE_ID = saved.p;
    }
  });
});

// ═══ 10. the token is never exposed ══════════════════════════════════════════

test('10. the access token never appears in results, errors, responses or logs', async (t) => {
  const outcomes: Record<string, () => Promise<unknown>> = {
    success: () => sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta().post, config: CONFIG }),
    'Meta error': () => sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta({ error: axiosMetaError(400, { message: 'Template name does not exist', code: 132001, fbtrace_id: 'Z' }) }).post, config: CONFIG }),
    'Meta error that echoes the token': () => sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta({ error: axiosMetaError(401, { message: `Invalid OAuth access token - ${FAKE_TOKEN}`, code: 190, error_data: { details: `token ${FAKE_TOKEN} rejected` }, fbtrace_id: 'Z2' }) }).post, config: CONFIG }),
    'network error carrying the request config': () => sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta({ error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', config: { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } } }) }).post, config: CONFIG }),
    'validation error': () => sendTemplateMessage({ ...EVENT_REMINDER, to: 'bad' }, { post: fakeMeta().post, config: CONFIG }),
  };

  for (const [name, run] of Object.entries(outcomes)) {
    await t.test(name, async () => {
      const { result, lines } = await captureConsole(run);
      const serialised = JSON.stringify(result, Object.getOwnPropertyNames(result ?? {}));
      assert.ok(!serialised.includes(FAKE_TOKEN), 'not in the result/error');
      if (result instanceof WhatsAppTemplateError) {
        assert.ok(!JSON.stringify(result.toResponse()).includes(FAKE_TOKEN), 'not in the API error body');
        assert.ok(!result.message.includes(FAKE_TOKEN), 'not in the error message');
        assert.ok(!(result.stack ?? '').includes(FAKE_TOKEN), 'not in the stack');
      }
      assert.ok(!lines.join('\n').includes(FAKE_TOKEN), 'not in any log line');
      assert.ok(!lines.join('\n').includes('Authorization'), 'Authorization header never logged');
    });
  }

  await t.test('a token echoed by Meta is redacted, not passed through', async () => {
    const err: any = await captureConsole(() =>
      sendTemplateMessage(EVENT_REMINDER, { post: fakeMeta({ error: axiosMetaError(401, { message: `bad token ${FAKE_TOKEN}`, code: 190, fbtrace_id: 'R' }) }).post, config: CONFIG })
    ).then((r) => r.result);
    assert.equal(err.meta.message, 'bad token [REDACTED]');
  });
});

// ═══ endpoint handler ════════════════════════════════════════════════════════

const fakeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
};

test('endpoint: success returns { success, messageId, status, recipient } only', async () => {
  const meta = fakeMeta();
  const handler = buildTestTemplateHandler((input) => sendTemplateMessage(input, { post: meta.post, config: CONFIG }));
  const res = fakeRes();
  await handler({ body: { to: '9876543210', templateName: 'event_reminder', recipientName: 'Aditya', eventName: 'Wedding Ceremony', eventDate: '25 September 2026', eventTime: '7:00 PM', eventVenue: 'Grand Palace, Pune' } } as any, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, messageId: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSQTest', status: 'accepted', recipient: '919876543210' });
  assert.equal(meta.calls[0].body.to, '+919876543210');
});

test('endpoint: validation, template and configuration errors map to safe status codes', async () => {
  const run = async (body: any, deps: any) => {
    const res = fakeRes();
    await buildTestTemplateHandler((input) => sendTemplateMessage(input, deps))({ body } as any, res);
    return res;
  };
  const good = { to: '+919876543210', templateName: 'event_reminder', recipientName: 'A', eventName: 'B', eventDate: 'C', eventTime: 'D', eventVenue: 'E' };

  const missingField = await run({ ...good, eventDate: undefined }, { post: fakeMeta().post, config: CONFIG });
  assert.equal(missingField.statusCode, 400);
  assert.equal(missingField.body.error.field, 'eventDate');

  const badPhone = await run({ ...good, to: '123' }, { post: fakeMeta().post, config: CONFIG });
  assert.equal(badPhone.statusCode, 400);
  assert.equal(badPhone.body.error.code, 'VALIDATION_ERROR');

  const inReview = await captureConsole(() => run(good, { post: fakeMeta({ error: axiosMetaError(404, { message: 'does not exist', code: 132001, fbtrace_id: 'Q' }) }).post, config: CONFIG }));
  assert.equal(inReview.result.statusCode, 422);
  assert.equal(inReview.result.body.error.code, 'TEMPLATE_NOT_AVAILABLE');
  assert.equal(inReview.result.body.error.meta.fbtraceId, 'Q');

  const noConfig = await run(good, { post: fakeMeta().post, config: { apiVersion: 'v22.0' } });
  assert.equal(noConfig.statusCode, 503);
  assert.equal(noConfig.body.error.code, 'CONFIGURATION_ERROR');

  for (const r of [missingField, badPhone, inReview.result, noConfig]) {
    assert.ok(!JSON.stringify(r.body).includes(FAKE_TOKEN));
  }
});

test('endpoint: an unexpected error returns a generic 500 with nothing from the error', async () => {
  const res = fakeRes();
  await captureConsole(() =>
    buildTestTemplateHandler(async () => { throw Object.assign(new Error(`boom ${FAKE_TOKEN}`), { config: { headers: { Authorization: FAKE_TOKEN } } }); })(
      { body: { to: '+919876543210', templateName: 'x', variables: [] } } as any,
      res
    )
  );
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to send the WhatsApp template message.' } });
});
