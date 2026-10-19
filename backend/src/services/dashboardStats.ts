import mongoose from 'mongoose';
import type { EventStatus } from '@eventreach/shared';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { Campaign } from '../models/Campaign';
import { MessageLog } from '../models/MessageLog';
import { getAuthorizedEventIds, type AuthUserInfo } from './eventAuthService';
import { eventGuestFilter } from './subEventService';

/**
 * The numbers on the Dashboard (and an event's statistics): events, contacts,
 * campaigns and messages for the events the caller may see, narrowed by the
 * Event Status and Event Name filters.
 *
 * One function decides which events match; contacts, campaigns and messages
 * are all taken from that same set, so the cards cannot disagree about scope.
 *
 * What each number means
 *  - Total Events     Main Events, as the Events page lists them (a Sub-Event
 *                     is not a separate event here). A selected event counts as 1.
 *  - Total Contacts   Distinct contacts. A contact belongs to exactly one Main
 *                     Event; a Sub-Event's guests are mappings to those same
 *                     contacts, so they are never counted a second time. A
 *                     selected Sub-Event shows its own members.
 *  - Campaigns        Campaign records (one per event), whatever their status.
 *  - Messages         One MessageLog row per recipient per send. A status
 *                     webhook updates that row, never adds one, so repeated
 *                     callbacks cannot inflate a count. A message belongs to an
 *                     event through its campaign (campaign sends) or through its
 *                     eventId (template sends, which have no campaign) - the
 *                     same two paths the event Delivery Log reads.
 *       Sent          accepted by WhatsApp: status Sent or Delivered, or a
 *                     sentAt stamp. A delivered message was accepted first, so
 *                     it is included. (It used to count Sent alone, which made a
 *                     fully delivered event read "Sent 0".)
 *       Delivered     status Delivered (a read message is Delivered plus readAt).
 *       Failed        status Failed.
 *       Pending       status Pending: queued, not yet handed to WhatsApp.
 *     These are lifecycle states, not a partition: Sent already includes
 *     Delivered, a message can be accepted and then fail, and an accepted
 *     message still awaiting its delivery receipt is in none of the others.
 */

export interface DashboardFilters {
  eventId: string | null;
  status: EventStatus | null;
}

export interface DashboardStats {
  totalEvents: number;
  totalContacts: number;
  totalCampaigns: number;
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  messagesPending: number;
}

export const EVENT_STATUSES: readonly EventStatus[] = ['Upcoming', 'Completed', 'Cancelled'];

/** Values a client may send to mean "no filter". */
const isUnset = (value: string) => ['', 'all', 'null', 'undefined'].includes(value.trim().toLowerCase());

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** `All`, `all`, empty, missing, null and undefined all mean every status; anything unknown is refused. */
export const parseStatusFilter = (raw: unknown): Parsed<EventStatus | null> => {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Invalid status filter.' };
  if (isUnset(raw)) return { ok: true, value: null };
  const match = EVENT_STATUSES.find((s) => s.toLowerCase() === raw.trim().toLowerCase());
  return match ? { ok: true, value: match } : { ok: false, error: 'Invalid status filter.' };
};

/**
 * An event id is 24 hex digits. It is returned in lower case, the form ids are
 * compared in everywhere else, so the same id in another case is not mistaken
 * for a different (or forbidden) event. mongoose's own check also accepts any
 * 12-character string, which is not an id the page ever sends.
 */
export const parseEventIdFilter = (raw: unknown): Parsed<string | null> => {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Invalid event id.' };
  if (isUnset(raw)) return { ok: true, value: null };
  const id = raw.trim();
  return /^[0-9a-fA-F]{24}$/.test(id) ? { ok: true, value: id.toLowerCase() } : { ok: false, error: 'Invalid event id.' };
};

export interface DashboardScope {
  /** Every event matching the filters within the caller's access, as ObjectIds. */
  eventIds: mongoose.Types.ObjectId[];
  mainEventCount: number;
  campaignIds: mongoose.Types.ObjectId[];
  /** Set when exactly one event was selected. */
  selected: { _id: mongoose.Types.ObjectId; parentEventId?: unknown } | null;
}

/**
 * The events the filters select, among those the caller may access. An event id
 * outside the caller's access matches nothing (the controller also refuses it
 * with a 403 first). Both filters apply together when both are given.
 */
