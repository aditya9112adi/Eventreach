/**
 * Resolves the human-readable Event ID ("EVT-000001") for an audit record.
 *
 * Nothing new is stored to make this work. AuditService already persists the
 * whole sanitised document in `changes.before` / `changes.after`, and an event
 * document carries its own `eventId`, so the value is already in the payload
 * the Audit Logs page fetches. Creates and updates carry it in `after`,
 * deletes only in `before`.
 *
 * Two guards, because "eventId" does not mean the same thing everywhere:
 * `Event.eventId` is the human-readable string, but `Contact.eventId` and
 * `Campaign.eventId` are ObjectId references to an event. Reading the field
 * blindly would print a raw ObjectId on contact and campaign rows — the exact
 * identifier this display is meant to replace. So the record must be from the
 * `events` collection *and* the value must match the shape the Event model
 * enforces (`/^EVT-\d{6,}$/`). An ObjectId cannot pass the second test even if
 * a future collection slips past the first.
 *
 * Returns null when there is no such ID — a non-event record, or an event
 * document predating the eventId field (the schema's index is partial for
 * exactly that reason). Callers render their own placeholder.
 */

/** Mirrors the `match` on Event.eventId in backend/src/models/Event.ts. */
const EVENT_ID_PATTERN = /^EVT-\d{6,}$/;

interface AuditLogLike {
  collectionName?: string;
  changes?: {
    before?: any;
    after?: any;
  } | null;
}

export const resolveAuditEventId = (log?: AuditLogLike | null): string | null => {
  if (!log || log.collectionName !== 'events') return null;

  // `after` first: on an update it holds the current value, and on a delete it
  // is absent, which is when `before` is the only copy left.
  for (const candidate of [log.changes?.after?.eventId, log.changes?.before?.eventId]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (EVENT_ID_PATTERN.test(trimmed)) return trimmed;
  }

  return null;
};
