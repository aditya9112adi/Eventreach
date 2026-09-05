import { Request, Response } from 'express';
import { z } from 'zod';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { Campaign } from '../models/Campaign';
import { MessageLog } from '../models/MessageLog';
import { User } from '../models/User';
import { getIO } from '../services/socketService';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { getAuthorizedEventIds, isEventAuthorized } from '../services/eventAuthService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const todayIST = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split('T')[0];
};

/** "HH:MM" → minutes since midnight */
const timeToMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** minutes since midnight → "HH:MM" */
const minutesToTime = (mins: number): string => {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};

const formatDate = (d: Date): string =>
  d instanceof Date ? d.toISOString().split('T')[0] : String(d);

/** Serialize DB doc → frontend-friendly object (date as YYYY-MM-DD, time as HH:MM, mobile as string) */
const serialize = (ev: any) => {
  const obj = ev.toObject ? ev.toObject() : { ...ev };
  if (obj.eventDate instanceof Date) obj.eventDate = formatDate(obj.eventDate);
  if (typeof obj.eventTime === 'number') obj.eventTime = minutesToTime(obj.eventTime);
  if (typeof obj.organizerMobile === 'number') obj.organizerMobile = String(obj.organizerMobile);
  return obj;
};

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const eventBody = z.object({
  organizerName:    z.string().min(1, 'Event Organizer is required').max(50, 'Event Organizer max 50 characters'),
  organizerMobile:  z.string().regex(/^\d{10}$/, 'Mobile No must be exactly 10 digits'),
  eventName:        z.string().min(1, 'Event Name is required').max(20, 'Event Name max 20 characters'),
  eventType:        z.string().min(1, 'Event Type is required').max(20, 'Event Type max 20 characters'),
  eventDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Event Date must be YYYY-MM-DD'),
  eventTime:        z.string().regex(/^\d{2}:\d{2}$/, 'Event Time must be HH:MM'),
  eventVenue:       z.string().min(1, 'Event Venue is required').max(50, 'Event Venue max 50 characters'),
  eventDescription: z.string().max(256, 'Event Description max 256 characters').optional(),
  assignedUserId:   z.string().optional(),
}).superRefine((data, ctx) => {
  const today = todayIST();
  if (data.eventDate < today) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Event Date cannot be in the past', path: ['eventDate'] });
  } else if (data.eventDate === today && data.eventTime) {
    const now = new Date();
    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    if (data.eventTime < `${hh}:${mm}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Event Time cannot be in the past', path: ['eventTime'] });
    }
  }
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export const createEvent = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = eventBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const currentUser = (req as any).user;
    const { organizerMobile, eventDate, eventTime, assignedUserId, ...rest } = parsed.data;

    let adminId: string | undefined;
    let finalAssignedUserId: string | undefined = assignedUserId;
    const assignedUserIds: string[] = [];

    if (currentUser?.role === 'Admin') {
      adminId = currentUser.id;
    } else if (currentUser?.role === 'User') {
      finalAssignedUserId = currentUser.id;
      const userDoc = await User.findById(currentUser.id).select('adminId').lean();
      if (userDoc && (userDoc as any).adminId) {
        adminId = (userDoc as any).adminId.toString();
      }
    }

    if (finalAssignedUserId) {
      assignedUserIds.push(finalAssignedUserId);
    }

    const event = await Event.create({
      ...rest,
      organizerMobile: Number(organizerMobile),
      eventDate: new Date(eventDate + 'T00:00:00.000Z'),
      eventTime: timeToMinutes(eventTime),
      createdBy: currentUser?.id,
      creatorModel: currentUser?.role === 'User' ? 'User' : 'Admin',
      adminId,
      assignedUserId: finalAssignedUserId,
      assignedUserIds,
    });

    // If assigned to a user, sync User document
    if (finalAssignedUserId) {
      await User.findByIdAndUpdate(finalAssignedUserId, {
        assignedEventId: event._id,
        ...(adminId ? { adminId } : {}),
      });

      try {
        getIO().to(finalAssignedUserId).emit('EVENT_ASSIGNMENT_CHANGED', {
          assignedEventId: event._id.toString(),
          eventName: event.eventName,
        });
      } catch (socketErr) {
        console.error('Socket emit error on createEvent:', socketErr);
      }
    }

    await AuditService.log({
      action: 'EVENT_CREATED',
      collectionName: 'events',
      documentId: event._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      after: event,
      description: `Created event: ${event.eventName}`,
    });

    res.status(201).json(serialize(event));
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
};

// The expiry sweep used to run inline on every events/dashboard read, scanning
// all open events and issuing a save + audit write + two socket broadcasts per
// expired event. Concurrent requests raced each other and duplicated that work.
// It is now de-duplicated (one sweep at a time), throttled, and batched.
const EXPIRY_SWEEP_INTERVAL_MS = 30_000;
let expirySweepInFlight: Promise<void> | null = null;
let lastExpirySweepAt = 0;

const runExpirySweep = async (): Promise<void> => {
  try {
    const events = await Event.find({ eventStatus: { $nin: ['Completed', 'Cancelled'] } });
    const now = new Date();

    const expired = events.filter((event) => {
      const dateStr = event.eventDate instanceof Date ? formatDate(event.eventDate) : String(event.eventDate);
      const timeStr = typeof event.eventTime === 'number' ? minutesToTime(event.eventTime) : String(event.eventTime);
      return new Date(`${dateStr}T${timeStr}:00+05:30`) < now;
    });

    if (expired.length === 0) return;

    // One round-trip instead of one save per document.
    await Event.bulkWrite(
      expired.map((event) => ({
        updateOne: {
          filter: { _id: event._id, eventStatus: { $nin: ['Completed', 'Cancelled'] } },
          update: { $set: { eventStatus: 'Completed' } },
        },
      }))
    );

    for (const event of expired) {
      await AuditService.log({
        action: 'EVENT_COMPLETED',
        collectionName: 'events',
        documentId: event._id.toString(),
        before: { ...event.toObject() },
        after: { ...event.toObject(), eventStatus: 'Completed' },
        description: `Event automatically marked as completed: ${event.eventName}`
      });
    }

    try {
      const socket = getIO();
      for (const event of expired) {
        socket.emit('event-status-changed', { eventId: event._id, status: 'Completed' });
      }
      // A single dashboard refresh covers the whole batch.
      socket.emit('dashboard-updated');
    } catch (e) {
      console.error('Socket emit error:', e);
    }
  } catch (err) {
    console.error('Error updating expired events:', err);
  }
};

export const updateExpiredEvents = async (force = false): Promise<void> => {
  // Join an in-progress sweep rather than starting a second one.
  if (expirySweepInFlight) return expirySweepInFlight;
  if (!force && Date.now() - lastExpirySweepAt < EXPIRY_SWEEP_INTERVAL_MS) return;

  expirySweepInFlight = runExpirySweep().finally(() => {
    lastExpirySweepAt = Date.now();
    expirySweepInFlight = null;
  });

  return expirySweepInFlight;
};

export const getEvents = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();

    const currentUser = (req as any).user;
    const authorizedIds = await getAuthorizedEventIds(currentUser);

    const query: any = {};
    if (authorizedIds !== null) {
      query._id = { $in: authorizedIds };
    }

    const events = await Event.find(query).sort({ createdAt: -1 }).lean();
    res.json(events.map(serialize));
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getEventById = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, req.params.id);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const event = await Event.findById(req.params.id).lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const contactCount = await Contact.countDocuments({ eventId: event._id });
    res.json({ ...serialize(event), contactCount });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const updateEvent = async (req: RequestWithId, res: Response) => {
  try {
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, req.params.id);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const parsed = eventBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const beforeEvent = await Event.findById(req.params.id);
    if (!beforeEvent) return res.status(404).json({ error: 'Event not found' });

    const { organizerMobile, eventDate, eventTime, assignedUserId, ...rest } = parsed.data;

    const updatePayload: any = {
      ...rest,
      organizerMobile: Number(organizerMobile),
      eventDate: new Date(eventDate + 'T00:00:00.000Z'),
      eventTime: timeToMinutes(eventTime),
    };

    if (assignedUserId !== undefined) {
      updatePayload.assignedUserId = assignedUserId || null;
      if (assignedUserId) {
        updatePayload.$addToSet = { assignedUserIds: assignedUserId };
      }
    }

    const event = await Event.findByIdAndUpdate(
      req.params.id,
      updatePayload,
      { new: true }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Sync user's assignedEventId if assignment changed
    if (assignedUserId && assignedUserId !== (beforeEvent as any).assignedUserId?.toString()) {
      await User.findByIdAndUpdate(assignedUserId, { assignedEventId: event._id });
      try {
        getIO().to(assignedUserId).emit('EVENT_ASSIGNMENT_CHANGED', {
          assignedEventId: event._id.toString(),
          eventName: event.eventName,
        });
      } catch (socketErr) {
        console.error('Socket emit error on updateEvent:', socketErr);
      }
    }

    await AuditService.log({
      action: 'EVENT_UPDATED',
      collectionName: 'events',
      documentId: event._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: beforeEvent,
      after: event,
      description: `Updated event: ${event.eventName}`
    });

    res.json(serialize(event));
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
};

export const deleteEvent = async (req: RequestWithId, res: Response) => {
  try {
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, req.params.id);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Unassign all users linked to this event
    const affectedUsers = await User.find({ assignedEventId: event._id }).select('_id');
    await User.updateMany({ assignedEventId: event._id }, { $unset: { assignedEventId: 1 } });

    await Event.findByIdAndDelete(req.params.id);

    // Notify affected users in real time
    for (const user of affectedUsers) {
      try {
        getIO().to(user._id.toString()).emit('EVENT_ASSIGNMENT_CHANGED', {
          assignedEventId: null,
          eventName: null,
        });
      } catch (err) {
        console.error('Socket emit error on deleteEvent:', err);
      }
    }

    await AuditService.log({
      action: 'EVENT_DELETED',
      collectionName: 'events',
      documentId: event._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: event,
      description: `Deleted event: ${event.eventName}`,
    });

    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
};

export const getEventUsers = async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, req.params.id);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const users = await User.find({
      $or: [
        { assignedEventId: req.params.id },
      ],
    })
      .select('-passwordHash')
      .lean();

    res.json(users);
  } catch (error) {
    console.error('Get event users error:', error);
    res.status(500).json({ error: 'Failed to fetch event users' });
  }
};

export const getEventStatistics = async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, req.params.id);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const eventId = req.params.id;
    const contactCount = await Contact.countDocuments({ eventId });
    const campaigns = await Campaign.find({ eventId }).select('_id');
    const campaignIds = campaigns.map((c) => c._id);

    const messageMatchQuery = campaignIds.length > 0 ? { campaignId: { $in: campaignIds } } : { campaignId: null };

    const messageStats = await MessageLog.aggregate([
      { $match: messageMatchQuery },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const msgBreakdown: Record<string, number> = {
      Sent: 0, Delivered: 0, Failed: 0, Pending: 0
    };
    messageStats.forEach((s: any) => {
      if (msgBreakdown[s._id] !== undefined) msgBreakdown[s._id] = s.count;
    });

    res.json({
      eventId,
      totalContacts: contactCount,
      totalCampaigns: campaigns.length,
      messagesSent: msgBreakdown.Sent,
      messagesDelivered: msgBreakdown.Delivered,
      messagesFailed: msgBreakdown.Failed,
      messagesPending: msgBreakdown.Pending,
    });
  } catch (error) {
    console.error('Get event statistics error:', error);
    res.status(500).json({ error: 'Failed to fetch event statistics' });
  }
};