export const resolveScope = async (user: AuthUserInfo | undefined, filters: DashboardFilters): Promise<DashboardScope> => {
  const authorized = await getAuthorizedEventIds(user); // null: unrestricted (Super Admin)
  const query: Record<string, unknown> = {};

  if (filters.eventId) {
    if (authorized !== null && !authorized.map(String).includes(filters.eventId)) {
      return { eventIds: [], mainEventCount: 0, campaignIds: [], selected: null };
    }
    query._id = filters.eventId;
  } else if (authorized !== null) {
    query._id = { $in: authorized };
  }
  if (filters.status) query.eventStatus = filters.status;

  const events: any[] = await Event.find(query).select('_id parentEventId').lean();
  const eventIds = events.map((e) => e._id as mongoose.Types.ObjectId);
  const campaigns = eventIds.length ? await Campaign.find({ eventId: { $in: eventIds } }).select('_id').lean() : [];

  return {
    eventIds,
    mainEventCount: events.filter((e) => !e.parentEventId).length,
    campaignIds: campaigns.map((c: any) => c._id),
    selected: filters.eventId && events.length === 1 ? events[0] : null,
  };
};

/**
 * Messages that belong to the scope: campaign messages through the campaign,
 * template messages through their own eventId. With nothing in scope this
 * matches nothing - it never falls back to messages with no campaign.
 */
export const messageScope = (scope: Pick<DashboardScope, 'eventIds' | 'campaignIds'>): Record<string, unknown> => ({
  $or: [
    { campaignId: { $in: scope.campaignIds } },
    { eventId: { $in: scope.eventIds }, templateName: { $exists: true, $ne: null } },
  ],
});

/** Accepted by WhatsApp: Sent or Delivered, or stamped as sent (a message can fail after being accepted). */
const ACCEPTED = { $or: [{ $in: ['$status', ['Sent', 'Delivered']] }, { $eq: [{ $type: '$sentAt' }, 'date'] }] };
const is = (status: string) => ({ $cond: [{ $eq: ['$status', status] }, 1, 0] });

export interface MessageTotals { total: number; sent: number; delivered: number; failed: number; pending: number }

export const messageTotals = async (match: Record<string, unknown>): Promise<MessageTotals> => {
  const [row] = await MessageLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        sent: { $sum: { $cond: [ACCEPTED, 1, 0] } },
        delivered: { $sum: is('Delivered') },
        failed: { $sum: is('Failed') },
        pending: { $sum: is('Pending') },
      },
    },
  ]);
  return { total: row?.total ?? 0, sent: row?.sent ?? 0, delivered: row?.delivered ?? 0, failed: row?.failed ?? 0, pending: row?.pending ?? 0 };
};

export interface DashboardResult {
  stats: DashboardStats;
  /** Counts for verification; none of it is personal data. */
  diagnostics: { matchingEvents: number; mainEvents: number; campaigns: number; messages: number };
}

export const computeDashboardStats = async (user: AuthUserInfo | undefined, filters: DashboardFilters): Promise<DashboardResult> => {
  const scope = await resolveScope(user, filters);

  // A selected Sub-Event's guests are its members; everything else owns its contacts.
  const contactFilter = scope.selected && scope.selected.parentEventId
    ? await eventGuestFilter(scope.selected as any)
    : { eventId: { $in: scope.eventIds } };

  const [totalContacts, totals] = await Promise.all([
    scope.eventIds.length ? Contact.countDocuments(contactFilter) : Promise.resolve(0),
    scope.eventIds.length ? messageTotals(messageScope(scope)) : Promise.resolve({ total: 0, sent: 0, delivered: 0, failed: 0, pending: 0 }),
  ]);

  return {
    stats: {
      totalEvents: filters.eventId ? scope.eventIds.length : scope.mainEventCount,
      totalContacts,
      totalCampaigns: scope.campaignIds.length,
      messagesSent: totals.sent,
      messagesDelivered: totals.delivered,
      messagesFailed: totals.failed,
      messagesPending: totals.pending,
    },
    diagnostics: { matchingEvents: scope.eventIds.length, mainEvents: scope.mainEventCount, campaigns: scope.campaignIds.length, messages: totals.total },
  };
};

/** Midnight (UTC) six days ago: with today, exactly seven calendar days, so none is cut off. */
export const activityWindowStart = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface ActivityDay { name: string; sent: number; delivered: number }

/**
 * Messages per day over the last seven days, for the same scope as the cards,
 * counted by the same definitions: `sent` is accepted by WhatsApp, `delivered`
 * is delivered.
 */
export const dailyActivity = async (scope: DashboardScope, now: Date = new Date()): Promise<ActivityDay[]> => {
  if (scope.eventIds.length === 0) return [];
  const rows = await MessageLog.aggregate([
    { $match: { $and: [messageScope(scope), { createdAt: { $gte: activityWindowStart(now) } }] } },
    {
      $group: {
        _id: { day: { $dayOfWeek: '$createdAt' }, date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
        sent: { $sum: { $cond: [ACCEPTED, 1, 0] } },
        delivered: { $sum: is('Delivered') },
      },
    },
    { $sort: { '_id.date': 1 } },
  ]);
  return rows.map((r: any) => ({ name: DAY_NAMES[r._id.day - 1] || r._id.date, sent: r.sent, delivered: r.delivered }));
};
