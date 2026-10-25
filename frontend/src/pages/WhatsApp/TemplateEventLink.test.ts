/**
 * Linking a template to an event from the template detail page. There is no DOM test runner in this repo, so - like
 * the other page tests - this checks the markup and wiring in the source. The rules (what is sent, the confirmation
 * wording, who is offered the action) run for real in utils/whatsappTemplates.test.ts; the server's lookup,
 * authorization, audit and "no call to Meta" are proved in tests/eventScopedTemplates.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/pages/WhatsApp/TemplateEventLink.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const detail = read('frontend/src/pages/WhatsApp/TemplateDetail.tsx');
const utils = read('frontend/src/utils/whatsappTemplates.ts');

describe('the action on the template detail page', () => {
  test('is offered beside the Event row only when the viewer may link, as "Link to an event" or "Change event"', () => {
    assert.ok(detail.includes('{actions.linkEvent && !linkOpen && ('));
    assert.ok(detail.includes("{template.eventId ? 'Change event' : 'Link to an event'}"));
    assert.ok(detail.includes('{actions.linkEvent && linkOpen && ('));
    assert.ok(utils.includes("linkEvent: t.localState !== 'Submitting',"));
  });

  test('is a text input for the Event ID - not a list - with the shared placeholder, and not an ObjectId', () => {
    assert.ok(detail.includes('id="tpl-link-event-id"'));
    assert.ok(detail.includes('placeholder={EVENT_BUSINESS_ID_PLACEHOLDER}'));
    assert.equal(/<select|<datalist/.test(detail.slice(detail.indexOf('id="tpl-link-event-id"') - 400, detail.indexOf('id="tpl-link-event-id"') + 900)), false);
    assert.equal(detail.includes('eventObjectId:'), false, 'the page never sends an ObjectId');
  });

  test('a template with no event says it is not offered in the Message tab until linked', () => {
    assert.ok(detail.includes("'No event - not offered in the Message tab until it is linked to one'"));
    assert.equal(detail.includes('Reusable across events'), false);
  });
});

describe('the flow', () => {
  test('validates the typed Event ID first, with a clear message and nothing sent', () => {
    const review = detail.slice(detail.indexOf('const reviewLink = () => {'), detail.indexOf('const saveLink = async () => {'));
    assert.ok(review.includes('const request = eventLinkRequest(linkInput);'));
    assert.ok(review.includes('setLinkError(request.message);'));
    assert.ok(review.includes('This template is already linked to ${request.body.eventId}.'), 'choosing the event it already has is stopped before any request');
    assert.equal(review.includes('api.'), false, 'reviewing sends nothing');
    assert.ok(review.includes('setLinkConfirm(request.body.eventId);'), 'then it asks for confirmation');
  });

  test('asks for confirmation before anything is sent, saying what changes and what does not', () => {
    assert.ok(detail.includes('{linkConfirm && (() => {\n        const ask = eventLinkConfirmation(template, linkConfirm);'));
    assert.ok(detail.includes('role="dialog" aria-modal="true" aria-labelledby="link-confirm-title"'));
    assert.ok(detail.includes('<Button variant="secondary" onClick={() => setLinkConfirm(null)}>Cancel</Button>'));
    assert.ok(detail.includes('<Button onClick={saveLink}>{ask.confirmLabel}</Button>'));
  });

  test('sends only the confirmed Event ID, to the link endpoint, once - and never calls Meta', () => {
    const save = detail.slice(detail.indexOf('const saveLink = async () => {'), detail.indexOf('const confirm = async () => {'));
    assert.ok(save.includes("await api.put(`${TEMPLATES_API}/${id}/event`, { eventId });"));
    assert.ok(save.includes('if (!eventId || linkBusy) return;'), 'a second click while saving does nothing');
    assert.equal((save.match(/api\./g) ?? []).length, 1, 'one request');
    assert.equal(/\/submit|\/refresh|\/reconcile/.test(save), false);
  });

  test("shows the server's own refusal under the field, and refreshes the template if it began submitting", () => {
    const save = detail.slice(detail.indexOf('const saveLink = async () => {'), detail.indexOf('const confirm = async () => {'));
    assert.ok(save.includes('setLinkError(problem.fieldErrors.eventId ?? problem.message);'));
    assert.ok(save.includes("if (problem.kind === 'conflict') load();"));
    assert.ok(detail.includes('{linkError && <p className="text-xs text-destructive" role="alert">{linkError}</p>}'));
  });

  test('shows the template as the server returns it, tells the user, and closes the form on success', () => {
    const save = detail.slice(detail.indexOf('const saveLink = async () => {'), detail.indexOf('const confirm = async () => {'));
    assert.ok(save.includes('if (response.data?.template) setTemplate(response.data.template);'));
    assert.ok(save.includes('const toast = eventLinkToast(response.data);'));
    assert.ok(save.includes('closeLink();'));
  });
});

describe('what stays as it was', () => {
  test('Edit, Review & submit, Check status, Refresh status and Delete are still gated by the same flags', () => {
    for (const piece of ['{actions.edit && (', '{actions.checkStatus && (', '{actions.refresh && (', '{actions.submit && (']) assert.ok(detail.includes(piece), piece);
    assert.ok(utils.includes('edit: editable,\n    submit: editable,'));
    assert.ok(utils.includes("delete: t.localState === 'Draft' && !t.submissionAttempts && !t.metaTemplateId,"));
  });

  test('the Event row still shows the Event ID and the event name, looked up by the event\'s _id', () => {
    assert.ok(detail.includes('<span className="font-mono">{template.eventId}</span>'));
    assert.ok(detail.includes('.get(`/events/${template.eventObjectId}`)'));
  });

  test('the history lists an event change', () => {
    assert.ok(utils.includes("event_linked: 'Event link changed',"));
  });
});
