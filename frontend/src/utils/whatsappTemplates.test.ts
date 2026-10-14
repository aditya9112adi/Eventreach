/**
 * WhatsApp template management - the page logic (pure; no browser needed).
 *
 * Run: npx tsx --test frontend/src/utils/whatsappTemplates.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { WHATSAPP_TEMPLATE_STATES } from '@eventreach/shared';
import { shouldClearSession } from '../services/authErrors.ts';
import {
  EMPTY_FILTERS,
  EMPTY_FORM,
  TEMPLATE_STATE_DISPLAY,
  applyTemplateAccess,
  buildTemplatePayload,
  canSeeTemplatesPage,
  counter,
  fieldErrorMap,
  formFromTemplate,
  hasActiveFilters,
  historyLabel,
  listParams,
  listViewState,
  outcomeToast,
  parseTemplatePage,
  renderPreview,
  shouldConfirmLeaving,
  stateDisplay,
  suggestTemplateName,
  syncVariableRows,
  templateAccessControl,
  templateActions,
  toApiProblem,
  validateForm,
  type TemplateForm,
  type TemplateView,
} from './whatsappTemplates.ts';

const template = (overrides: Partial<TemplateView> = {}): TemplateView => ({
  id: 't1', ownerAdminId: 'admin-1', createdBy: 'admin-1', displayName: 'Wedding invitation', name: 'wedding_invite',
  language: 'en', category: 'MARKETING', eventId: null, headerText: null, body: 'Dear {{1}}, welcome.', footer: null,
  variables: [{ position: 1, label: 'Guest name', source: 'guest.name', sample: 'Riya' }],
  localState: 'Draft', metaTemplateId: null, metaStatus: null, metaCategory: null, rejectionReason: null, lastSyncedAt: null,
  submissionAttempts: 0, history: [], version: 1, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
  ...overrides,
});

const SUPER = { id: 'super-1', role: 'SuperAdmin', canManageWhatsAppTemplates: true };
const ADMIN = { id: 'admin-1', role: 'Admin', canManageWhatsAppTemplates: true };
const OTHER = { id: 'admin-2', role: 'Admin', canManageWhatsAppTemplates: true };

const form = (overrides: Partial<TemplateForm> = {}): TemplateForm => ({
  ...EMPTY_FORM,
  displayName: 'Wedding invitation',
  name: 'wedding_invite',
  body: 'Dear {{1}}, welcome.',
  variables: [{ position: 1, label: 'Guest name', source: 'guest.name', fixedValue: '', fallback: '', sample: 'Riya' }],
  ...overrides,
});

describe('navigation', () => {
  test('the page is shown only when the server says the account may manage templates', () => {
    assert.equal(canSeeTemplatesPage({ role: 'SuperAdmin', canManageWhatsAppTemplates: true }), true);
    assert.equal(canSeeTemplatesPage({ role: 'Admin', canManageWhatsAppTemplates: true }), true);
    assert.equal(canSeeTemplatesPage({ role: 'Admin', canManageWhatsAppTemplates: false }), false);
    assert.equal(canSeeTemplatesPage({ role: 'Admin' }), false, 'absent means no');
    assert.equal(canSeeTemplatesPage({ role: 'User', canManageWhatsAppTemplates: false }), false);
    assert.equal(canSeeTemplatesPage(null), false);
  });
});

describe('list page', () => {
  test('a list response is read defensively', () => {
    const page = parseTemplatePage({ data: [template()], pagination: { total: 41, page: 2, limit: 20, totalPages: 3 } });
    assert.equal(page.data.length, 1);
    assert.deepEqual(page.pagination, { total: 41, page: 2, limit: 20, totalPages: 3 });
    assert.deepEqual(parseTemplatePage(null), { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } });
    assert.deepEqual(parseTemplatePage({ data: 'x', pagination: { total: -1 } }).data, []);
  });

  test('only the filters that are set are sent, with the page', () => {
    assert.deepEqual(listParams(EMPTY_FILTERS, 1, 20), { page: 1, limit: 20 });
    assert.deepEqual(listParams({ q: ' haldi ', category: 'UTILITY', language: '', eventId: 'e1', state: 'Pending' }, 3, 50), {
      page: 3, limit: 50, q: 'haldi', category: 'UTILITY', eventId: 'e1', state: 'Pending',
    });
    assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
    assert.equal(hasActiveFilters({ ...EMPTY_FILTERS, language: 'hi' }), true);
  });

  test('loading, permission, configuration, error, empty and ready states', () => {
    const page = (n: number) => ({ data: Array.from({ length: n }, () => template()), pagination: { total: n, page: 1, limit: 20, totalPages: 1 } });
    const problem = (status: number | null) => toApiProblem(status === null ? { message: 'Network Error' } : { response: { status, data: {} } });
    assert.equal(listViewState({ loading: true, error: null, page: null, hasFilters: false }), 'loading');
    assert.equal(listViewState({ loading: false, error: problem(403), page: null, hasFilters: false }), 'forbidden');
    assert.equal(listViewState({ loading: false, error: problem(503), page: null, hasFilters: false }), 'notConfigured');
    assert.equal(listViewState({ loading: false, error: problem(500), page: null, hasFilters: false }), 'error');
    assert.equal(listViewState({ loading: false, error: problem(null), page: null, hasFilters: false }), 'error');
    assert.equal(listViewState({ loading: false, error: null, page: page(0), hasFilters: false }), 'empty');
    assert.equal(listViewState({ loading: false, error: null, page: page(0), hasFilters: true }), 'noMatches');
    assert.equal(listViewState({ loading: false, error: null, page: page(2), hasFilters: false }), 'ready');
    assert.equal(listViewState({ loading: true, error: null, page: page(2), hasFilters: false }), 'ready', 'a refetch keeps the table');
  });

  test('every state the backend can store has a label and badge', () => {
    for (const state of WHATSAPP_TEMPLATE_STATES) {
      assert.ok(TEMPLATE_STATE_DISPLAY[state]?.label, state);
    }
    assert.equal(stateDisplay('Approved').variant, 'success');
    assert.equal(stateDisplay('SubmissionFailed').label, 'Submission failed');
    assert.equal(stateDisplay('SOMETHING_NEW').label, 'SOMETHING_NEW', 'an unknown state is shown as it is');
    assert.equal(historyLabel('reconciled_found'), 'Found at WhatsApp');
    assert.equal(historyLabel('new_type'), 'new_type');
  });
});

describe('controls match what the API accepts', () => {
  test('Draft: edit, submit and delete; not check or refresh status', () => {
    assert.deepEqual(templateActions(ADMIN, template()), { edit: true, submit: true, checkStatus: false, refresh: false, delete: true });
  });

  test('SubmissionFailed: edit, submit again, check status; never delete (it reached WhatsApp, or might have)', () => {
    assert.deepEqual(templateActions(ADMIN, template({ localState: 'SubmissionFailed', submissionAttempts: 1 })), { edit: true, submit: true, checkStatus: true, refresh: false, delete: false });
  });

  test('Unknown: only check status', () => {
    assert.deepEqual(templateActions(ADMIN, template({ localState: 'Unknown', submissionAttempts: 1 })), { edit: false, submit: false, checkStatus: true, refresh: false, delete: false });
  });

  test('Pending: only refresh status', () => {
    assert.deepEqual(templateActions(ADMIN, template({ localState: 'Pending', submissionAttempts: 1, metaTemplateId: '9' })), { edit: false, submit: false, checkStatus: false, refresh: true, delete: false });
  });

  test('Submitting, Approved, Rejected, Paused, Disabled: nothing to do here', () => {
    for (const localState of ['Submitting', 'Approved', 'Rejected', 'Paused', 'Disabled', 'Archived', 'Deleted'] as const) {
      assert.deepEqual(templateActions(ADMIN, template({ localState, submissionAttempts: 1, metaTemplateId: '9' })), { edit: false, submit: false, checkStatus: false, refresh: false, delete: false }, localState);
    }
  });

  test('a draft that was ever submitted cannot be deleted', () => {
    assert.equal(templateActions(ADMIN, template({ submissionAttempts: 2 })).delete, false);
    assert.equal(templateActions(ADMIN, template({ metaTemplateId: '1' })).delete, false);
  });

  test("shared and other Admins' templates are read-only; a Super Admin manages all", () => {
    const none = { edit: false, submit: false, checkStatus: false, refresh: false, delete: false };
    assert.deepEqual(templateActions(ADMIN, template({ ownerAdminId: null })), none, 'shared');
    assert.deepEqual(templateActions(OTHER, template()), none, "another Admin's");
    assert.equal(templateActions(SUPER, template({ ownerAdminId: null })).edit, true);
    assert.equal(templateActions(SUPER, template()).submit, true);
    assert.equal(templateActions(ADMIN, template({ ownerAdminId: null, localState: 'Pending' })).refresh, false, 'a shared Pending template is not refreshed by an Admin');
    assert.deepEqual(templateActions(null, template()), none);
  });
});

describe('editor', () => {
  test('a row per placeholder, keeping what was typed', () => {
    const rows = form().variables.map((r) => ({ ...r, sample: 'Typed' }));
    const two = syncVariableRows('Dear {{1}}, see you at {{2}}.', rows);
    assert.equal(two.placeholderError, null);
    assert.deepEqual(two.rows.map((r) => [r.position, r.sample]), [[1, 'Typed'], [2, '']]);
    const back = syncVariableRows('Dear {{1}}.', two.rows);
    assert.deepEqual(back.rows.map((r) => r.position), [1]);
    assert.equal(back.rows[0].sample, 'Typed');
  });

  test('the first placeholder starts as the guest name', () => {
    const { rows } = syncVariableRows('Hello {{1}}', []);
    assert.deepEqual([rows[0].source, rows[0].label], ['guest.name', 'Guest name']);
  });

  test('half-typed or invalid placeholders never wipe the rows', () => {
    const rows = form().variables;
    for (const body of ['Dear {{1}} and {{', 'Dear {{2}}', 'Dear {{name}}']) {
      const result = syncVariableRows(body, rows);
      assert.equal(result.rows, rows, body);
      assert.ok(result.placeholderError, body);
    }
  });

  test('preview: examples filled in; a guest with no name reads "Dear Guest,"', () => {
    const rows = [
      { position: 1, label: 'Guest name', source: 'guest.name' as const, fixedValue: '', fallback: '', sample: 'Riya' },
      { position: 2, label: 'Couple', source: 'fixed' as const, fixedValue: 'Pranjali & Ankit', fallback: '', sample: 'x' },
      { position: 3, label: 'Venue', source: 'event.venue' as const, fixedValue: '', fallback: '', sample: '' },
    ];
    const body = 'Dear {{1}}, join {{2}} at {{3}}.';
    assert.equal(renderPreview(body, rows), 'Dear Riya, join Pranjali & Ankit at [Venue].');
    assert.equal(renderPreview('Dear {{1}},', rows, { blankGuestName: true }), 'Dear Guest,');
    const withFallback = [{ ...rows[0], fallback: 'Friend' }];
    assert.equal(renderPreview('Dear {{1}},', withFallback, { blankGuestName: true }), 'Dear Friend,', 'a set fallback wins, as on the server');
  });

  test('the payload never asks for a category change, and sends an owner only when asked', () => {
    const payload: any = buildTemplatePayload(form({ ownerAdminId: 'admin-9', headerText: '  ', footer: ' With love ' }));
    assert.equal('allowCategoryChange' in payload, false);
    assert.equal('ownerAdminId' in payload, false);
    assert.equal(payload.headerText, null);
    assert.equal(payload.footer, 'With love');
    assert.equal((buildTemplatePayload(form({ ownerAdminId: 'admin-9' }), { includeOwner: true }) as any).ownerAdminId, 'admin-9');
    assert.equal((buildTemplatePayload(form(), { includeOwner: true }) as any).ownerAdminId, null, 'shared');
  });

  test('fixed text is sent only for a fixed value; an empty fallback is left out', () => {
    const p = buildTemplatePayload(form({ variables: [{ position: 1, label: 'Guest', source: 'guest.name', fixedValue: 'ignored', fallback: ' ', sample: 'Riya' }] }));
    assert.deepEqual(p.variables[0], { position: 1, label: 'Guest', source: 'guest.name', sample: 'Riya' });
  });

  test('the shared rules run before sending, keyed like the API', () => {
    assert.deepEqual(validateForm(form()), {});
    const errors = validateForm(form({ headerText: 'For {{1}}', variables: [{ position: 1, label: '', source: '', fixedValue: '', fallback: '', sample: '' }] }));
    for (const field of ['headerText', 'variables.1.label', 'variables.1.source', 'variables.1.sample']) assert.ok(errors[field], field);
  });

  test('a stored template round-trips through the form unchanged', () => {
    const t = template({ headerText: 'You are invited', footer: 'With love', eventId: 'e1' });
    const p: any = buildTemplatePayload(formFromTemplate(t));
    assert.deepEqual([p.headerText, p.footer, p.eventId, p.body], ['You are invited', 'With love', 'e1', t.body]);
    assert.deepEqual(p.variables, t.variables);
  });

  test('template names are suggested in Meta form', () => {
    assert.equal(suggestTemplateName('Wedding Invite! 2027'), 'wedding_invite_2027');
    assert.equal(suggestTemplateName('  Haldi -- Reminder  '), 'haldi_reminder');
  });

  test('counters flag going over the limit', () => {
    assert.deepEqual(counter('x'.repeat(61), 60), { used: 61, limit: 60, over: true });
    assert.equal(counter('ok', 60).over, false);
  });
});

describe('server answers', () => {
  test('field errors from a 400 land on the matching fields', () => {
    const problem = toApiProblem({ response: { status: 400, data: { success: false, error: { code: 'VALIDATION_ERROR', message: 'The template has problems to fix.', errors: [
      { field: 'name', message: 'Bad name' },
      { field: 'variables.2.sample', message: 'Example needed' },
      { field: 'name', message: 'second message ignored' },
    ] } } } });
    assert.equal(problem.kind, 'validation');
    assert.deepEqual(problem.fieldErrors, { name: 'Bad name', 'variables.2.sample': 'Example needed' });
    assert.equal(problem.message, 'The template has problems to fix.');
    assert.deepEqual(fieldErrorMap('junk'), {});
  });

  test('each status is understood; the server message is shown when it gives one', () => {
    const kind = (status: number, data: any = {}) => toApiProblem({ response: { status, data } });
    assert.equal(kind(403).kind, 'forbidden');
    assert.equal(kind(404).kind, 'notFound');
    assert.equal(kind(409, { error: { code: 'TEMPLATE_NAME_TAKEN', message: 'Name taken', errors: [{ field: 'name', message: 'Choose another name.' }] } }).fieldErrors.name, 'Choose another name.');
    assert.equal(kind(409, { error: { code: 'ALREADY_SUBMITTED', message: 'Already submitted (Pending).' } }).message, 'Already submitted (Pending).');
    assert.equal(kind(429).kind, 'rateLimited');
    assert.equal(kind(503).kind, 'notConfigured');
    assert.equal(kind(502).kind, 'unavailable');
    assert.equal(kind(500, { error: 'Failed to change WhatsApp template access' }).message, 'Failed to change WhatsApp template access');
    assert.equal(toApiProblem({ message: 'Network Error' }).kind, 'network');
  });

  test('a 401 on a template request signs the user out (the API client handles it)', () => {
    assert.equal(shouldClearSession(401, '/whatsapp/templates'), true);
    assert.equal(shouldClearSession(403, '/whatsapp/templates'), false, 'a 403 is shown on the page instead');
  });

  test('submission outcomes', () => {
    assert.equal(outcomeToast({ outcome: 'submitted', message: 'Submitted.' }).type, 'success');
    assert.equal(outcomeToast({ outcome: 'reconciled', message: 'Found.' }).type, 'success');
    assert.equal(outcomeToast({ outcome: 'rejected', message: 'Bad.' }).type, 'error');
    assert.equal(outcomeToast({ outcome: 'uncertain', message: '?' }).type, 'warning');
    assert.equal(outcomeToast({ outcome: 'superseded', message: '?' }).type, 'warning');
    assert.equal(outcomeToast({}).type, 'info');
  });

  test('refresh outcomes: approval, rejection, still pending, other statuses, missing, superseded', () => {
    assert.deepEqual(outcomeToast({ outcome: 'approved', message: 'WhatsApp approved the template.' }), { type: 'success', message: 'WhatsApp approved the template.' });
    assert.equal(outcomeToast({ outcome: 'rejected', message: 'Rejected.' }).type, 'error');
    assert.equal(outcomeToast({ outcome: 'pending', message: 'Still pending review at WhatsApp.' }).type, 'info');
    assert.equal(outcomeToast({ outcome: 'updated', message: 'PAUSED' }).type, 'warning');
    assert.equal(outcomeToast({ outcome: 'not_found', message: 'Missing.' }).type, 'warning');
    assert.equal(outcomeToast({ outcome: 'superseded', message: 'Changed.' }).type, 'warning');
    assert.equal(historyLabel('refreshed'), 'Status checked at WhatsApp');
    assert.equal(historyLabel('refresh_not_found'), 'Not found at WhatsApp when checked');
  });

  test("refresh errors keep the server's message", () => {
    const tooSoon = toApiProblem({ response: { status: 429, data: { success: false, error: { code: 'REFRESH_TOO_SOON', message: 'The status was checked a moment ago. Try again in 25s.' } } } });
    assert.deepEqual([tooSoon.kind, tooSoon.code, tooSoon.message], ['rateLimited', 'REFRESH_TOO_SOON', 'The status was checked a moment ago. Try again in 25s.']);
    const outage = toApiProblem({ response: { status: 502, data: { success: false, error: { code: 'META_UNAVAILABLE', message: 'WhatsApp did not respond in time. The status was not changed.' } } } });
    assert.deepEqual([outage.kind, outage.code], ['unavailable', 'META_UNAVAILABLE']);
    const notConfigured = toApiProblem({ response: { status: 503, data: { success: false, error: { code: 'CONFIGURATION_ERROR', message: 'Not configured.' } } } });
    assert.equal(notConfigured.kind, 'notConfigured');
  });
});

describe('unsaved changes', () => {
  const click = (overrides: Partial<Parameters<typeof shouldConfirmLeaving>[0]> = {}) =>
    shouldConfirmLeaving({ dirty: true, button: 0, modifier: false, defaultPrevented: false, href: '/events', target: null, download: false, origin: 'https://app.example', currentPath: '/whatsapp/templates/new', ...overrides });

  test('asks before an in-app link leaves the editor with unsaved changes', () => {
    assert.equal(click(), true);
    assert.equal(click({ href: 'https://app.example/dashboard' }), true);
  });

  test('does not ask when nothing would be lost or the editor stays open', () => {
    assert.equal(click({ dirty: false }), false);
    assert.equal(click({ modifier: true }), false, 'new tab');
    assert.equal(click({ button: 1 }), false, 'middle click');
    assert.equal(click({ target: '_blank' }), false);
    assert.equal(click({ download: true }), false);
    assert.equal(click({ href: 'https://developers.facebook.com' }), false, 'leaves the app in place');
    assert.equal(click({ href: '/whatsapp/templates/new' }), false, 'same page');
    assert.equal(click({ href: null }), false);
    assert.equal(click({ defaultPrevented: true }), false);
  });
});

describe('Just Access: the permission toggle', () => {
  test('shown only to a Super Admin, only on Admin rows', () => {
    assert.equal(templateAccessControl(SUPER, { role: 'Admin' }).visible, true);
    assert.equal(templateAccessControl(SUPER, { role: 'User' }).visible, false);
    assert.equal(templateAccessControl(SUPER, { role: 'SuperAdmin' }).visible, false);
    assert.equal(templateAccessControl(ADMIN, { role: 'Admin' }).visible, false, 'an Admin never sees it');
    assert.equal(templateAccessControl(null, { role: 'Admin' }).visible, false);
  });

  test('granting needs no confirmation; revoking does', () => {
    assert.deepEqual(templateAccessControl(SUPER, { role: 'Admin' }), { visible: true, granted: false, next: 'grant', needsConfirm: false });
    assert.deepEqual(templateAccessControl(SUPER, { role: 'Admin', canManageWhatsAppTemplates: true }), { visible: true, granted: true, next: 'revoke', needsConfirm: true });
  });

  test("only the API's answer changes a row", () => {
    const records = [{ _id: 'a1', role: 'Admin' }, { _id: 'a2', role: 'Admin', canManageWhatsAppTemplates: true }];
    assert.deepEqual(applyTemplateAccess(records, { id: 'a1', canManageWhatsAppTemplates: true }).map((r) => r.canManageWhatsAppTemplates), [true, true]);
    assert.deepEqual(applyTemplateAccess(records, { id: 'a2', canManageWhatsAppTemplates: false }).map((r) => r.canManageWhatsAppTemplates), [undefined, false]);
    assert.equal(applyTemplateAccess(records, {} as any), records, 'a malformed answer changes nothing');
  });
});
