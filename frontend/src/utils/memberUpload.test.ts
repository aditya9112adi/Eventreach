/**
 * Uploading guests onto a Sub-Event's member list - the browser side: the file
 * checks, the preview counts, the wording of the result, and how the page and
 * dialog are wired (there is no DOM test runner here, so the wiring is checked
 * in the source, as the other component tests do).
 *
 * Run: npx tsx --test frontend/src/utils/memberUpload.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import type { MemberUploadRow } from '@eventreach/shared';
import {
  MEMBER_UPLOAD_ACCEPT,
  MEMBER_UPLOAD_MAX_BYTES,
  checkMemberUploadFile,
  describeUploadResult,
  summarizeRows,
  validContactIds,
  withoutStatus,
} from './memberUpload.ts';
import { emptyOutcome, mergeBatchResponse } from './subEventMembers.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

const row = (status: MemberUploadRow['status'], extra: Partial<MemberUploadRow> = {}): MemberUploadRow => ({
  id: `r-${Math.random()}`, fullName: 'Guest', phoneNumber: '+919876543210', countryCode: 'IN', status, ...extra,
});

const ROWS: MemberUploadRow[] = [
  row('Valid', { contactId: 'a' }),
  row('Valid', { contactId: 'b' }),
  row('Valid', { contactId: 'a' }),            // the same contact twice (should not happen; still sent once)
  row('Duplicate', { contactId: 'c' }),
  row('NotFound'),
  row('NotFound'),
  row('Invalid'),
];

describe('the file, checked before it is sent', () => {
  test('Excel and PDF files are accepted, whatever the case of the extension', () => {
    for (const name of ['guests.xlsx', 'guests.xls', 'guests.pdf', 'GUESTS.XLSX', 'Guests.PDF']) {
      assert.equal(checkMemberUploadFile({ name, size: 2048 }), null, name);
    }
  });

  test('other types are refused', () => {
    for (const name of ['guests.csv', 'guests.txt', 'guests.docx', 'guests', 'guests.xlsx.exe', 'guests.png']) {
      assert.match(String(checkMemberUploadFile({ name, size: 2048 })), /Unsupported file type/, name);
    }
  });

  test('an empty file and an oversized file are refused', () => {
    assert.equal(checkMemberUploadFile({ name: 'a.xlsx', size: 0 }), 'The file is empty.');
    assert.equal(checkMemberUploadFile({ name: 'a.pdf', size: MEMBER_UPLOAD_MAX_BYTES + 1 }), 'The file is larger than 10 MB.');
    assert.equal(checkMemberUploadFile({ name: 'a.pdf', size: MEMBER_UPLOAD_MAX_BYTES }), null);
  });

  test('the picker offers exactly Excel and PDF', () => {
    assert.deepEqual(Object.values(MEMBER_UPLOAD_ACCEPT).flat().sort(), ['.pdf', '.xls', '.xlsx']);
  });
});

describe('the preview', () => {
  test('rows are counted by outcome and the counts add up', () => {
    assert.deepEqual(summarizeRows(ROWS), { total: 7, valid: 3, duplicate: 1, notFound: 2, invalid: 1 });
  });

  test('only valid, matched rows are confirmed, each contact once', () => {
    assert.deepEqual(validContactIds(ROWS), ['a', 'b']);
    assert.deepEqual(validContactIds([row('Valid'), row('NotFound', { contactId: 'x' })]), [], 'no id, or not Valid: not sent');
  });

  test('removing a kind of row leaves the others, and the counts follow', () => {
    const rest = withoutStatus(ROWS, 'NotFound');
    assert.equal(rest.length, 5);
    assert.deepEqual(summarizeRows(rest), { total: 5, valid: 3, duplicate: 1, notFound: 0, invalid: 1 });
    assert.equal(ROWS.length, 7, 'the original list is not changed');
  });
});

describe('the result', () => {
  const outcome = (added: string[], already: string[] = [], rejected: string[] = [], failed: string[] = []) =>
    mergeBatchResponse(emptyOutcome(), {
      added, alreadyMembers: already,
      rejected: rejected.map((id) => ({ id, reason: 'Access denied' })),
      failed: failed.map((id) => ({ id, reason: 'Try again' })),
      memberCount: added.length,
    });
  const counts = summarizeRows(ROWS);

  test('success: members were added, others skipped, and each kind is counted once', () => {
    const result = describeUploadResult(counts, outcome(['a', 'b']));
    assert.equal(result.tone, 'success');
    assert.equal(result.added, 2);
    assert.equal(result.alreadyMembers, 1);
    assert.equal(result.notInContacts, 2);
    assert.equal(result.invalid, 1);
    assert.equal(result.notAdded, 0);
    assert.equal(result.message, '2 members added, 1 skipped (already a member or repeated), 2 skipped (not in your contacts), 1 skipped (invalid).');
  });

  test('already members on the server count with the duplicates found in the preview', () => {
    const result = describeUploadResult({ ...counts, duplicate: 1 }, outcome([], ['a', 'b']));
    assert.equal(result.alreadyMembers, 3);
    assert.equal(result.tone, 'info');
  });

  test('partial: some added and some refused is a warning that says so', () => {
    const result = describeUploadResult(counts, outcome(['a'], [], ['b']));
    assert.equal(result.tone, 'warning');
    assert.equal(result.added, 1);
    assert.equal(result.notAdded, 1);
    assert.match(result.message, /1 could not be added/);
  });

  test('failure: nothing added and some failed is an error', () => {
    const result = describeUploadResult(counts, outcome([], [], [], ['a', 'b']));
    assert.equal(result.tone, 'error');
    assert.equal(result.notAdded, 2);
  });

  test('nothing to do reads as nothing, not as success', () => {
    const none = describeUploadResult({ total: 0, valid: 0, duplicate: 0, notFound: 0, invalid: 0 }, emptyOutcome());
    assert.equal(none.tone, 'info');
    assert.equal(none.message, 'Nothing was added.');
  });

  test('singular wording', () => {
    assert.equal(describeUploadResult({ total: 1, valid: 1, duplicate: 0, notFound: 0, invalid: 0 }, outcome(['a'])).message, '1 member added.');
  });
});

describe('how the page and dialog are wired', () => {
  const members = read('frontend/src/components/ui/SubEventMembers.tsx');
  const dialog = read('frontend/src/components/ui/MemberUploadDialog.tsx');

  test('the Members section has an Upload button after Excel and PDF, switched off for a completed event', () => {
    assert.ok(members.includes('<Upload className="w-4 h-4 mr-1.5" /> Upload'));
    assert.ok(members.includes('onClick={() => setIsUploadOpen(true)}'));
    const upload = members.slice(members.indexOf('onClick={() => setIsUploadOpen(true)}'));
    assert.ok(upload.slice(0, 200).includes('disabled={!canAdd}'));
    const order = ['<FileSpreadsheet', '<FileText', '<Upload'].map((tag) => members.indexOf(`${tag} className="w-4 h-4 mr-1.5"`));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'Excel, PDF, Upload in that order');
    assert.ok(order.every((i) => i > 0));
    assert.equal(members.includes('Add Members'), false, 'and Add Members is no longer offered');
  });

  test('the existing controls are unchanged', () => {
    assert.ok(members.includes("onClick={() => runExport('excel')}"));
    assert.ok(members.includes("onClick={() => runExport('pdf')}"));
    assert.equal(members.includes('setIsAddOpen'), false);
    assert.equal(members.includes('AddMembersDialog'), false);
    assert.ok(members.includes('<PaginationControls'));
    assert.ok(members.includes('value={searchTerm}'));
  });

  test('uploading refreshes the member list', () => {
    assert.ok(members.includes('<MemberUploadDialog subEvent={subEvent} open={isUploadOpen} onClose={() => setIsUploadOpen(false)} onAdded={refresh} />'));
  });

  test('the file goes to this sub-event only, as a multipart upload that saves nothing', () => {
    assert.ok(dialog.includes('api.post(`/events/${subEvent._id}/members/upload`, formData'));
    assert.ok(dialog.includes("formData.append('file', file);"));
    assert.ok(dialog.includes("'Content-Type': 'multipart/form-data'"));
  });

  test('confirming adds through the member list\'s add call and its batching, sending the sub-event\'s own id', () => {
    assert.ok(dialog.includes('api.post(`/events/${subEvent._id}/members`, { contactIds: batches[i] })'));
    assert.ok(dialog.includes('chunkIds(ids, ADD_MEMBERS_BATCH_SIZE)'));
    assert.ok(dialog.includes('mergeBatchResponse(result, res.data)'));
    assert.ok(dialog.includes('runAdd(validContactIds(rows), live, emptyOutcome())'));
  });

  test('nothing is sent to the contact endpoints, so no contact can be created', () => {
    assert.equal(dialog.includes('/contacts'), false);
    assert.equal(members.includes('/contacts'), false);
  });

  test('the file is checked before it is sent, and a failure is shown, not swallowed', () => {
    assert.ok(dialog.includes('checkMemberUploadFile(picked)'));
    assert.ok(dialog.includes("err?.response?.data?.error || 'The file could not be processed. Try again.'"));
    assert.ok(dialog.includes('role="alert"'));
  });

  test('the dialog is a portalled modal that cannot be dismissed while a request is running', () => {
    assert.ok(dialog.includes('createPortal('));
    assert.ok(dialog.includes('role="dialog"'));
    assert.ok(dialog.includes("e.key === 'Escape' && !busy"));
    assert.ok(dialog.includes('disabled={busy}'));
  });

  test('the preview needs a click to save and shows all four counts', () => {
    for (const label of ['Will be added:', 'Duplicates:', 'Not in contacts:', 'Invalid:']) assert.ok(dialog.includes(label), label);
    assert.ok(dialog.includes('disabled={live.valid === 0}'));
    assert.ok(dialog.includes('onClick={confirm}'));
  });

  test('the result shows added, already members, not in contacts, invalid and failed, with retry for failures', () => {
    for (const label of ["'Added'", "'Already members'", "'Not in contacts'", "'Invalid'", "'Failed'"]) assert.ok(dialog.includes(label), label);
    assert.ok(dialog.includes('Retry failed ('));
  });
});
