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

  test('submit and delete ask first; buttons are disabled while busy', () => {
    assert.ok(detail.includes("onClick={() => setConfirming('submit')}"));
    assert.ok(detail.includes("onClick={() => setConfirming('delete')}"));
    assert.ok((detail.match(/disabled=\{busy\}/g) || []).length >= 4);
  });

  test('Refresh status asks the API, is disabled while any request runs, and shows the stored result', () => {
    assert.ok(detail.includes("onClick={() => runOutcomeAction('refresh')} disabled={busy} isLoading={busy}"));
    assert.ok(detail.includes('const response = await api.post(`${TEMPLATES_API}/${id}/${path}`);'));
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
