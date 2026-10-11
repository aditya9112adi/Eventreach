import mongoose from 'mongoose';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { EventMember } from '../models/EventMember';
import { AuthUserInfo, getAuthorizedEventIds } from './eventAuthService';

/**
 * Main Events and Sub-Events (Wedding -> Haldi, Wedding Ceremony, Reception).
 *
 * A Sub-Event is an ordinary event document with parentEventId set to its
 * Main Event, one level deep. Its guests are not contacts of its own: they are
 * existing contacts placed on its member list (EventMember). These helpers are
 * the one place that difference is spelled out, so every path that asks "who
 * are this event's guests?" - the guest list, a campaign, a template send -
 * gets the same answer.
 */

/** Matches every Main Event, including those created before sub-events existed. */
export const MAIN_EVENT_FILTER = { parentEventId: null } as const;

export const isSubEvent = (event: { parentEventId?: unknown } | null | undefined): boolean =>
  Boolean(event && event.parentEventId);

/**
 * Whether an id names a Sub-Event. Guests are created on, and Users are
 * assigned to, a Main Event only; the paths that take an event id from a
 * request ask this first.
 */
export const isSubEventId = async (eventId: unknown): Promise<boolean> =>
  mongoose.isValidObjectId(eventId) &&
  isSubEvent(await Event.findById(eventId).select('parentEventId').lean());

/** The contact ids on a Sub-Event's member list. */
export const memberContactIds = async (eventId: unknown): Promise<mongoose.Types.ObjectId[]> => {
  const rows = await EventMember.find({ eventId }).select('contactId').lean();
  return rows.map((row: any) => row.contactId);
};

/**
 * A Contact query for an event's guests: a Main Event's own contacts, or a
 * Sub-Event's members - never the Main Event's guests for a Sub-Event, nor a
 * sibling sub-event's.
 */
export const eventGuestFilter = async (event: { _id: unknown; parentEventId?: unknown }): Promise<Record<string, unknown>> =>
  isSubEvent(event) ? { _id: { $in: await memberContactIds(event._id) } } : { eventId: event._id };

/**
 * One guest of an event, or null. A Sub-Event's guest must be on its member
 * list; a Main Event's must belong to it.
 */
export const findEventGuest = async (event: { _id: unknown; parentEventId?: unknown }, contactId: unknown) => {
  if (!isSubEvent(event)) return Contact.findOne({ _id: contactId, eventId: event._id }).lean();
  const member = await EventMember.exists({ eventId: event._id, contactId });
  return member ? Contact.findById(contactId).lean() : null;
};

/**
 * Member counts for many sub-events in one query.
 *
 * Only members whose contact still exists are counted - the same members the
 * list, the export and a campaign reach - so a count can never disagree with
 * the list it summarises, even if a membership outlived its contact (a guest
 * deleted at the very moment it was being added). The lookup is on the
 * contacts' _id index.
 */
export const countMembers = async (eventIds: unknown[]): Promise<Map<string, number>> => {
  if (eventIds.length === 0) return new Map();
  const rows = await EventMember.aggregate([
    { $match: { eventId: { $in: eventIds.map((id) => new mongoose.Types.ObjectId(String(id))) } } },
    { $lookup: { from: Contact.collection.name, localField: 'contactId', foreignField: '_id', as: 'contact' } },
    { $match: { 'contact.0': { $exists: true } } },
    { $group: { _id: '$eventId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row: any) => [String(row._id), row.count as number]));
};

/** One sub-event's member count, on the same terms as countMembers. */
export const countMembersOf = async (eventId: unknown): Promise<number> =>
  (await countMembers([eventId])).get(String(eventId)) ?? 0;

/** Sub-event counts for many Main Events in one query. */
export const countSubEvents = async (parentIds: unknown[]): Promise<Map<string, number>> => {
  if (parentIds.length === 0) return new Map();
  const rows = await Event.aggregate([
    { $match: { parentEventId: { $in: parentIds.map((id) => new mongoose.Types.ObjectId(String(id))) } } },
    { $group: { _id: '$parentEventId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row: any) => [String(row._id), row.count as number]));
};

/**
 * The Main Events whose contacts may be placed on a Sub-Event's member list:
 * those the caller is authorized for AND that belong to the same organizer
 * (adminId) as the Sub-Event's Main Event. The second condition is what stops
 * a SuperAdmin - or anyone whose scope spans organizers - from moving one
 * organizer's contacts into another organizer's event.
 *
 * Bounded by the caller's own events; two queries at most.
 */
export const memberSourceEvents = async (
  user: AuthUserInfo | undefined,
  parent: { _id: unknown; adminId?: unknown }
): Promise<Array<{ _id: any; eventId?: string; eventName: string; eventDate?: Date }>> => {
  const authorized = await getAuthorizedEventIds(user);
  const query: any = { ...MAIN_EVENT_FILTER, adminId: parent.adminId ?? null };
  if (authorized !== null) query._id = { $in: authorized };
  return Event.find(query).select('_id eventId eventName eventDate').sort({ eventDate: -1, createdAt: -1 }).lean() as any;
};
