/**
 * "Link to EventReach" as the Templates page wires it. There is no DOM test runner in this repo, so - like the other
 * page tests - this checks the markup and wiring in the source. The rules run for real in
 * utils/linkMetaTemplate.test.ts; the server's checks are in tests/eventScopedTemplates.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/pages/WhatsApp/LinkMetaTemplate.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const tab = read('frontend/src/pages/WhatsApp/AccountTemplates.tsx');
const dialog = read('frontend/src/pages/WhatsApp/LinkMetaTemplateDialog.tsx');
const detail = read('frontend/src/pages/WhatsApp/TemplateDetail.tsx');
const composer = read('frontend/src/pages/Campaigns/Composer.tsx');

describe('the action on the Meta tab', () => {
  test('is offered per row only where canOfferLink says so, next to "Not in EventReach"', () => {
    assert.ok(tab.includes('{canOfferLink(t, user) && ('));
    assert.ok(tab.includes('Link to EventReach'));
    assert.ok(tab.includes('onClick={() => setLinking(t)}'));
    assert.ok(tab.includes('<span className="text-foreground/50">Not in EventReach</span>'), 'the existing label is unchanged');
  });

  test('opens the dialog for that one template, and closes it on cancel', () => {
    assert.ok(tab.includes('{linking && <LinkMetaTemplateDialog template={linking} onClose={() => setLinking(null)} onLinked={linked} />}'));
  });

  test('after linking, the row becomes "Open in EventReach" at once, from the server\'s answer, without asking WhatsApp again', () => {
    const linked = tab.slice(tab.indexOf('const linked = (result: any) => {'), tab.indexOf('const load = async'));
    assert.ok(linked.includes('markLinked(t, result.template.id)'));
    assert.ok(linked.includes('const toast = linkToast(result ?? {});'));
    assert.equal(linked.includes('api.'), false, 'no further request');
  });

  test('the Meta list itself is still read only when asked, never on load', () => {
    assert.ok(tab.includes('Nothing has been requested from WhatsApp yet.'));
    assert.equal(/useEffect/.test(tab), false);
  });
});

describe('the dialog', () => {
  test('asks for the Event ID as typed text with the shared placeholder - not a list - and says what it is for', () => {
    assert.ok(dialog.includes('id="link-event-id"'));
    assert.ok(dialog.includes('placeholder={EVENT_BUSINESS_ID_PLACEHOLDER}'));
    assert.ok(dialog.includes('required') && dialog.includes('aria-required="true"'));
    assert.equal(/<datalist|list="/.test(dialog), false);
    assert.equal(dialog.includes("'/events'"), false, 'the event list is not loaded');
    assert.ok(dialog.includes('The event this template will be offered for.'));
  });

  test('shows the template as WhatsApp lists it, and asks only for what WhatsApp cannot tell: the event and what fills each placeholder', () => {
    assert.ok(dialog.includes('{template.bodyText}'));
    assert.ok(dialog.includes('What fills each placeholder'));
    assert.ok(dialog.includes('WHATSAPP_TEMPLATE_VARIABLE_SOURCES.map((source) => ('));
    assert.ok(dialog.includes("{row.source === 'fixed' && ("));
    assert.ok(dialog.includes('const note = headerNote(template.headerFormat);'));
    assert.ok(dialog.includes('{note && <p className="text-xs text-accent">{note}</p>}'), 'a media header is explained');
  });

  test('refuses what cannot be sent, naming why, and keeps the submit button off', () => {
    assert.ok(dialog.includes('const blockers = linkBlockers(template);'));
    assert.ok(dialog.includes('This template cannot be linked:'));
    assert.ok(dialog.includes('disabled={busy || blockers.length > 0}'));
  });

  test('validates first, then sends the request built from the form - one request, never twice at once', () => {
    const submit = dialog.slice(dialog.indexOf('const submit = () => singleFlight(send);'), dialog.indexOf('return createPortal('));
    assert.ok(submit.includes('if (busy || blockers.length > 0) return;'));
    assert.ok(submit.includes('const problems = validateLinkForm(form);'));
    assert.ok(submit.indexOf('validateLinkForm') < submit.indexOf('api.post'));
    assert.ok(submit.includes('api.post(`${TEMPLATES_API}/link-meta`, buildLinkRequest(template, form))'));
    assert.equal((submit.match(/api\./g) ?? []).length, 1);
    assert.equal(/eventObjectId|wabaId/.test(submit), false, 'nothing the server must decide is sent');
  });

  test('every way of submitting goes through the synchronous one-at-a-time guard, so two quick clicks send one request', () => {
    assert.ok(dialog.includes('const [singleFlight] = useState(createSingleFlight);'));
    assert.ok(dialog.includes('const submit = () => singleFlight(send);'));
    const callers = dialog.match(/\bsubmit\(\)|\bsend\(\)/g) ?? [];
    assert.deepEqual(callers, ['submit()'], 'the form calls submit, and nothing calls send directly');
    assert.equal(/onClick=\{[^}]*send/.test(dialog), false);
  });

  test('shows the server\'s own refusal on the field it names, and in words above', () => {
    const submit = dialog.slice(dialog.indexOf('const send = async () => {'), dialog.indexOf('return createPortal('));
    assert.ok(submit.includes('setErrors(problem.fieldErrors);'));
    assert.ok(submit.includes('setBanner(problem.message);'));
    assert.ok(dialog.includes('<FieldError message={errors.eventId} />'));
  });

  test('says plainly that nothing is created, changed or resubmitted at WhatsApp, and that the Message tab rules still apply', () => {
    assert.ok(dialog.includes('Nothing is created, changed or resubmitted at WhatsApp.'));
    assert.ok(dialog.includes('only while it is approved, and send only for an upcoming event'));
  });

  test('is an accessible dialog over the page', () => {
    assert.ok(dialog.includes('role="dialog" aria-modal="true" aria-labelledby="link-meta-title"'));
    assert.ok(dialog.includes('return createPortal('));
    assert.ok(dialog.includes('aria-label="Close"'));
  });
});

describe('what a linked template looks like afterwards', () => {
  test('the detail page shows its header format and that it came from WhatsApp, and still offers the event link', () => {
    assert.ok(detail.includes("{headerNote(template.headerFormat) && <Row label=\"Header\">{headerNote(template.headerFormat)}</Row>}"));
    assert.ok(detail.includes("{template.origin === 'meta' && <Row label=\"Source\">"));
    assert.ok(detail.includes('{actions.linkEvent && !linkOpen && ('), 'moving it uses the existing event-link action');
  });

  test('the Message tab\'s upload prompt is driven by the preview\'s header, so a media template asks for its file', () => {
    assert.ok(composer.includes('const headerPrompt = headerUploadPrompt(templatePreview?.header ?? null);'));
    assert.ok(composer.includes('{headerPrompt && ('));
    assert.ok(composer.includes('...(templateAttachment ? { attachment: templateAttachment } : {})'));
  });
});
