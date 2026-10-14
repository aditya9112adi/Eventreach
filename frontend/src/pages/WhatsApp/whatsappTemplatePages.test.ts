/**
 * WhatsApp template pages - how they are wired (source checks; the project has
 * no DOM test runner). The logic they use is tested in
 * frontend/src/utils/whatsappTemplates.test.ts.
 *
 * Run: npx tsx --test frontend/src/pages/WhatsApp/whatsappTemplatePages.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const app = read('frontend/src/App.tsx');
const layout = read('frontend/src/layouts/DashboardLayout.tsx');
const list = read('frontend/src/pages/WhatsApp/Templates.tsx');
const editor = read('frontend/src/pages/WhatsApp/TemplateEditor.tsx');
const detail = read('frontend/src/pages/WhatsApp/TemplateDetail.tsx');
const utils = read('frontend/src/utils/whatsappTemplates.ts');
const justAccess = read('frontend/src/pages/Admin/JustAccess.tsx');
const guard = read('frontend/src/components/useUnsavedChangesGuard.ts');

describe('navigation and routes', () => {
  test("the menu entry follows the server's flag, not the role", () => {
    assert.ok(layout.includes('if (canSeeTemplatesPage(user)) {'));
    assert.ok(layout.includes("{ name: 'WhatsApp Templates', to: '/whatsapp/templates', icon: FileText }"));
    assert.ok(utils.includes('viewer?.canManageWhatsAppTemplates === true'));
  });

  test('every template route is behind the template guard', () => {
    for (const path of ['/whatsapp/templates', '/whatsapp/templates/new', '/whatsapp/templates/:id', '/whatsapp/templates/:id/edit']) {
      const line = app.split('\n').find((l) => l.includes(`path="${path}"`));
      assert.ok(line, path);
      assert.ok(line!.includes('<TemplateAccessRoute>'), path);
    }
  });

  test('existing routes and their guards are unchanged', () => {
    assert.ok(app.includes(`<Route path="/campaigns" element={<PageWrapper><Composer /></PageWrapper>} />`));
    assert.ok(app.includes(`<RoleRoute allow={['SuperAdmin', 'Admin']}><JustAccess /></RoleRoute>`));
    assert.ok(app.includes(`<RoleRoute allow={['SuperAdmin']}><Settings /></RoleRoute>`));
  });
});

describe('list page', () => {
  test('fetches a page with the filters that are set, and paginates on the total', () => {
    assert.ok(list.includes('api.get(TEMPLATES_API, { params: listParams(filters, page, limit) })'));
    assert.ok(list.includes('parseTemplatePage(response.data)'));
    assert.ok(list.includes('totalItems={result.pagination.total}'));
  });

  test('a filter change returns to the first page', () => {
    assert.ok(/const setFilter = [\s\S]*?setPage\(1\);/.test(list));
  });

  test('draws every view state, with retry for errors', () => {
    for (const state of ['loading', 'forbidden', 'notConfigured', 'error', 'empty', 'noMatches', 'ready']) {
      assert.ok(list.includes(`view === '${state}'`), state);
    }
    assert.ok(list.includes('onClick={load}'), 'Try again re-fetches');
  });

  test('edit is offered only when the API would accept it', () => {
    assert.ok(list.includes('{actions.edit && ('));
  });
});

describe('editor', () => {
  test('never asks for a category change', () => {
    assert.equal(editor.includes('allowCategoryChange'), false);
    assert.equal(/allowCategoryChange\s*:/.test(utils), false, 'the payload builder has no such key');
  });

  test('validates with the shared rules first, then shows the server field errors', () => {
    assert.ok(/const local = validateForm\(form\);[\s\S]*?if \(Object\.keys\(local\)\.length > 0\) \{[\s\S]*?return;/.test(editor));
    assert.ok(editor.includes('setErrors(problem.fieldErrors);'));
  });

  test('protects unsaved changes and tells the user a blank name becomes "Guest"', () => {
    assert.ok(editor.includes('useUnsavedChangesGuard(dirty && !saving);'));
    assert.ok(editor.includes('"Guest" is used instead'));
    assert.ok(guard.includes("window.addEventListener('beforeunload'"));
    assert.ok(guard.includes("document.addEventListener('click', onClick, true)"), 'capture phase, before the router');
  });

  test('a template the API would not let you edit is not editable here', () => {
    assert.ok(editor.includes('if (isEdit && loaded && !templateActions(user, loaded).edit) {'));
  });

  test('header placeholders are not offered', () => {
    assert.ok(editor.includes('Placeholders are not supported in the header.'));
  });

  test('only a Super Admin creating a template picks an owner', () => {
    assert.ok(editor.includes('{isSuperAdmin && !isEdit && ('));
    assert.ok(editor.includes('buildTemplatePayload(form, { includeOwner: isSuperAdmin && !isEdit })'));
  });
});

describe('detail page', () => {
  test('controls follow what the API accepts for the state', () => {
    for (const action of ['edit', 'checkStatus', 'refresh', 'submit', 'delete']) {
      assert.ok(detail.includes(`{actions.${action} && (`), action);
    }
  });

  test('delete asks first; submit goes through a payload review; buttons are disabled while busy', () => {
    assert.ok(detail.includes("onClick={() => setConfirming('delete')}"));
    assert.ok(detail.includes('onClick={openReview} disabled={busy}'), 'the only entry to submitting is the review');
    assert.equal(detail.includes("setConfirming('submit')"), false, 'no direct confirm-and-submit remains');
    assert.ok((detail.match(/disabled=\{busy\}/g) || []).length >= 4);
  });

  test('the review is a read, shows the server-built payload, and submitting needs the tick and the reviewed hash', () => {
    assert.ok(detail.includes('const response = await api.get(`${TEMPLATES_API}/${id}/payload`);'));
    assert.ok(detail.includes('prettyPayload(review.payload)'));
    assert.ok(detail.includes('canConfirmSubmission(review, acknowledged, busy)'));
    assert.ok(detail.includes("await runOutcomeAction('submit', submitBody(review));"));
    assert.ok(detail.includes('I have reviewed this payload'));
    // Nothing submits on open: the submit call is only inside submitReviewed.
    assert.equal((detail.match(/runOutcomeAction\('submit'/g) || []).length, 1);
  });

  test('Refresh status asks the API, is disabled while any request runs, and shows the stored result', () => {
    assert.ok(detail.includes("onClick={() => runOutcomeAction('refresh')} disabled={busy} isLoading={busy}"));
    assert.ok(detail.includes('const response = await api.post(`${TEMPLATES_API}/${id}/${path}`, body);'));
    assert.ok(detail.includes('if (response.data?.template) setTemplate(response.data.template);'), 'status and last-checked time come from the answer');
    assert.ok(detail.includes("<Row label=\"Last checked\">"));
  });

  test('shows only what the API returned', () => {
    assert.ok(detail.includes('{template.wabaId && <Row label="Business Account ID">'));
    assert.ok(detail.includes('{template.metaTemplateId && <Row label="WhatsApp template ID">'));
    assert.ok(detail.includes('{template.metaStatus && <Row label="WhatsApp status">'));
    assert.ok(detail.includes('template.history.length === 0'));
  });
});

describe('Just Access: the template permission toggle', () => {
  test('drawn only where templateAccessControl allows (Super Admin, Admin rows)', () => {
    assert.ok(justAccess.includes('{templateAccessControl(currentAuthUser, record as any).visible && ('));
  });

  test('uses the grant endpoint, and reports success only after it answers', () => {
    assert.ok(/const response = await api\.put\(templateAccessUrl\(record\._id\), \{ enabled \}\);\s*setRecords\(\(prev\) => applyTemplateAccess\(prev as any\[\], response\.data\) as any\);\s*await showSuccess\(/.test(justAccess));
    assert.ok(justAccess.includes("await showError(err.response?.data?.error || 'Failed to change WhatsApp template access');"));
  });

  test('revoking asks for confirmation; granting does not', () => {
    assert.ok(justAccess.includes('if (control.needsConfirm) setTemplateAccessToRevoke(record);'));
    assert.ok(justAccess.includes('{templateAccessToRevoke && ('));
  });

  test('the other Admin controls are untouched', () => {
    assert.ok(justAccess.includes("await api.put(`/admin/users/${id}/revoke-access?type=${type}`);"));
    assert.ok(justAccess.includes('`/admin/users/${target._id}/reset-password?type=${target.type}`'));
  });
});

describe('Meta account list, buttons and test send', () => {
  const account = read('frontend/src/pages/WhatsApp/AccountTemplates.tsx');
  const testSend = read('frontend/src/pages/WhatsApp/TestSend.tsx');
  const senders = read('frontend/src/pages/Admin/WhatsAppSenders.tsx');

  test('the account list is read only on request, for a Super Admin, with an explicit Load more', () => {
    assert.ok(list.includes('canBrowseAccount(user)'));
    assert.ok(list.includes("tab === 'account' && canBrowseAccount(user) && <AccountTemplates />"));
    assert.ok(account.includes('`${TEMPLATES_API}/meta`'));
    // No effect loads it: the only call is from a button handler.
    assert.equal(/useEffect/.test(account), false, 'nothing loads on page open');
    assert.ok(account.includes('Load from WhatsApp') && account.includes('Refresh from WhatsApp') && account.includes('Load more'));
    assert.equal(/\.(post|patch|delete|put)\(/.test(account), false, 'the list only reads');
    assert.ok(account.includes('metaStatusDisplay(t.status)'), "Meta's own status is shown, not a local one");
  });

  test('the editor offers buttons with the shared limits and shows them in the preview', () => {
    assert.ok(editor.includes('addableButtonTypes(form.buttons)'));
    assert.ok(editor.includes('WHATSAPP_TEMPLATE_BUTTON_LIMITS.text'));
    assert.ok(editor.includes('aria-label="Button preview"'));
    assert.ok(utils.includes('buttons: form.buttons.map'));
  });

  test('the test-send page is a set of reads plus one explicit send', () => {
    assert.ok(app.includes('<Route path="/whatsapp/test-send"'));
    assert.ok(app.includes('<TemplateAccessRoute><WhatsAppTestSend /></TemplateAccessRoute>'));
    const posts = testSend.match(/api\.post\(`\$\{POC_API\}\/[a-z/${}.]+/g) || [];
    assert.deepEqual(posts.sort(), ['api.post(`${POC_API}/preview', 'api.post(`${POC_API}/recipients', 'api.post(`${POC_API}/send', 'api.post(`${POC_API}/sends/${id}/reconcile'].sort());
    // The one send is inside sendNow, which is guarded by canSend and only called from the button.
    assert.equal((testSend.match(/\/send`/g) || []).length, 1);
    assert.ok(testSend.includes('if (!preview || !canSend('));
    assert.ok(testSend.includes('onClick={sendNow} disabled={!sendReady}'));
    assert.equal(/setInterval|setTimeout/.test(testSend), false, 'no polling');
    assert.ok(testSend.includes('void loadBasics();\n  }, [loadBasics]);'), 'loading reads only');
  });

  test('a change to the selection voids the preview and the confirmation', () => {
    assert.ok(testSend.includes('const changeSelection = (next: Selection) => {'));
    for (const reset of ['setPreview(null);', 'setPreviewKey(null);', 'setConfirmed(false);', 'setAcknowledgedDuplicate(false);']) assert.ok(testSend.includes(reset));
    assert.ok(testSend.includes('previewKey === currentKey'));
  });

  test('numbers are shown masked and results say what happened, never more', () => {
    assert.ok(testSend.includes('displayPhoneNumberMasked'));
    assert.ok(testSend.includes('numberMasked'));
    assert.ok(testSend.includes('No delivery report yet') === false, 'the wording lives in the logic module');
    assert.ok(read('frontend/src/utils/pocTestSend.ts').includes('No delivery report yet'));
    assert.ok(testSend.includes('Check delivery status'));
    assert.ok(testSend.includes('canReconcile(result.send)'));
  });

  test('the sender page lets a Super Admin designate the POC sender', () => {
    assert.ok(senders.includes('pocTestEnabled: e.target.checked'));
    assert.ok(senders.includes('POC test sender'));
  });
});
