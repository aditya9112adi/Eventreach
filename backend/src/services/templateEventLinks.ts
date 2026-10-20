import mongoose from 'mongoose';
import { WhatsAppTemplate } from '../models/WhatsAppTemplate';
import { Event } from '../models/Event';

/**
 * Templates saved before event-specific templates stored `eventId` as the
 * event's MongoDB ObjectId. A template now stores that ObjectId as
 * `eventObjectId` and the event's business id ("EVT-0000017") as `eventId`.
 *
 * This finds the old-shape templates and, when asked, converts each one from
 * the event it points at - read from the database - so an association is
 * carried over exactly, never guessed. A template whose event is gone, or has
 * no business id, is reported and left alone. Templates that never had an
 * event stay unassociated: nothing is ever assigned to an event.
 *
 * Works on the raw collection: through the model, an ObjectId in the string
 * field `eventId` would already be read back as a hex string.
 */

export interface LegacyTemplateLink {
  templateId: string;
  name: string;
  language: string;
  eventObjectId: string;
  /** What the event's business id would be; null when the event cannot supply one. */
  eventBusinessId: string | null;
}

export const findLegacyTemplateLinks = async (): Promise<LegacyTemplateLink[]> => {
  const rows: any[] = await WhatsAppTemplate.collection
    .find({ eventId: { $type: 'objectId' } }, { projection: { name: 1, language: 1, eventId: 1 } })
    .toArray();
  if (rows.length === 0) return [];

  const events: any[] = await Event.find({ _id: { $in: rows.map((r) => r.eventId) } }).select('_id eventId').lean();
  const byId = new Map(events.map((e) => [String(e._id), e]));

  return rows.map((r) => {
    const event = byId.get(String(r.eventId));
    return {
      templateId: String(r._id),
      name: r.name,
      language: r.language,
      eventObjectId: String(r.eventId),
      eventBusinessId: typeof event?.eventId === 'string' ? event.eventId : null,
    };
  });
};

/** Converts every old-shape template whose event can be found. Safe to run again. */
export const migrateLegacyTemplateLinks = async (): Promise<{ converted: number; unresolved: LegacyTemplateLink[] }> => {
  const links = await findLegacyTemplateLinks();
  let converted = 0;
  const unresolved: LegacyTemplateLink[] = [];

  for (const link of links) {
    if (!link.eventBusinessId) {
      unresolved.push(link);
      continue;
    }
    const result = await WhatsAppTemplate.collection.updateOne(
      // Guarded on the old shape, so a second run - or a concurrent edit - changes nothing.
      { _id: new mongoose.Types.ObjectId(link.templateId), eventId: { $type: 'objectId' } },
      { $set: { eventObjectId: new mongoose.Types.ObjectId(link.eventObjectId), eventId: link.eventBusinessId } }
    );
    converted += result.modifiedCount;
  }
  return { converted, unresolved };
};
