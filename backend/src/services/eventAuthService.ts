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
