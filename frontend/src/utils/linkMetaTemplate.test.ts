/**
 * "Link to EventReach" for a template that already exists at WhatsApp - the rules, with no browser: who is offered the
 * action, what is refused up front, what is asked for, and exactly what is sent.
 *
 * The server's side (reading the template from WhatsApp, the account and approval checks, the atomic create, no
 * duplicate, no change at WhatsApp) is in tests/eventScopedTemplates.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/utils/linkMetaTemplate.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanTemplatePlaceholders } from '@eventreach/shared';
import {
  buildLinkRequest,
  canOfferLink,
  createSingleFlight,
  headerNote,
  initialLinkForm,
  linkBlockers,
  linkToast,
  markLinked,
  placeholderPositions,
  validateLinkForm,
  withSource,
} from './linkMetaTemplate.ts';
import type { AccountTemplateView } from './whatsappTemplates.ts';

const meta = (over: Partial<AccountTemplateView> = {}): AccountTemplateView => ({
  id: '7001', name: 'invite_text', language: 'en', status: 'APPROVED', category: 'UTILITY', rejectedReason: null,
  headerFormat: null, headerText: null, bodyText: 'Dear {{1}}, welcome to {{2}}.', footerText: null, buttons: [],
  localTemplateId: null, sendableFromHere: false, ...over,
});
const SUPER = { role: 'SuperAdmin' };

describe('who is offered "Link to EventReach"', () => {
  test('a Super Admin, for an approved template EventReach does not hold', () => {
    assert.equal(canOfferLink(meta(), SUPER), true);
  });

  test('nobody else: an Admin, a User or nobody signed in', () => {
    for (const viewer of [{ role: 'Admin' }, { role: 'User' }, {}, null, undefined]) assert.equal(canOfferLink(meta(), viewer), false, JSON.stringify(viewer));
  });

  test('not for a template EventReach already holds, nor one Meta has not approved', () => {
    assert.equal(canOfferLink(meta({ localTemplateId: 'abc' }), SUPER), false);
    for (const status of ['PENDING', 'REJECTED', 'PAUSED', 'DISABLED', null]) assert.equal(canOfferLink(meta({ status }), SUPER), false, String(status));
  });
});

describe('what is refused before anything is asked', () => {
  test('a plain text template, and one with an image, video or document header, can be linked', () => {
    assert.deepEqual(linkBlockers(meta()), []);
    for (const headerFormat of ['IMAGE', 'VIDEO', 'DOCUMENT']) assert.deepEqual(linkBlockers(meta({ headerFormat })), [], headerFormat);
    assert.deepEqual(linkBlockers(meta({ headerFormat: 'TEXT', headerText: 'You are invited' })), []);
  });

  test('authentication templates, location headers, placeholder headers and named placeholders are refused, with the reason', () => {
    assert.match(linkBlockers(meta({ category: 'AUTHENTICATION' })).join(' '), /one-time-password/);
    assert.match(linkBlockers(meta({ headerFormat: 'LOCATION' })).join(' '), /location header/);
    assert.match(linkBlockers(meta({ headerFormat: 'TEXT', headerText: 'Hello {{1}}' })).join(' '), /header with a placeholder/);
    assert.match(linkBlockers(meta({ bodyText: 'Hi {{guest_name}}.' })).join(' '), /Named placeholders are not supported yet/);
    assert.match(linkBlockers(meta({ bodyText: null })).join(' '), /no message body/);
  });

  test('a placeholder problem is reported in the shared scanner\'s own words, and the same templates are refused as before', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['repeated', 'Hi {{1}}, see you {{1}}.', /only once/],
      ['gapped', 'Hi {{1}}, {{3}}.', /no gaps/],
      ['missing {{1}}', 'Hi {{2}}.', /numbered from \{\{1\}\}/],
      ['out of order', 'Hi {{2}} and {{1}}.', /in the order they appear/],
      ['malformed', 'Hi {{ 1 }}.', /malformed/],
    ];
    for (const [name, bodyText, expected] of cases) {
      const reasons = linkBlockers(meta({ bodyText }));
      assert.equal(reasons.length, 1, name);
      assert.match(reasons[0], expected, name);
      assert.ok(reasons[0].includes(scanTemplatePlaceholders(bodyText).error as string), `${name}: says exactly what the shared scanner says`);
      assert.doesNotMatch(reasons[0], /not plain numbers/, name);
    }
  });

  test('numbered placeholders in order are not refused', () => {
    for (const bodyText of ['Hi.', 'Hi {{1}}.', 'Hi {{1}}, {{2}} and {{3}}.']) assert.deepEqual(linkBlockers(meta({ bodyText })), [], bodyText);
  });

  test('buttons EventReach cannot send are named; quick replies, links and phone buttons are fine', () => {
    assert.deepEqual(linkBlockers(meta({ buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'URL', text: 'Map' }, { type: 'PHONE_NUMBER', text: 'Call' }] })), []);
    assert.match(linkBlockers(meta({ buttons: [{ type: 'COPY_CODE', text: 'Copy' }] })).join(' '), /copy code button/);
  });
});

describe('what is asked for', () => {
  test('one row per placeholder, in order, each once - and none for a template without placeholders', () => {
    assert.deepEqual(placeholderPositions('Dear {{2}}, {{1}} and {{1}} again'), [1, 2]);
    assert.deepEqual(initialLinkForm(meta()).rows.map((r) => r.position), [1, 2]);
    assert.deepEqual(initialLinkForm(meta({ bodyText: 'Please see the invitation attached.' })).rows, []);
    assert.deepEqual(placeholderPositions(null), []);
  });

  test('choosing what fills a placeholder names it, unless the person already named it', () => {
    const row = { position: 1, label: '', source: '' as const, fixedValue: '' };
    assert.equal(withSource(row, 'guest.name').label, 'Guest name');
    assert.equal(withSource({ ...row, label: 'Invitee' }, 'guest.name').label, 'Invitee');
    assert.equal(withSource(row, '').label, '');
  });
});

describe('validation, keyed like the API so a refusal lands on the same field', () => {
  const filled = () => {
    const form = initialLinkForm(meta());
    form.eventId = 'EVT-000011';
    form.rows = form.rows.map((r, i) => ({ ...r, source: i === 0 ? 'guest.name' : 'event.name', label: i === 0 ? 'Guest name' : 'Event' }));
    return form;
  };

  test('a complete form has no problems', () => {
    assert.deepEqual(validateLinkForm(filled()), {});
  });

  test('the Event ID is required, trimmed and checked for shape; an ObjectId is not an Event ID', () => {
    assert.equal(validateLinkForm({ ...filled(), eventId: '' }).eventId, 'Event ID is required.');
    assert.deepEqual(validateLinkForm({ ...filled(), eventId: '  EVT-000011  ' }), {});
    for (const bad of ['evt-000011', 'EVT-11', '507f1f77bcf86cd799439011', 'EVT-000011 EVT-000012']) {
      assert.match(validateLinkForm({ ...filled(), eventId: bad }).eventId, /EVT- followed by at least 6 digits/, bad);
    }
  });

  test('every placeholder needs a name and a source; fixed text needs its text', () => {
    const form = filled();
    form.rows = [{ position: 1, label: '', source: '', fixedValue: '' }, { position: 2, label: 'Venue text', source: 'fixed', fixedValue: '  ' }];
    const errors = validateLinkForm(form);
    assert.equal(errors['variables.1.source'], 'Choose what fills {{1}}.');
    assert.equal(errors['variables.1.label'], 'Give {{1}} a name.');
    assert.equal(errors['variables.2.fixedValue'], 'Enter the fixed text for {{2}}.');
    assert.equal(errors['variables.2.source'], undefined);
    form.rows = [{ position: 1, label: 'x'.repeat(61), source: 'guest.name', fixedValue: '' }, form.rows[1]];
    assert.match(validateLinkForm(form)['variables.1.label'], /at most 60/);
  });
});

describe('what is sent', () => {
  test('the template, the typed Event ID and the choices - and nothing the server must decide', () => {
    const form = initialLinkForm(meta());
    form.eventId = '  EVT-000011 ';
    form.rows = [
      { position: 1, label: ' Guest name ', source: 'guest.name', fixedValue: 'ignored' },
      { position: 2, label: 'Dress code', source: 'fixed', fixedValue: ' Formal ' },
    ];
    const request = buildLinkRequest(meta(), form);
    assert.deepEqual(request, {
      metaTemplateId: '7001',
      eventId: 'EVT-000011',
      variables: [
        { position: 1, label: 'Guest name', source: 'guest.name' },
        { position: 2, label: 'Dress code', source: 'fixed', fixedValue: 'Formal' },
      ],
    });
    for (const never of ['eventObjectId', 'wabaId', 'localState', 'metaStatus', 'ownerAdminId', 'body', 'name', 'category', 'headerFormat']) {
      assert.equal(never in request, false, `${never} is never sent`);
    }
  });

  test('a template without placeholders sends an empty list', () => {
    const t = meta({ bodyText: 'Please see the invitation attached.', headerFormat: 'IMAGE' });
    const form = initialLinkForm(t);
    form.eventId = 'EVT-000011';
    assert.deepEqual(buildLinkRequest(t, form).variables, []);
  });
});

describe('after linking', () => {
  test('the row becomes available in EventReach without asking WhatsApp again, only if Meta lists it approved', () => {
    const row = markLinked(meta(), 'local-1');
    assert.equal(row.localTemplateId, 'local-1');
    assert.equal(row.sendableFromHere, true);
    assert.equal(markLinked(meta({ status: 'PAUSED' }), 'local-1').sendableFromHere, false);
    assert.equal(canOfferLink(row, SUPER), false, 'and the action is no longer offered');
  });

  test('the toast says linked, moved, or already linked', () => {
    assert.deepEqual(linkToast({ created: true, template: { name: 'invite_text', eventId: 'EVT-000011' } }), {
      type: 'success', message: 'invite_text is linked to EVT-000011. It can now be chosen in the Message tab for that event.',
    });
    assert.match(linkToast({ created: false, changed: true, template: { name: 'invite_text', eventId: 'EVT-000012' } }).message, /already in EventReach. It is now linked to EVT-000012/);
    assert.deepEqual(linkToast({ created: false, changed: false, template: { name: 'invite_text', eventId: 'EVT-000011' } }).type, 'info');
  });

  test('a media header is explained in words', () => {
    assert.match(headerNote('IMAGE') ?? '', /image header: an image is attached each time it is sent/);
    assert.match(headerNote('VIDEO') ?? '', /a video is attached/);
    assert.match(headerNote('DOCUMENT') ?? '', /a document \(PDF\) is attached/);
    assert.equal(headerNote('TEXT'), null);
    assert.equal(headerNote(null), null);
  });
});

describe('a second click while the request is still running', () => {
  const gate = () => {
    let release!: (value: string) => void;
    const promise = new Promise<string>((resolve) => { release = resolve; });
    return { promise, release };
  };

  test('rapid repeated submission makes one request, and the repeats do nothing', async () => {
    const flight = createSingleFlight();
    const { promise, release } = gate();
    let requests = 0;
    const post = () => { requests += 1; return promise; };

    // Five clicks in the same tick, before anything could re-render with "busy" set.
    const clicks = Array.from({ length: 5 }, () => flight(post));
    assert.equal(requests, 1, 'only the first click reached the server');

    release('linked');
    const results = await Promise.all(clicks);
    assert.deepEqual(results, ['linked', undefined, undefined, undefined, undefined]);
    assert.equal(requests, 1);
  });

  test('once the request has finished, the next submission is allowed', async () => {
    const flight = createSingleFlight();
    let requests = 0;
    await flight(async () => { requests += 1; });
    await flight(async () => { requests += 1; });
    assert.equal(requests, 2);
  });

  test('a request that fails does not leave the dialog locked: the person can try again', async () => {
    const flight = createSingleFlight();
    await assert.rejects(flight(async () => { throw new Error('network'); }), /network/);
    assert.equal(await flight(async () => 'second try'), 'second try');
  });

  test('a second click is ignored even while the first is waiting on a slow answer', async () => {
    const flight = createSingleFlight();
    const first = gate();
    let requests = 0;
    const one = flight(() => { requests += 1; return first.promise; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await flight(async () => { requests += 1; return 'again'; }), undefined);
    first.release('done');
    assert.equal(await one, 'done');
    assert.equal(requests, 1);
  });
});
