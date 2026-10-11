import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { AuthUserInfo } from './eventAuthService';

/**
 * Who has access to each of a set of events - for the Access Report, which
 * lists events and, in each event's View, the people who can reach it.
 *
 * The same rules getEventAccessHolders and getAuthorizedEventIds apply, read
 * for many events at once (three queries whatever the number of events):
 *
 *  - the account that created the event - an Admin, a Super Admin, or a User;
 *  - the Admin who owns the event (adminId);
 *  - the Users assigned to it (assignedEventId, assignedUserId, assignedUserIds);
 *  - the Admin who manages an assigned User.
 *
 * Users and Admins are the access records the report has always listed (access
 * granted, or a decision of Rejected). A Super Admin can reach every event, so
 * one is named only where they created the event.
 *
 * What the viewer may see is unchanged: a Super Admin sees everyone; an Admin
 * sees the Users they manage and their own account - never another Admin's or
 * a Super Admin's.
 */

export type AccessVia = 'Created the event' | 'Owns the event' | 'Assigned to the event' | 'Manages an assigned user';

export interface EventAccessSource {
  _id: any;
  adminId?: any;
  createdBy?: any;
  assignedUserId?: any;
  assignedUserIds?: any[];
}

export interface EventAccessResult {
  /** Every account with access to at least one of the events. */
  records: any[];
  /** Account id -> event id -> how that account has access to that event. */
  reach: Map<string, Map<string, AccessVia[]>>;
}

const ACCESS_RECORD = { $or: [{ accessGrantedOn: { $exists: true } }, { status: 'Rejected' }] };

export const getEventAccessRecords = async (
  events: EventAccessSource[],
  viewer: AuthUserInfo
): Promise<EventAccessResult> => {
  const reach = new Map<string, Map<string, AccessVia[]>>();
  if (events.length === 0) return { records: [], reach };

  const ids = events.map((e) => String(e._id));
  const named = new Map(events.map((e) => [String(e._id), [e.assignedUserId, ...(e.assignedUserIds || [])].filter(Boolean).map(String)]));
  const creators = events.map((e) => e.createdBy).filter(Boolean).map(String);
  const isSuperAdmin = viewer.role === 'SuperAdmin';

  // Users: assigned to one of the events, or its creator. An Admin sees only their own.
  const users: any[] = await User.find({
    $and: [
      { $or: [{ assignedEventId: { $in: ids } }, { _id: { $in: [...new Set([...named.values()].flat()), ...creators] } }] },
      ACCESS_RECORD,
      ...(isSuperAdmin ? [] : [{ adminId: viewer.id }]),
    ],
  })
    .populate('assignedEventId', 'eventName')
    .select('-passwordHash')
    .lean();

  const assignedTo = (u: any, eventId: string) =>
    String(u.assignedEventId?._id || u.assignedEventId || '') === eventId || (named.get(eventId) || []).includes(String(u._id));

  // Admins: owners, creators (a Super Admin too), and the managers of assigned Users.
  const adminIds = new Set<string>();
  for (const e of events) {
    if (e.adminId) adminIds.add(String(e.adminId));
    if (e.createdBy) adminIds.add(String(e.createdBy));
  }
  for (const u of users) if (u.adminId && ids.some((id) => assignedTo(u, id))) adminIds.add(String(u.adminId));
  const visibleAdminIds = isSuperAdmin ? [...adminIds] : [...adminIds].filter((id) => id === String(viewer.id));
  const admins: any[] = visibleAdminIds.length
    ? await Admin.find({ _id: { $in: visibleAdminIds }, $or: [...ACCESS_RECORD.$or, { role: 'SuperAdmin' }] })
        .select('-passwordHash')
        .lean()
    : [];

  const add = (accountId: unknown, eventId: string, via: AccessVia) => {
    const key = String(accountId);
    if (!reach.has(key)) reach.set(key, new Map());
    const byEvent = reach.get(key)!;
    if (!byEvent.has(eventId)) byEvent.set(eventId, []);
    if (!byEvent.get(eventId)!.includes(via)) byEvent.get(eventId)!.push(via);
  };

  for (const e of events) {
    const eventId = String(e._id);
    for (const u of users) {
      if (String(u._id) === String(e.createdBy)) add(u._id, eventId, 'Created the event');
      if (assignedTo(u, eventId)) add(u._id, eventId, 'Assigned to the event');
    }
    for (const a of admins) {
      const id = String(a._id);
      // A Super Admin is named only where they created the event.
      if (a.role === 'SuperAdmin' && id !== String(e.createdBy)) continue;
      if (id === String(e.createdBy)) add(id, eventId, 'Created the event');
      else if (id === String(e.adminId)) add(id, eventId, 'Owns the event');
      if (users.some((u) => String(u.adminId) === id && assignedTo(u, eventId))) add(id, eventId, 'Manages an assigned user');
    }
  }

  const records = [
    ...admins.map((a) => ({ ...a, type: a.role === 'SuperAdmin' ? 'SuperAdmin' : 'Admin' })),
    ...users.map((u) => ({
      ...u,
      role: 'User',
      type: 'User',
      assignedEventId: u.assignedEventId ? String(u.assignedEventId._id || u.assignedEventId) : null,
      assignedEventName: u.assignedEventId?.eventName ?? null,
    })),
  ].filter((r) => reach.has(String(r._id)));

  return { records, reach };
};
