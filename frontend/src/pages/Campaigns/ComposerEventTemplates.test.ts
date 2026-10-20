/**
 * How the Message tab uses event-specific templates. No DOM test runner exists, so the page's wiring
 * is checked in the source; the rules (what survives an event change, what a request carries) run
 * for real in utils/eventTemplates.test.ts, and the server's checks in
 * tests/eventScopedTemplates.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/pages/Campaigns/ComposerEventTemplates.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const composer = read('frontend/src/pages/Campaigns/Composer.tsx');

describe('the templates offered', () => {
  test('are read from the server for the selected event, and for no event when none is selected', () => {
    assert.ok(composer.includes("api\n      .get('/whatsapp/event-templates', { params: { eventId: selectedEventId } })"));
    const effect = composer.slice(composer.indexOf("setEventTemplates([]);\n    if (!selectedEventId) {"), composer.indexOf('}, [selectedEventId]);', composer.indexOf("'/whatsapp/event-templates'")));
    assert.ok(effect.indexOf('if (!selectedEventId)') < effect.indexOf("api\n"), 'no request without an event');
    assert.ok(effect.includes("setEventTemplatesState('idle');"));
  });

  test('another event\'s list is dropped the moment the event changes, and a late answer for it is ignored', () => {
    assert.ok(composer.includes('setEventTemplates([]);\n    if (!selectedEventId) {'));
    assert.ok(composer.includes('let cancelled = false;\n    setEventTemplatesState(\'loading\');'));
    assert.ok(composer.includes('if (cancelled) return;\n        setEventTemplates(readEventTemplates(response.data));'));
    assert.ok(composer.includes('return () => {\n      cancelled = true;\n    };\n  }, [selectedEventId]);'));
  });

  test('only the selected event\'s templates are offered - no general template is, and none without an event', () => {
    assert.ok(composer.includes('{selectedEventId &&\n                      eventTemplates.map((template) => ('));
    assert.ok(composer.includes('disabled={!selectedEventId || eventTemplates.length === 0 || isSendingTemplate}'));
    assert.equal(/\bTEMPLATES\b/.test(composer), false, 'the built-in list is gone from the page');
    assert.equal(/General templates|<optgroup/.test(composer), false);
    for (const name of ['event_reminder', 'event_document', 'event_image', 'event_video', 'pranjali_ankit_wedding_invite']) {
      assert.equal(composer.includes(name), false, `${name} is not on the page`);
    }
    // Every option is an event template's key, or the empty "select" first option.
    const select = composer.slice(composer.indexOf('<select\n                    value={templateName}'), composer.indexOf('</select>'));
    assert.equal((select.match(/<option /g) ?? []).length, 2, 'the empty option and the event templates');
    assert.ok(select.includes('value={eventTemplateKey(template.id)}'));
  });

  test('starts with no template chosen, and offers none until the event\'s own have arrived', () => {
    assert.ok(composer.includes("const [templateName, setTemplateName] = useState('');"));
    assert.ok(composer.includes('<option value="">{templatePlaceholder(selectedEventId, eventTemplatesState, eventTemplates.length)}</option>'));
    assert.ok(composer.includes('{!selectedEventId && <p className="text-xs text-foreground/50 mt-1">{SELECT_EVENT_FOR_TEMPLATES_TEXT}</p>}'));
  });

  test('no preview is requested and Send stays off until a template is chosen', () => {
    assert.ok(composer.includes('if (!selectedEventId || !previewContactId || !templateName) {'));
    assert.ok(composer.includes('disabled={!canSendTemplate(sendGate)}'));
  });

  test('says so when the event has none, and when they could not be loaded - with a way to try again', () => {
    assert.ok(composer.includes("eventTemplatesState === 'ready' && eventTemplates.length === 0"));
    assert.ok(composer.includes('NO_EVENT_TEMPLATES_TEXT'));
    assert.ok(composer.includes("eventTemplatesState === 'error'"));
    assert.ok(composer.includes('onClick={() => setEventTemplatesRefresh((n) => n + 1)}>Try again</button>'));
    assert.ok(composer.includes('}, [selectedEventId, eventTemplatesRefresh]);'));
  });
});

describe('the selection', () => {
  test('is cleared when the chosen template is not the selected event\'s', () => {
    assert.ok(composer.includes("setTemplateName((current) => reconcileTemplateKey(current, eventTemplates, ''));\n  }, [eventTemplates, selectedEventId]);"));
  });

  test('a chosen template clears the attached file and the old preview, as for a built-in one', () => {
    assert.ok(composer.includes('setTemplateAttachment(null);\n  }, [templateName, selectedEventId]);'));
    assert.ok(composer.includes('}, [selectedEventId, previewContactId, templateName]);'));
  });
});

describe('what is previewed and sent', () => {
  test('the preview and the send choose the template by its id', () => {
    assert.ok(composer.includes('params: { eventId: selectedEventId, contactId: previewContactId, ...templateRequestFields(templateName) },'));
    assert.ok(composer.includes('contactIds: selectedContactIds,\n        ...templateRequestFields(templateName),'));
    assert.equal(/templateName,\n\s+\.\.\.\(templateAttachment/.test(composer), false, 'the send no longer posts the raw key as a name');
  });

  test('guests, multi-recipient sending, the header-file upload and the send gate are untouched', () => {
    assert.ok(composer.includes('contactIds: selectedContactIds,'));
    assert.ok(composer.includes('...(templateAttachment ? { attachment: templateAttachment } : {})'));
    assert.ok(composer.includes('const headerPrompt = headerUploadPrompt(templatePreview?.header ?? null);'));
    assert.ok(composer.includes('if (sendingTemplateRef.current || !canSendTemplate(sendGate)) return;'));
    assert.ok(composer.includes("api.post('/whatsapp/event-template', {"));
    assert.ok(composer.includes('await api.post(\'/campaigns/upload\''));
  });
});
