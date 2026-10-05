/**
 * The Access and Contact Reports, one row per event.
 *
 * The report's records - exactly the ones its filters matched - are grouped
 * under the events they belong to, so an event appears only when at least one
 * of its records matched. Which events a record belongs to is decided by the
 * server: a contact's eventId, or an access record's accessEventIds (worked
 * out with the same authorization rules the per-event report applies). This
 * module never infers access itself.
 *
 * Kept free of React so it can be tested on its own.
 */

/** A report row for one event: the event's own fields, and how many records it holds. */
export type EventGroupRow = Record<string, any> & { _id: string; recordCount: number };

/** The events a record belongs to, by _id. */
export const accessRecordEventIds = (row: any): string[] =>
  Array.isArray(row?.accessEventIds) ? row.accessEventIds.map(String) : [];

export const contactRecordEventIds = (row: any): string[] => (row?.eventId ? [String(row.eventId)] : []);

/**
 * One row per event that holds at least one of the records, in the order of
 * the events list (newest first, as the Event Report lists them). An event
 * the list does not hold yet still gets its row, named by id, so no matched
 * record is ever left without one.
 */
export const groupRecordsByEvent = (
  records: any[],
  eventIdsOf: (row: any) => string[],
  events: any[]
): EventGroupRow[] => {
  const counts = new Map<string, number>();
  const firstSeen: string[] = [];
  for (const record of records) {
    for (const id of new Set(eventIdsOf(record))) {
      if (!counts.has(id)) firstSeen.push(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const known = new Map(events.map((event: any) => [String(event._id), event]));
  const ordered = [
    ...events.map((event: any) => String(event._id)).filter((id) => counts.has(id)),
    ...firstSeen.filter((id) => !known.has(id)),
  ];

  return ordered.map((id) => ({
    ...(known.get(id) ?? { eventName: events.length === 0 ? 'Loading...' : '-' }),
    _id: id,
    recordCount: counts.get(id) ?? 0,
  }));
};

/** How many records belong to no event at all: they are in the downloads but in no row. */
export const countUnlinkedRecords = (records: any[], eventIdsOf: (row: any) => string[]): number =>
  records.filter((record) => eventIdsOf(record).length === 0).length;
