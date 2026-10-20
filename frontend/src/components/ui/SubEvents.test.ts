/**
 * The Sub-Events screens: the section on a Main Event's details page, the
 * create/edit form and the member list.
 *
 * Their logic lives in utils/subEventMembers.ts (tested for real there) and on
 * the server (tests/subEvents.integration.test.ts). This repo has no DOM test
 * runner, so - as GuestMultiSelect.test.ts does - the assertions here pin the
 * parts that only exist in the markup and the wiring: which endpoint each
 * screen calls, which states it shows, and which actions each role is offered.
 *
 * Run: npx tsx --test frontend/src/components/ui/SubEvents.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const section = read('frontend/src/components/ui/SubEventsSection.tsx');
const members = read('frontend/src/components/ui/SubEventMembers.tsx');
const upload = read('frontend/src/components/ui/MemberUploadDialog.tsx');
const detail = read('frontend/src/pages/Events/EventDetail.tsx');
const create = read('frontend/src/pages/Events/EventCreate.tsx');
const edit = read('frontend/src/pages/Events/EventEdit.tsx');
const list = read('frontend/src/pages/Events/EventList.tsx');
const app = read('frontend/src/App.tsx');
const composer = read('frontend/src/pages/Campaigns/Composer.tsx');
const eventSearch = read('frontend/src/components/ui/EventSearch.tsx');

test('the Sub-Events section on a Main Event', async (t) => {
  await t.test('lists the sub-events of this Main Event from the server', () => {
    assert.ok(section.includes("api.get('/events', { params: { parentEventId: parent._id } })"));
  });

  await t.test('shows loading, error, empty and no-match states', () => {
    assert.ok(section.includes('aria-label="Loading sub-events"'));
    assert.ok(section.includes('>Try again</Button>'));
    assert.ok(section.includes('No sub-events yet'));
    assert.ok(section.includes('No sub-events match'));
  });

  await t.test('each row: name, date and time, venue, status and member count', () => {
    for (const heading of ['Sub-Event', 'Date & Time', 'Venue', 'Status', 'Members']) {
      assert.ok(section.includes(`<th className="py-3 px-4">${heading}</th>`), heading);
    }
    assert.ok(section.includes('memberCountLabel(sub.memberCount)'));
  });

  await t.test('View for everyone; Edit unless completed; Create and Delete for administrators only', () => {
    assert.ok(section.includes('<Link to={`/events/${sub._id}`}>'));
    assert.ok(section.includes("{sub.eventStatus !== 'Completed' && (\n                          <Link to={`/events/${sub._id}/edit`}"));
    assert.ok(section.includes("{canManage && (\n          <Button\n            onClick={() => navigate(`/events/${parent._id}/sub-events/new`)}"));
    assert.ok(section.includes("{canManage && (\n                          <DeleteIconButton"));
    assert.ok(section.includes("const canCreate = canManage && parent.eventStatus === 'Upcoming';"));
  });

  await t.test('deleting asks first, says what goes and what stays, and refetches', () => {
    assert.ok(section.includes('Its member list is removed with it. The contacts themselves, the main event and the other sub-events are not changed.'));
    assert.ok(section.includes('await api.delete(`/events/${confirmDeleteId}`);\n      // Refetched'));
    assert.ok(section.includes('if (!confirmDeleteId || isDeleting) return;'), 'no double deletion');
  });
});

test('the details page shows the section that fits the event', () => {
  assert.ok(detail.includes('<SubEventMembers subEvent={event} />'));
  assert.ok(detail.includes('<SubEventsSection parent={event} canManage={canManageSubEvents} />'));
  assert.ok(detail.includes("const canManageSubEvents = user?.role === 'SuperAdmin' || user?.role === 'Admin';"));
  assert.ok(detail.includes("const backTo = isSubEvent ? `/events/${event.parentEventId}` : '/events';"), 'a sub-event leads back to its Main Event');
  assert.equal(detail.includes('canViewAccessReport'), false, 'the details page no longer has an Access Report button (the report itself is unchanged)');
  assert.ok(detail.includes('Sub-event of{\' \'}'));
});

test('creating and editing a sub-event', async (t) => {
  await t.test('the same form and rules as an event, at its own route, administrators only', () => {
    assert.ok(app.includes("path=\"/events/:id/sub-events/new\"\n            element={<PageWrapper><RoleRoute allow={['SuperAdmin', 'Admin']}><EventCreate /></RoleRoute></PageWrapper>}"));
    assert.ok(create.includes('resolver: zodResolver(eventSchema)'));
  });

  await t.test('the parent is the URL of the request, never a form field', () => {
    assert.ok(create.includes('? await api.post(`/events/${parentId}/sub-events`, data)'));
    assert.equal(create.includes('parentEventId:'), false);
    assert.equal(/register\('parentEventId'/.test(create), false);
  });

  await t.test('a sub-event cannot be created under a sub-event or a finished event', () => {
    assert.ok(create.includes("setParentError('A sub-event cannot have sub-events of its own.');"));
    assert.ok(create.includes("} else if (main.eventStatus !== 'Upcoming') {"));
    assert.ok(create.includes('disabled={Boolean(parentError) || (isSubEvent && !parent)}'));
  });

  await t.test('one submission at a time, and the server\'s error is shown', () => {
    assert.ok(create.includes('<Button type="submit" isLoading={isSubmitting}'));
    assert.ok(create.includes("const errorMsg = err.response?.data?.error || (isSubEvent ? 'Failed to create sub-event' : 'Failed to create event');"));
  });

  await t.test('editing uses the ordinary event form, which has no parent field', () => {
    assert.ok(edit.includes("{parentName !== null ? 'Edit Sub-Event' : 'Edit Event'}"));
    assert.ok(edit.includes('await api.put(`/events/${id}`, data);'));
    assert.equal(edit.includes('parentEventId:'), false);
  });
});

test('the member list of a sub-event', async (t) => {
  await t.test('reads this sub-event\'s members, paged and searched by the server', () => {
    assert.ok(members.includes('const res = await api.get(`/events/${subEvent._id}/members`, {\n          params: { page: currentPage, limit: rowsPerPage'));
  });

  await t.test('shows the total, and loading, empty and no-match states', () => {
    assert.ok(members.includes('({memberCountLabel(memberCount)})'));
    assert.ok(members.includes('aria-label="Loading members"'));
    assert.ok(members.includes('This sub-event starts with an empty list.'));
    assert.ok(members.includes('No members match'));
  });

  await t.test('removing takes an assigned contact off this list only, after confirming; a guest added here is deleted, after confirming', () => {
    assert.ok(members.includes('await api.delete(`/events/${subEvent._id}/members/${confirmRemove._id}`);'));
    assert.ok(members.includes('The contact is not deleted and stays on the main event and any other sub-event.'));
    assert.ok(members.includes("'Removing…'"));
    assert.ok(members.includes("'Delete Guest?'"));
    assert.ok(members.includes('exist only there, so they will be permanently removed.'));
  });

  await t.test('uploading refreshes the list; not offered on a completed sub-event', () => {
    assert.ok(members.includes('<MemberUploadDialog subEvent={subEvent} open={isUploadOpen} onClose={() => setIsUploadOpen(false)} onAdded={refresh} />'));
    assert.ok(members.includes("const canAdd = subEvent.eventStatus !== 'Completed';"));
    assert.ok(/onClick=\{\(\) => setIsUploadOpen\(true\)\}\s+disabled=\{!canAdd\}/.test(members));
  });

  await t.test('the download is this sub-event\'s own member list', () => {
    assert.ok(members.includes("const res = await api.get(`/events/${subEvent._id}/members`, {\n        params: debouncedSearch ? { search: debouncedSearch } : {},"));
    assert.ok(members.includes('const meta = buildMemberExportMeta(subEvent, debouncedSearch, rows);'), 'the stated count is the rows written');
    assert.ok(members.includes("await exportToExcel(name, 'Sub-Event Members', MEMBER_EXPORT_COLUMNS, rows, meta);"));
    assert.ok(members.includes("else await exportToPdf(name, 'Sub-Event Members', MEMBER_EXPORT_COLUMNS, rows, meta);"));
  });
});

test('a sub-event has no Add Members button or picker, but does have Add Guest', async (t) => {
  await t.test('the Members section has no Add Members button, dialog or state, and the old dialog file is gone', () => {
    assert.equal(members.includes('Add Members'), false);
    assert.equal(members.includes('AddMembersDialog'), false);
    assert.equal(members.includes('isAddOpen'), false);
    assert.equal(fs.existsSync('frontend/src/components/ui/AddMembersDialog.tsx'), false);
  });

  await t.test('the empty state points at Add Guest and Upload', () => {
    assert.ok(members.includes('This sub-event starts with an empty list. Use Add Guest to add one guest, or Upload to add contacts from an Excel or PDF file;'));
    assert.equal(members.includes('Use Add Members'), false);
  });

  await t.test('the member list, the exports and the Upload button are all still there', () => {
    assert.ok(members.includes("onClick={() => runExport('excel')}"));
    assert.ok(members.includes("onClick={() => runExport('pdf')}"));
    assert.ok(members.includes('<Upload className="w-4 h-4 mr-1.5" /> Upload'));
    assert.ok(members.includes('<PaginationControls'));
    assert.ok(members.includes('No members yet'));
    assert.ok(members.includes('await api.delete(`/events/${subEvent._id}/members/${confirmRemove._id}`);'));
  });

  await t.test('what the upload shares is intact: the batched add, and the server\'s member routes', () => {
    assert.ok(upload.includes('const batches = chunkIds(ids, ADD_MEMBERS_BATCH_SIZE);'));
    assert.ok(upload.includes("const res = await api.post(`/events/${subEvent._id}/members`, { contactIds: batches[i] });"));
    const routes = read('backend/src/routes/eventRoutes.ts');
    for (const route of ["router.post('/:id/members', addMembers);", "router.get('/:id/members', listMembers);", "router.get('/:id/member-candidates', listMemberCandidates);", "router.delete('/:id/members/:contactId', removeMember);"]) {
      assert.ok(routes.includes(route), route);
    }
  });

  await t.test('the main event\'s own Add Guest is untouched; of the sub-event screens only the Members section adds a guest', () => {
    const contacts = read('frontend/src/pages/Contacts/ContactList.tsx');
    assert.ok(contacts.includes('Add Guest'));
    assert.ok(contacts.includes("{editingContact ? 'Edit Guest' : 'Add Guest Manually'}"));
    assert.ok(members.includes('<AddGuestDialog'));
    for (const source of [section, upload, detail]) assert.equal(/add guest/i.test(source.replace(/Add guests to/g, '')), false);
  });
});

test('dialogs render over the window, like the app\'s other dialogs', () => {
  // The page wrapper animates with a transform, which pins `position: fixed`
  // to the page; portalling to <body> is what the Contacts tab does too.
  assert.ok(upload.includes('return createPortal(\n    <div className="fixed inset-0'));
  assert.ok(section.includes('{createPortal(\n        <ConfirmDeleteDialog'));
  assert.ok(members.includes('{createPortal(\n        <ConfirmDeleteDialog'));
});

test('the Events list and the composer', async (t) => {
  await t.test('the list stays Main Events, each showing its sub-event count', () => {
    assert.ok(list.includes("const response = await api.get('/events');"));
    assert.ok(list.includes('subEventCountLabel(event.subEventCount!)'));
    assert.ok(list.includes("which must be deleted first from the event's details page."));
  });

  await t.test('the composer can target a sub-event, which names its Main Event', () => {
    assert.ok(composer.includes("api.get('/events', { params: { includeSubEvents: 'true' } })"));
    assert.ok(eventSearch.includes("{evt.parentEvent ? ` · Sub-event of ${evt.parentEvent.eventName}` : ''}"));
  });
});
