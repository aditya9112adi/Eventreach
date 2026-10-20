/**
 * How the Contacts tab uses the Sub-Event rules (utils/contactsEventPicker.ts, tested there
 * for real): which endpoints it calls, which controls each kind of selection can reach, and
 * that nothing on a Sub-Event can reach a call that deletes or creates a guest.
 *
 * There is no DOM test runner here, so - as the other component tests do - this checks the
 * markup and wiring in the source.
 *
 * Run: npx tsx --test frontend/src/pages/Contacts/ContactListSubEvents.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const page = read('frontend/src/pages/Contacts/ContactList.tsx');
const search = read('frontend/src/components/ui/EventSearch.tsx');

/** The text between two markers (the first occurrence of each), for checks that must stay inside one block. */
const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `found: ${from.slice(0, 60)}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `found after it: ${to.slice(0, 60)}`);
  return source.slice(start, end);
};

describe('the selector offers sub-events', () => {
  test('the page asks the server for sub-events as well as main events', () => {
    assert.ok(page.includes("const response = await api.get('/events', { params: { includeSubEvents: 'true' } });"));
  });

  test('they are shown grouped under their main event, tagged, in the same selector', () => {
    const selector = between(page, '<EventSearch', '/>');
    assert.ok(selector.includes('events={orderedEvents}'));
    assert.ok(selector.includes('groupSubEvents'));
    assert.ok(selector.includes('allowClear={true}'), 'clearing the selection still works');
    assert.ok(selector.includes('placeholder="All Events (Search...)"'));
    assert.ok(page.includes('const orderedEvents = useMemo(() => orderEventsWithSubEvents(events), [events]);'));
  });

  test('the selector tags each option and indents sub-events only when asked, so other pages look as before', () => {
    assert.ok(search.includes('groupSubEvents = false'));
    assert.ok(search.includes("{evt.parentEvent ? 'Sub-event' : 'Main event'}"));
    assert.ok(search.includes("groupSubEvents && evt.parentEvent ? 'pl-9 border-l-2 border-l-accent/40' : ''"));
    for (const other of ['frontend/src/pages/Dashboard.tsx', 'frontend/src/pages/Campaigns/Composer.tsx', 'frontend/src/pages/Contacts/BulkImport.tsx', 'frontend/src/components/ui/GuestMultiSelect.tsx']) {
      assert.equal(read(other).includes('groupSubEvents'), false, other);
    }
  });

  test('searching goes through the tested filter, which also finds a sub-event by its parent', () => {
    assert.ok(search.includes('const filteredEvents = filterEventOptions(events, searchTerm, groupSubEvents ? 100 : 50);'));
  });

  test('the header says whether the selection is a main event or a sub-event', () => {
    assert.ok(page.includes('{eventKindLabel(activeEvent)}'));
    assert.ok(page.includes('<span className="text-accent font-semibold">{activeEvent.eventName}</span>'));
  });

  test('other pages that list events still get main events only', () => {
    assert.ok(read('frontend/src/pages/Contacts/BulkImport.tsx').includes("api.get('/events')"));
    assert.equal(read('frontend/src/pages/Contacts/BulkImport.tsx').includes('includeSubEvents'), false);
    assert.ok(read('frontend/src/pages/Dashboard.tsx').includes("api.get('/events')"));
  });
});

describe('a selected sub-event shows its own contacts', () => {
  test('the list is read from the selected event\'s endpoint, which the server answers with that sub-event\'s members', () => {
    assert.ok(page.includes('const endpoint = contactsEndpoint(activeEventId);'));
    assert.ok(page.includes('const { contacts: rows, total } = readContactsPayload(response.data);'));
  });

  test('page, search and rows-per-page apply to it exactly as to a main event', () => {
    assert.ok(page.includes('page: currentPage,'));
    assert.ok(page.includes('limit: rowsPerPage,'));
    assert.ok(page.includes('...(debouncedSearch ? { search: debouncedSearch } : {}),'));
    assert.ok(page.includes('}, [activeEventId, currentPage, rowsPerPage, debouncedSearch, refreshToken]);'));
    assert.ok(page.includes('<PaginationControls'));
  });

  test('switching event goes back to page one, clears the selection and closes the sub-event dialogs', () => {
    assert.ok(page.includes('}, [debouncedSearch, activeEventId, rowsPerPage]);'));
    assert.ok(page.includes('}, [activeEventId, currentPage, rowsPerPage, debouncedSearch]);'));
    assert.ok(page.includes('setIsAssignOpen(false);\n    setConfirmRemoveId(null);\n  }, [activeEventId]);'));
  });

  test('an empty sub-event says so and offers both ways to fill it: the picker and a first guest', () => {
    assert.ok(page.includes('<p>{emptyContactsText(controls.kind, debouncedSearch)}</p>'));
    const empty = between(page, "{(controls.kind !== 'sub' || !debouncedSearch) && (", 'Add First Guest');
    assert.ok(empty.includes('{controls.assignContacts && ('));
    assert.ok(empty.includes('setIsAssignOpen(true)'));
    assert.ok(empty.includes('Add Contacts'));
    assert.ok(empty.includes('disabled={isEventCompleted}'));
    assert.ok(empty.includes('setIsAddModalOpen(true);'), 'the guest button opens the same form');
    assert.ok(page.includes('                  Add First Guest\n                </Button>'));
  });

  test('a failed load shows an error with Try again, and never leaves another event\'s contacts on screen', () => {
    assert.ok(page.includes('setLoadError(contactsLoadMessage(error));'));
    const failure = between(page, 'console.error(\'Failed to fetch contacts\', error);', '} finally {');
    assert.ok(failure.includes('setContacts([]);'));
    assert.ok(failure.includes('setTotalContacts(0);'));
    assert.ok(page.includes('<div role="alert"'));
    assert.ok(page.includes('The contacts could not be loaded'));
    assert.ok(page.includes('onClick={() => setRefreshToken((t) => t + 1)}>Try again</Button>'));
    assert.ok(page.includes("      setLoadError('');\n      try {"), 'and a new request clears the old error');
  });
});

describe('adding contacts to a sub-event', () => {
  test('a sub-event gets Add Contacts and Add Guest; Import from File is left to main events', () => {
    const header = between(page, '{controls.assignContacts && (', '</div>\n      </div>');
    const addContacts = between(header, '{controls.assignContacts && (', '</Button>');
    assert.ok(addContacts.includes('Add Contacts'));
    assert.ok(addContacts.includes('onClick={() => setIsAssignOpen(true)}'));
    assert.ok(addContacts.includes('disabled={isEventCompleted}'), 'not offered for a completed sub-event');
    const importFile = between(header, '{controls.importFile && (', '))}');
    assert.ok(importFile.includes('Import from File'));
    assert.equal(importFile.includes('Add Guest'), false);
    // Add Guest is outside both conditions: every selection has it.
    assert.ok(header.indexOf('Add Guest') > header.indexOf('))}'));
    assert.ok(header.includes('setIsAddModalOpen(true);'));
  });

  test('the picker is the contact-selection workflow used before: server candidates, multi-select, batches', () => {
    assert.ok(page.includes('<AssignContactsDialog'));
    const dialog = between(page, '<AssignContactsDialog', '/>');
    assert.ok(dialog.includes('subEvent={activeEvent}'));
    assert.ok(dialog.includes('open={isAssignOpen}'));
    assert.ok(dialog.includes('onClose={() => setIsAssignOpen(false)}'));
    assert.ok(dialog.includes('onAdded={() => setRefreshToken((t) => t + 1)}'), 'the list refreshes once contacts are added');
    assert.ok(page.includes('{activeEvent && controls.assignContacts && ('), 'it exists only while a sub-event is selected');
  });

  test('Add Guest on a sub-event is the same form as on a main event, and creates the guest on the selected sub-event', () => {
    assert.equal(page.includes("controls.kind === 'sub') return;"), false, 'no sub-event guard on creating a guest');
    assert.ok(page.includes('{controls.guestManagement && (isAddModalOpen || editingContact) && ReactDOM.createPortal('));
    assert.ok(page.includes("await api.post('/contacts', {\n        ...data,\n        eventId: activeEvent._id\n      });"));
    assert.ok(page.includes('const onAddContact = async (data: ContactForm) => {\n    if (!activeEvent || saveInFlight.current) return;'));
  });

  test('no file can be imported into a sub-event: Import from File is not offered for one', () => {
    assert.ok(page.includes('{controls.importFile && ('));
    assert.ok(read('frontend/src/utils/contactsEventPicker.ts').includes("kind: 'sub', guestManagement: true, importFile: false, assignContacts: true"));
  });
});

describe('on a sub-event, only its own guests can be edited or deleted', () => {
  test('its rows offer Remove, which calls the member endpoint and never the guest endpoints', () => {
    const remove = between(page, 'const confirmRemoveFromSubEvent = async () => {', 'const openEditModal');
    assert.ok(remove.includes('await api.delete(`/events/${activeEvent._id}/members/${confirmRemoveId}`);'));
    assert.ok(remove.includes("controls.kind !== 'sub'"));
    assert.equal(remove.includes('/contacts'), false);
    assert.ok(remove.includes('setRefreshToken((t) => t + 1);'), 'the list is re-read from the server');
  });

  test('the row actions are one or the other: Remove for a contact merely assigned to the sub-event, Edit and Delete otherwise', () => {
    const actions = between(page, "{rowActionFor(activeEvent, contact) === 'remove-from-sub-event' ? (", '</div>\n                    </td>\n                  </motion.tr>');
    const removeBranch = actions.slice(0, actions.indexOf(') : ('));
    const guestBranch = actions.slice(actions.indexOf(') : ('));
    assert.ok(removeBranch.includes('setConfirmRemoveId(contact._id)'));
    assert.equal(/openEditModal|handleDelete|DeleteIconButton/.test(removeBranch), false);
    assert.ok(guestBranch.includes('openEditModal(contact)'));
    assert.ok(guestBranch.includes('handleDelete(contact._id)'));
  });

  test('selection and bulk delete reach only the sub-event\'s own guests, never the main event\'s contacts assigned to it', () => {
    assert.equal((page.match(/controls\.selectable/g) ?? []).length, 3, 'the bar, the header box and each row box');
    assert.ok(page.includes('{controls.selectable && selectedIds.size > 0 && ('));
    assert.ok(page.includes('paginatedContacts.filter((c) => isOwnGuest(activeEvent, c)).map((c) => c._id)'), 'select-all takes only the own guests');
    assert.ok(page.includes('{isOwnGuest(activeEvent, contact) && (\n                          <RowSelectCheckbox'), 'an assigned row has no checkbox');
    assert.ok(page.includes('{pageIds.length > 0 && (\n                        <SelectAllCheckbox'), 'and no select-all when none can be selected');
    assert.equal(/\{canDelete && \(\s*<th/.test(page), false);
  });

  test('removing asks first, names the contact, and says the guest is not deleted', () => {
    assert.ok(page.includes('title="Remove From Sub-Event?"'));
    assert.ok(page.includes('The contact is not deleted and stays on the main event and any other sub-event.'));
    assert.ok(page.includes("open={Boolean(confirmRemoveId) && controls.kind === 'sub'}"));
  });
});

describe('main events behave exactly as before', () => {
  test('Add Guest, Import from File and the guest form are unchanged', () => {
    assert.ok(page.includes('<Link to={`/contacts/import?eventId=${activeEventId}`}>'));
    assert.ok(page.includes("showToast('error', 'Please select an Event from the search box first');"));
    assert.ok(page.includes("showToast('error', 'This event has been completed. Adding contacts is no longer available.');"));
    assert.ok(page.includes("await api.post('/contacts', {\n        ...data,\n        eventId: activeEvent._id\n      });"));
    assert.ok(page.includes('{editingContact ? \'Edit Guest\' : \'Add Guest Manually\'}'));
  });

  test('edit, single delete and bulk delete still use the guest endpoints', () => {
    assert.ok(page.includes('await api.put(`/contacts/${editingContact._id}`, data);'));
    assert.ok(page.includes('await api.delete(`/contacts/${id}`);'));
    assert.ok(page.includes("await api.post('/contacts/bulk-delete', { ids });"));
    assert.ok(page.includes('{canDelete && (\n                          <DeleteIconButton'), 'still only for roles that may delete');
  });

  test('the double-submit guard and the completed-event banner are intact', () => {
    assert.ok(page.includes('if (!activeEvent || saveInFlight.current) return;'));
    assert.ok(page.includes('{isEventCompleted && ('));
    assert.ok(page.includes('This event has been completed. Adding contacts and sending messages are no longer available.'));
  });

  test('search, columns and pagination are unchanged', () => {
    assert.ok(page.includes('placeholder="Search by name or phone..."'));
    for (const heading of ['Sr No', 'Name', 'WhatsApp Number', 'Status', 'Added', 'Actions']) assert.ok(page.includes(`>${heading}</th>`), heading);
    assert.ok(page.includes('{totalContacts} contacts total'));
  });

  test('with nothing selected the page still lists every guest the user may see', () => {
    assert.ok(page.includes("{ params: { includeSubEvents: 'true' } }"));
    assert.ok(read('frontend/src/utils/contactsEventPicker.ts').includes("(eventId ? `/contacts/event/${eventId}` : '/contacts')"));
  });
});
