import { Event } from '../models/Event';
import { User } from '../models/User';

export interface AuthUserInfo {
  id: string;
  email?: string;
  role: string;
}

/**
 * Returns array of authorized event ID strings for the user,
 * or `null` if the user is a SuperAdmin (meaning ALL events are authorized).
 */
export const getAuthorizedEventIds = async (user?: AuthUserInfo): Promise<string[] | null> => {
  if (!user || !user.id) return [];

  // SuperAdmin has unrestricted access to all events
  if (user.role === 'SuperAdmin') {
    return null;
  }

  // Admin access scope:
  // - Events created by this Admin
  // - Events where adminId === this Admin's ID
  // - Events assigned to Users managed by this Admin (user.adminId === this Admin's ID)
  if (user.role === 'Admin') {
    const managedUsers = await User.find({ adminId: user.id })
      .select('_id assignedEventId')
      .lean();

    const managedUserIds = managedUsers.map((u: any) => u._id);
    const userAssignedEventIds = managedUsers
      .map((u: any) => u.assignedEventId ? u.assignedEventId.toString() : null)
      .filter((id): id is string => Boolean(id));

    const events = await Event.find({
      $or: [
        { adminId: user.id },
        { createdBy: user.id },
        { assignedUserId: { $in: managedUserIds } },
        { assignedUserIds: { $in: managedUserIds } },
        { _id: { $in: userAssignedEventIds } },
      ],
    })
      .select('_id')
      .lean();

    const allEventIds = new Set<string>();
    events.forEach((e: any) => allEventIds.add(e._id.toString()));
    userAssignedEventIds.forEach((id) => allEventIds.add(id));

    return Array.from(allEventIds);
  }

  // Regular User access scope:
  // - ONLY the event assigned to this User (user.assignedEventId)
  // - Or events specifically assigned to this User (assignedUserId / assignedUserIds)
  const userDoc = await User.findById(user.id).select('assignedEventId').lean();

  const userEvents = await Event.find({
    $or: [
      { assignedUserId: user.id },
      { assignedUserIds: user.id },
      { createdBy: user.id },
      ...(userDoc && (userDoc as any).assignedEventId ? [{ _id: (userDoc as any).assignedEventId }] : []),
    ],
  })
    .select('_id')
    .lean();

  const eventIds = new Set<string>();
  if (userDoc && (userDoc as any).assignedEventId) {
    eventIds.add((userDoc as any).assignedEventId.toString());
  }
  userEvents.forEach((e: any) => eventIds.add(e._id.toString()));

  return Array.from(eventIds);
};

/**
 * Everyone who can reach one event, by the same rules getAuthorizedEventIds
 * applies from the other side - for the Access Report filtered to an event.
 *
 * Users: assigned to it (assignedEventId, assignedUserId, assignedUserIds) or
 * its creator. Admins: its adminId or creator, and the managing Admin of any
 * User assigned to it - an Admin's scope includes the events of the Users
 * they manage. Two queries whatever the number of people; nothing per user.
 *
 * Returns null when the event does not exist.
 */
export const getEventAccessHolders = async (
  eventId: string
): Promise<{ userIds: string[]; adminIds: string[] } | null> => {
  const event: any = await Event.findById(eventId)
    .select('adminId createdBy assignedUserId assignedUserIds')
    .lean();
  if (!event) return null;

  const named = [event.assignedUserId, ...(event.assignedUserIds || [])].filter(Boolean).map(String);
  const creator = event.createdBy ? String(event.createdBy) : null;

  const users = await User.find({
    $or: [
      { assignedEventId: eventId },
      { _id: { $in: [...named, ...(creator ? [creator] : [])] } },
    ],
  })
    .select('_id adminId assignedEventId')
    .lean();

  const adminIds = new Set<string>([event.adminId, event.createdBy].filter(Boolean).map(String));
  for (const u of users as any[]) {
    const assigned = String(u.assignedEventId || '') === String(eventId) || named.includes(String(u._id));
    // Only an assignment extends to the managing Admin; a User's own event
    // (createdBy) does not, exactly as getAuthorizedEventIds has it.
    if (assigned && u.adminId) adminIds.add(String(u.adminId));
  }

  return { userIds: (users as any[]).map((u) => String(u._id)), adminIds: Array.from(adminIds) };
};

/**
 * The events each Access Report record can reach - getEventAccessHolders read
 * from the other side, for many people at once - so the report can be shown
 * one row per event.
 *
 * Same rules: a User reaches the event they are assigned to (assignedEventId,
 * assignedUserId, assignedUserIds) or created; an Admin reaches the events
 * whose adminId or creator they are, and every event assigned to a User they
 * manage. Two queries whatever the number of people; nothing per record.
 *
 * Returns record id -> event ids. A record that reaches no event is absent.
 */
export const getAccessEventIdsByRecord = async (
  userRecords: Array<{ _id: any; assignedEventId?: any }>,
  adminRecordIds: string[]
): Promise<Map<string, string[]>> => {
  const userIds = userRecords.map((u) => String(u._id));
  const managed: any[] = adminRecordIds.length
    ? await User.find({ adminId: { $in: adminRecordIds } }).select('_id adminId assignedEventId').lean()
    : [];
  const managerOf = new Map<string, string>(managed.map((m) => [String(m._id), String(m.adminId)]));
  const people = Array.from(new Set([...userIds, ...managerOf.keys()]));

  const clauses: any[] = [];
  if (adminRecordIds.length) clauses.push({ adminId: { $in: adminRecordIds } }, { createdBy: { $in: adminRecordIds } });
  if (people.length) clauses.push({ assignedUserId: { $in: people } }, { assignedUserIds: { $in: people } });
  if (userIds.length) clauses.push({ createdBy: { $in: userIds } });
  const events: any[] = clauses.length
    ? await Event.find({ $or: clauses }).select('_id adminId createdBy assignedUserId assignedUserIds').lean()
    : [];

  const reach = new Map<string, Set<string>>();
  const add = (person: unknown, eventId: unknown) => {
    if (!person || !eventId) return;
    const key = String(person);
    if (!reach.has(key)) reach.set(key, new Set());
    reach.get(key)!.add(String(eventId));
  };

  for (const u of userRecords) add(u._id, u.assignedEventId);
  for (const m of managed) add(m.adminId, m.assignedEventId);
  for (const e of events) {
    add(e.adminId, e._id);
    add(e.createdBy, e._id);
    for (const named of [e.assignedUserId, ...(e.assignedUserIds || [])].filter(Boolean)) {
      add(named, e._id);
      add(managerOf.get(String(named)), e._id);
    }
  }

  return new Map(Array.from(reach, ([person, ids]) => [person, Array.from(ids)]));
};

/**
 * Checks if a specific event is within the authorized scope of the user.
 */
export const isEventAuthorized = async (
  user: AuthUserInfo | undefined,
  eventId: string | any
): Promise<boolean> => {
  if (!user || !user.id || !eventId) return false;
  if (user.role === 'SuperAdmin') return true;

  const targetIdStr = eventId.toString();
  const authorizedIds = await getAuthorizedEventIds(user);

  if (authorizedIds === null) return true;
  return authorizedIds.includes(targetIdStr);
};
