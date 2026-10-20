/**
 * The Contacts tab with Sub-Events - the rules, with no browser: which events the
 * selector offers and in what order, how searching finds a Sub-Event, what each kind
 * of selection lets the user do, and how an empty or failed list is read.
 *
 * The server's side (who may list, assign, remove; duplicates; independent lists) is in
 * tests/contactsSubEvent.integration.test.ts. How the page uses these rules is in
 * frontend/src/pages/Contacts/ContactListSubEvents.test.ts.
 *
 * Run: npx tsx --test frontend/src/utils/contactsEventPicker.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Event } from '@eventreach/shared';
import {
  contactControls,
  contactsEndpoint,
  contactsLoadMessage,
  emptyContactsText,
  eventKindLabel,
  filterEventOptions,
  isSubEventRecord,
  orderEventsWithSubEvents,
  readContactsPayload,
} from './contactsEventPicker.ts';

const main = (_id: string, eventName: string, extra: Partial<Event> = {}): Event =>
  ({ _id, eventId: `EVT-${_id.toUpperCase()}`, eventName, eventType: 'Wedding', eventDate: '2030-01-10', eventTime: '10:00', eventStatus: 'Upcoming', parentEventId: null, ...extra }) as Event;
const sub = (_id: string, eventName: string, parent: Event, extra: Partial<Event> = {}): Event =>
  main(_id, eventName, { parentEventId: parent._id, parentEvent: { _id: parent._id, eventId: parent.eventId, eventName: parent.eventName } as any, ...extra });

// The server lists newest-created first, and puts no sub-event next to its parent.
const WEDDING = main('w', 'Sharma Wedding');
const GALA = main('g', 'Annual Gala', { eventType: 'Corporate' });
const HALDI = sub('h', 'Haldi', WEDDING, { eventDate: '2030-01-08', eventTime: '09:00' });
const RECEPTION = sub('r', 'Reception', WEDDING, { eventDate: '2030-01-12', eventTime: '19:00' });
const SANGEET = sub('s', 'Sangeet', WEDDING, { eventDate: '2030-01-09', eventTime: '20:00' });
const AWARDS = sub('a', 'Awards Dinner', GALA, { eventDate: '2030-03-02', eventType: 'Corporate' });
const AS_SERVED = [HALDI, GALA, RECEPTION, WEDDING, AWARDS, SANGEET];

const names = (list: Event[]) => list.map((e) => e.eventName);

describe('main events and sub-events in the selector', () => {
  test('both kinds are listed, each Sub-Event directly under its own Main Event', () => {
    assert.deepEqual(names(orderEventsWithSubEvents(AS_SERVED)), [
      'Annual Gala', 'Awards Dinner',
      'Sharma Wedding', 'Haldi', 'Sangeet', 'Reception',
    ]);
  });

  test('the Main Events keep the order the server gave; a Main Event\'s Sub-Events are in schedule order', () => {
    const ordered = orderEventsWithSubEvents(AS_SERVED);
    assert.deepEqual(names(ordered.filter((e) => !isSubEventRecord(e))), ['Annual Gala', 'Sharma Wedding']);
    assert.deepEqual(names(ordered.filter((e) => e.parentEventId === 'w')), ['Haldi', 'Sangeet', 'Reception']);
  });

  test('every event appears exactly once, and the list given is not changed', () => {
    const input = [...AS_SERVED];
    const ordered = orderEventsWithSubEvents(input);
    assert.equal(ordered.length, AS_SERVED.length);
    assert.equal(new Set(ordered.map((e) => e._id)).size, AS_SERVED.length);
    assert.deepEqual(input, AS_SERVED);
  });

  test('main events alone read exactly as before', () => {
    assert.deepEqual(orderEventsWithSubEvents([GALA, WEDDING]), [GALA, WEDDING]);
    assert.deepEqual(orderEventsWithSubEvents([]), []);
  });

  test('a Sub-Event whose Main Event is not in the list is still selectable', () => {
    const stray = sub('x', 'Stray Ceremony', main('gone', 'Not Listed'));
    const ordered = orderEventsWithSubEvents([...AS_SERVED, stray]);
    assert.ok(ordered.includes(stray));
    assert.equal(ordered[ordered.length - 1], stray, 'after the grouped events');
  });

  test('the kind is clear: "Main event", or "Sub-event of" its parent', () => {
    assert.equal(isSubEventRecord(WEDDING), false);
    assert.equal(isSubEventRecord(HALDI), true);
    assert.equal(isSubEventRecord(null), false);
    assert.equal(isSubEventRecord(undefined), false);
    assert.equal(eventKindLabel(WEDDING), 'Main event');
    assert.equal(eventKindLabel(HALDI), 'Sub-event of Sharma Wedding');
    assert.equal(eventKindLabel(sub('o', 'Orphan', WEDDING, { parentEvent: null })), 'Sub-event of its main event');
  });
});

describe('searching and selecting', () => {
  const ordered = orderEventsWithSubEvents(AS_SERVED);

  test('an empty search offers everything, in the grouped order - this is also what clearing the selection shows', () => {
    assert.deepEqual(filterEventOptions(ordered, ''), ordered);
  });

  test('a Sub-Event is found by its own name, in any case', () => {
    assert.deepEqual(names(filterEventOptions(ordered, 'haldi')), ['Haldi']);
    assert.deepEqual(names(filterEventOptions(ordered, 'AWARDS')), ['Awards Dinner']);
  });

  test('a Sub-Event is found by its Event ID', () => {
    assert.deepEqual(names(filterEventOptions(ordered, 'EVT-S')), ['Sangeet']);
  });

  test('typing a Main Event\'s name finds it and all its Sub-Events, still grouped', () => {
    assert.deepEqual(names(filterEventOptions(ordered, 'sharma')), ['Sharma Wedding', 'Haldi', 'Sangeet', 'Reception']);
  });

  test('a search can be narrowed to one kind by type, and an unmatched search offers nothing', () => {
    assert.deepEqual(names(filterEventOptions(ordered, 'corporate')), ['Annual Gala', 'Awards Dinner']);
    assert.deepEqual(filterEventOptions(ordered, 'no such event'), []);
  });

  test('the number offered is capped, keeping the first ones', () => {
    const many = Array.from({ length: 120 }, (_, i) => main(`m${i}`, `Event ${i}`));
    assert.equal(filterEventOptions(many, '').length, 50);
    assert.equal(filterEventOptions(many, '', 100).length, 100);
    assert.equal(filterEventOptions(many, '')[0].eventName, 'Event 0');
  });

  test('the selection is by id, so the picked Sub-Event is the one that was searched for', () => {
    const picked = filterEventOptions(ordered, 'reception')[0];
    assert.equal(picked._id, 'r');
    assert.equal(ordered.find((e) => e._id === picked._id), RECEPTION);
  });
});

describe('what each selection offers', () => {
  test('no selection: the guest list view, as before', () => {
    const c = contactControls(null, true);
    assert.deepEqual(c, { kind: 'all', guestManagement: true, assignContacts: false, rowAction: 'edit-delete', selectable: true });
  });

  test('a Main Event keeps Add Guest, Import, edit, delete and selection', () => {
    assert.deepEqual(contactControls(WEDDING, true), { kind: 'main', guestManagement: true, assignContacts: false, rowAction: 'edit-delete', selectable: true });
  });

  test('a User cannot select for deletion on a Main Event, exactly as before', () => {
    assert.equal(contactControls(WEDDING, false).selectable, false);
    assert.equal(contactControls(WEDDING, false).guestManagement, true);
  });

  test('a Sub-Event offers only the picker: no Add Guest, no Import, no edit, no delete, no selection', () => {
    for (const canDelete of [true, false]) {
      assert.deepEqual(contactControls(HALDI, canDelete), { kind: 'sub', guestManagement: false, assignContacts: true, rowAction: 'remove-from-sub-event', selectable: false });
    }
  });

  test('removing on a Sub-Event is a different action from deleting a guest', () => {
    assert.notEqual(contactControls(HALDI, true).rowAction, contactControls(WEDDING, true).rowAction);
  });
});

describe('switching between a main event and a sub-event, and back', () => {
  const ordered = orderEventsWithSubEvents(AS_SERVED);
  const pick = (id: string) => ordered.find((e) => e._id === id) ?? null;

  test('each step loads the right list and offers the right controls; returning restores exactly what was there', () => {
    const steps = ['w', 'h', 'r', 'w', '', 'h', 'g'].map((id) => ({ id, event: pick(id), endpoint: contactsEndpoint(id), controls: contactControls(pick(id), true) }));
    assert.deepEqual(steps.map((s) => s.endpoint), ['/contacts/event/w', '/contacts/event/h', '/contacts/event/r', '/contacts/event/w', '/contacts', '/contacts/event/h', '/contacts/event/g']);
    assert.deepEqual(steps.map((s) => s.controls.kind), ['main', 'sub', 'sub', 'main', 'all', 'sub', 'main']);
    assert.deepEqual(steps[3].controls, steps[0].controls, 'back on the Main Event: the same controls as before the Sub-Event');
    assert.equal(steps[3].endpoint, steps[0].endpoint);
  });

  test('a Sub-Event lists its own contacts - the endpoint names the Sub-Event, never its Main Event', () => {
    assert.equal(contactsEndpoint(HALDI._id), '/contacts/event/h');
    assert.notEqual(contactsEndpoint(HALDI._id), contactsEndpoint(HALDI.parentEventId!));
  });

  test('clearing the selection returns to everything', () => {
    assert.equal(contactsEndpoint(''), '/contacts');
    assert.equal(contactControls(pick(''), true).kind, 'all');
  });
});

describe('an empty sub-event and a failed load', () => {
  test('an empty paged answer is zero contacts, not an error', () => {
    assert.deepEqual(readContactsPayload({ data: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } }), { contacts: [], total: 0 });
  });

  test('a paged answer gives the page and the total across all pages', () => {
    const page = [{ _id: 'c1' }, { _id: 'c2' }];
    assert.deepEqual(readContactsPayload({ data: page, pagination: { total: 37 } }), { contacts: page, total: 37 });
  });

  test('an older server\'s plain array is read too', () => {
    assert.deepEqual(readContactsPayload([{ _id: 'c1' }]), { contacts: [{ _id: 'c1' }], total: 1 });
  });

  test('a missing or malformed answer reads as empty, never as stale or invented contacts', () => {
    for (const bad of [undefined, null, 'oops', 42, {}, { data: 'x' }, { data: [], pagination: { total: '9' } }]) {
      assert.deepEqual(readContactsPayload(bad), { contacts: [], total: 0 }, JSON.stringify(bad));
    }
  });

  test("an empty sub-event says so, and says how to fill it; a search that finds nothing says that", () => {
    assert.equal(emptyContactsText('sub', ''), 'No contacts are assigned to this sub-event yet.');
    assert.equal(emptyContactsText('sub', 'zed'), 'No contacts in this sub-event match "zed".');
  });

  test('a main event\'s empty text is the one it always had', () => {
    assert.equal(emptyContactsText('main', ''), 'No guests found for this event.');
    assert.equal(emptyContactsText('all', 'zed'), 'No guests found for this event.');
  });

  test("a failed request shows the server's own reason, else a plain instruction", () => {
    assert.equal(contactsLoadMessage({ response: { data: { error: 'Access denied. You do not have access to this event.' } } }), 'Access denied. You do not have access to this event.');
    assert.match(contactsLoadMessage(new Error('Network Error')), /could not be loaded/);
    assert.match(contactsLoadMessage(undefined), /could not be loaded/);
    assert.match(contactsLoadMessage({ response: { status: 500, data: {} } }), /try again/);
  });
});
