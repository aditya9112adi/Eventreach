import type { Event } from '@eventreach/shared';

/**
 * The Contacts tab with Sub-Events: which events its selector offers, in what
 * order, and what each kind of selection lets the user do.
 *
 * A Sub-Event's list holds two kinds of contact: guests added to the Sub-Event itself
 * (it owns them: they are edited and deleted like any guest, and are on no other list) and
 * existing contacts of its Main Event assigned to it (owned by that Main Event: "remove"
 * only takes them off this one list, never deleting the guest). The page offers both ways
 * to add - picking existing contacts, and adding a guest - but no file import, which the
 * server refuses for a Sub-Event.
 *
 * Pure functions, so every rule can be tested without a browser.
 */

/** All the kind of an event depends on is whether it names a Main Event. */
type EventLike = Pick<Event, 'parentEventId'>;

/** True for a Sub-Event. A Main Event, no selection and anything unknown are not. */
export const isSubEventRecord = (event: EventLike | null | undefined): boolean => Boolean(event && event.parentEventId);

/**
 * The events in the order the selector shows them: each Main Event, in the order
 * given, followed by its own Sub-Events (by date and time), so a Sub-Event always
 * reads as sitting under its parent. A Sub-Event whose Main Event is not in the
 * list - access to a Sub-Event follows its Main Event, so this should not happen -
 * is kept, after the rest, rather than made unselectable.
 */
export const orderEventsWithSubEvents = (events: Event[]): Event[] => {
  const mains = events.filter((e) => !isSubEventRecord(e));
  const underParent = new Map<string, Event[]>();
  for (const sub of events.filter(isSubEventRecord)) {
    const key = String(sub.parentEventId);
    underParent.set(key, [...(underParent.get(key) ?? []), sub]);
  }
  const bySchedule = (list: Event[]) =>
    [...list].sort(
      (a, b) =>
        `${a.eventDate} ${a.eventTime}`.localeCompare(`${b.eventDate} ${b.eventTime}`) || a.eventName.localeCompare(b.eventName)
    );

  const ordered: Event[] = [];
  for (const main of mains) {
    ordered.push(main, ...bySchedule(underParent.get(main._id) ?? []));
    underParent.delete(main._id);
  }
  for (const orphans of underParent.values()) ordered.push(...bySchedule(orphans));
  return ordered;
};

/**
 * The events a search offers: those whose name, type or Event ID contain the text,
 * and - so that typing a Main Event's name finds its Sub-Events too - those whose
 * Main Event's name does. The order given is kept, so a Sub-Event stays under its parent.
 */
export const filterEventOptions = (events: Event[], query: string, limit = 50): Event[] => {
  const q = query.toLowerCase();
  return events
    .filter(
      (e) =>
        e.eventName.toLowerCase().includes(q) ||
        e.eventType?.toLowerCase().includes(q) ||
        e.eventId?.toLowerCase().includes(q) ||
        e.parentEvent?.eventName?.toLowerCase().includes(q)
    )
    .slice(0, limit);
};

/** "Main event", or "Sub-event of <name>". */
export const eventKindLabel = (event: Pick<Event, 'parentEventId' | 'parentEvent'>): string =>
  isSubEventRecord(event) ? `Sub-event of ${event.parentEvent?.eventName ?? 'its main event'}` : 'Main event';

/** The list the page loads: one event's guests (or members), or everything the user may see. */
export const contactsEndpoint = (eventId: string): string => (eventId ? `/contacts/event/${eventId}` : '/contacts');

export type RowAction = 'edit-delete' | 'remove-from-sub-event';

export interface ContactControls {
  kind: 'all' | 'main' | 'sub';
  /** Add Guest and the add/edit guest form: every selection. */
  guestManagement: boolean;
  /** Import from File: Main Events (and the unselected view) only. */
  importFile: boolean;
  /** Picking existing contacts for a Sub-Event. */
  assignContacts: boolean;
  /** Checkboxes and bulk delete, which delete guest records - offered per row, see isOwnGuest. */
  selectable: boolean;
}

/**
 * True when the guest belongs to the selection itself: every guest of a Main Event or of the
 * unselected view, and, for a Sub-Event, the guests added to it - not the Main Event's contacts
 * assigned to it. Only such a guest may be edited, deleted or selected for bulk delete there.
 */
export const isOwnGuest = (
  event: Pick<Event, '_id' | 'parentEventId'> | null | undefined,
  contact: { eventId?: unknown }
): boolean => !isSubEventRecord(event) || String(contact.eventId ?? '') === String(event?._id ?? '');

/** What a row offers: Edit/Delete for a guest of the selection, Remove for a contact merely assigned to a Sub-Event. */
export const rowActionFor = (
  event: Pick<Event, '_id' | 'parentEventId'> | null | undefined,
  contact: { eventId?: unknown }
): RowAction => (isOwnGuest(event, contact) ? 'edit-delete' : 'remove-from-sub-event');

/**
 * What the page offers for the selection. `canDelete` is the role rule for deleting
 * guests (Users cannot); it never lets a Sub-Event delete one.
 */
export const contactControls = (event: EventLike | null | undefined, canDelete: boolean): ContactControls => {
  if (isSubEventRecord(event)) {
    return { kind: 'sub', guestManagement: true, importFile: false, assignContacts: true, selectable: canDelete };
  }
  return { kind: event ? 'main' : 'all', guestManagement: true, importFile: true, assignContacts: false, selectable: canDelete };
};

/** The contacts and the total from the server's answer: the paged shape, or (an older server) a plain array. */
export const readContactsPayload = (data: unknown): { contacts: any[]; total: number } => {
  if (Array.isArray(data)) return { contacts: data, total: data.length };
  const page = (data ?? {}) as { data?: unknown; pagination?: { total?: unknown } };
  const contacts = Array.isArray(page.data) ? page.data : [];
  const total = typeof page.pagination?.total === 'number' ? page.pagination.total : 0;
  return { contacts, total };
};

/** Why the list could not be shown: the server's own words, else a plain instruction. */
export const contactsLoadMessage = (error: any): string =>
  error?.response?.data?.error || 'The contacts could not be loaded. Check your connection and try again.';

/** What an empty list says. */
export const emptyContactsText = (kind: ContactControls['kind'], search: string): string => {
  if (kind === 'sub') {
    return search ? `No contacts in this sub-event match "${search}".` : 'No contacts are assigned to this sub-event yet.';
  }
  return 'No guests found for this event.';
};
