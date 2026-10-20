/**
 * The picker that gives a Sub-Event existing contacts, opened from the Contacts tab. It is the
 * contact-selection workflow the Members section used to have (same server endpoints, same
 * selection and batching), moved here; these are its original checks, carried over.
 *
 * There is no DOM test runner here, so the assertions pin the markup and the wiring.
 *
 * Run: npx tsx --test frontend/src/components/ui/AssignContactsDialog.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const picker = read('frontend/src/components/ui/AssignContactsDialog.tsx');

test('it is named for what it does, and says "Add Contacts"', () => {
  assert.ok(picker.includes('export const AssignContactsDialog = ({ subEvent, open, onClose, onAdded }: AssignContactsDialogProps) => {'));
  assert.ok(picker.includes('<UserPlus className="w-5 h-5" /> Add Contacts'));
  assert.ok(picker.includes('aria-labelledby="assign-contacts-title"'));
  assert.equal(picker.includes('Add Members'), false);
  assert.equal(picker.includes('AddMembersDialog'), false);
});

test('the sub-event\'s own Members section still has no Add Members button', () => {
  const members = read('frontend/src/components/ui/SubEventMembers.tsx');
  assert.equal(members.includes('Add Members'), false);
  assert.equal(members.includes('AssignContactsDialog'), false);
  assert.equal(fs.existsSync('frontend/src/components/ui/AddMembersDialog.tsx'), false);
});

test('it offers the server\'s candidates, the Main Event first', () => {
  assert.ok(picker.includes('await api.get(`/events/${subEvent._id}/member-candidates`'));
  assert.ok(picker.includes("useState<string>(subEvent.parentEventId || '')"));
  assert.ok(picker.includes("{s._id === subEvent.parentEventId ? ' (main event)' : ''}"));
});

test('it reuses the Contacts tab\'s row and page selection, so several contacts can be picked', () => {
  assert.ok(picker.includes("import { getPageSelectionState, toggleSelectAllOnPage, toggleSelection } from '../../utils/selection';"));
  assert.ok(picker.includes('<SelectAllCheckbox'));
  assert.ok(picker.includes('<RowSelectCheckbox'));
});

test('contacts already on the list are marked and cannot be picked again', () => {
  assert.ok(picker.includes('const selectableIds = useMemo(() => candidates.filter((c) => !c.isMember).map((c) => c._id), [candidates]);'));
  assert.ok(picker.includes('<input type="checkbox" checked disabled aria-label={`${c.fullName} is already a member`}'));
  assert.ok(picker.includes('<Badge variant="success" className="ml-2">Member</Badge>'));
});

test('it sends the selection in batches to this sub-event\'s own member endpoint, and reports what the server said', () => {
  assert.ok(picker.includes('const batches = chunkIds(ids, ADD_MEMBERS_BATCH_SIZE);'));
  assert.ok(picker.includes("const res = await api.post(`/events/${subEvent._id}/members`, { contactIds: batches[i] });"));
  assert.ok(picker.includes('result = mergeBatchResponse(result, res.data);'));
  assert.ok(picker.includes('const { tone, message } = describeOutcome(result);'));
});

test('it never creates a contact: nothing is sent to the guest endpoints', () => {
  assert.equal(picker.includes("api.post('/contacts"), false);
  assert.equal(picker.includes('/contacts/'), false);
});

test('one add at a time, with failed ids offered for retry', () => {
  assert.ok(picker.includes('if (isAdding || ids.length === 0) return;'));
  assert.ok(picker.includes('Retry failed ({retryIds.length})'));
  assert.ok(picker.includes('setSelected(new Set(retryableIds(result)));'));
});

test('a failed add is reported to the user, with the server\'s reason for each contact that could not be added', () => {
  assert.ok(picker.includes("body?.error || 'Could not reach the server. Try again.'"));
  assert.ok(picker.includes('mergeBatchFailure(result, batches[i]'));
});

test('it renders over the window, like the app\'s other dialogs, and cannot be dismissed mid-request', () => {
  assert.ok(picker.includes('return createPortal(\n    <div className="fixed inset-0'));
  assert.ok(picker.includes("if (e.key === 'Escape' && !isAdding) onClose();"));
});
