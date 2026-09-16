import { Request, Response } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
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

/** minutes since midnight → "HH:MM" (legacy representation, see below) */
const minutesToTime = (mins: number): string => {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};

/**
 * Combine a "YYYY-MM-DD" date and a "HH:MM" time into the absolute instant
 * that time represents in India Standard Time (UTC+5:30, no DST). This is
 * what gets stored directly in eventTime, and mirrors the interpretation the
 * app has always used when comparing an event's date+time to "now" (see
 * runExpirySweep below).
 */
const combineISTDateTime = (dateStr: string, timeStr: string): Date =>
  new Date(`${dateStr}T${timeStr}:00+05:30`);

/**
 * The reverse of combineISTDateTime: extract the IST wall-clock "HH:MM" from
 * an absolute instant. India has a fixed UTC+5:30 offset with no DST, so
 * shifting the instant forward by that amount and reading the UTC time-of-day
 * back off it gives the correct IST wall-clock time.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istTimeOfDay = (d: Date): string =>
  new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);

const formatDate = (d: Date): string =>
  d instanceof Date ? d.toISOString().split('T')[0] : String(d);

/** Serialize DB doc → frontend-friendly object (date as YYYY-MM-DD, time as HH:MM, mobile as string) */
const serialize = (ev: any) => {
  const obj = ev.toObject ? ev.toObject() : { ...ev };
  if (obj.eventDate instanceof Date) obj.eventDate = formatDate(obj.eventDate);
  /**
   * eventTime is BSON Date (the complete event date+time, IST) since the
   * hardening migration. A document created before that migration ran still
   * legitimately holds the old representation (minutes since midnight) — both
   * are handled here during that transition window.
   */
  if (obj.eventTime instanceof Date) obj.eventTime = istTimeOfDay(obj.eventTime);
  else if (typeof obj.eventTime === 'number') obj.eventTime = minutesToTime(obj.eventTime);
  /**
   * organizerMobile is BSON Int64 (a JS bigint once hydrated). The API has
   * always exposed it as a string, so it is rendered back here.
   *
   * This must not be skipped: JSON.stringify throws outright on a bigint, so
   * leaving one in the payload would fail the whole response. The number and
   * string branches cover documents written before the migration converges the
   * column — during that window the collection legitimately holds all three.
   */
  const m = obj.organizerMobile;
  if (typeof m === 'bigint' || typeof m === 'number') obj.organizerMobile = String(m);
  return obj;
};

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const eventBody = z.object({
  organizerName:    z.string().min(1, 'Event Organizer is required').max(50, 'Event Organizer max 50 characters'),
  organizerMobile:  z.string().regex(/^\d{10}$/, 'Mobile No must be exactly 10 digits'),
  eventName:        z.string().min(1, 'Event Name is required').max(20, 'Event Name max 20 characters'),
  eventType:        z.string().min(1, 'Event Type is required').max(20, 'Event Type max 20 characters'),
  eventDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Event Date must be YYYY-MM-DD')
                     .refine((v) => {
                       const d = new Date(v + 'T00:00:00.000Z');
                       return !Number.isNaN(d.getTime()) && v === d.toISOString().slice(0, 10);
                     }, 'Event Date is not a real calendar date'),
  eventTime:        z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Event Time must be a valid HH:MM (00:00–23:59)'),
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
      // Zod already proved this is exactly ten digits; store it as BSON Int64.
      organizerMobile: BigInt(organizerMobile),
      eventDate: new Date(eventDate + 'T00:00:00.000Z'),
      eventTime: combineISTDateTime(eventDate, eventTime),
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
      if (event.eventTime instanceof Date) return event.eventTime < now;
      // Legacy fallback for a document the hardening migration hasn't reached
      // yet (eventTime still minutes-since-midnight, Int32).
      const dateStr = event.eventDate instanceof Date ? formatDate(event.eventDate) : String(event.eventDate);
      const timeStr = typeof event.eventTime === 'number' ? minutesToTime(event.eventTime) : String(event.eventTime);
      return combineISTDateTime(dateStr, timeStr) < now;
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

    // These entries are independent of one another — each records a different
    // event — and AuditService.log never throws, so writing them one at a time
    // only added round trips. They are written in bounded batches rather than
    // all at once so a large sweep cannot open an unbounded number of
    // simultaneous writes; the batch size matches QueueService.
    const AUDIT_BATCH_SIZE = 10;
    for (let i = 0; i < expired.length; i += AUDIT_BATCH_SIZE) {
      const batch = expired.slice(i, i + AUDIT_BATCH_SIZE);
      await Promise.all(
        batch.map((event: any) =>
          AuditService.log({
            action: 'EVENT_COMPLETED',
            collectionName: 'events',
            documentId: event._id.toString(),
            before: { ...event.toObject() },
            after: { ...event.toObject(), eventStatus: 'Completed' },
            description: `Event automatically marked as completed: ${event.eventName}`
          })
        )
      );
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
      // Zod already proved this is exactly ten digits; store it as BSON Int64.
      organizerMobile: BigInt(organizerMobile),
      eventDate: new Date(eventDate + 'T00:00:00.000Z'),
      eventTime: combineISTDateTime(eventDate, eventTime),
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

/**
 * Deletes one event and everything that has to happen alongside it: users
 * assigned to it are unassigned and told so over the socket, and the deletion
 * is written to the audit log.
 *
 * Extracted so the single and bulk endpoints cannot drift apart. Bulk deletion
 * is the same operation repeated, so it must produce the same per-event audit
 * trail — one EVENT_DELETED record naming the event, not a single lump entry
 * that loses which events went.
 *
 * The caller is responsible for authorizing the event first.
 */
const performEventDeletion = async (
  event: any,
  req: RequestWithId,
  bulkContext?: { bulkOperationId: string }
): Promise<void> => {
  // Unassign all users linked to this event
  const affectedUsers = await User.find({ assignedEventId: event._id }).select('_id');
  await User.updateMany({ assignedEventId: event._id }, { $unset: { assignedEventId: 1 } });

  await Event.findByIdAndDelete(event._id);

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
    ...(bulkContext ? { bulkOperationId: bulkContext.bulkOperationId } : {}),
  });
};

export const deleteEvent = async (req: RequestWithId, res: Response) => {
  try {
    // A malformed id used to reach Event.findById and throw a CastError, which
    // surfaced as a 500. The request is simply bad, so it is rejected as one.
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid event id' });
    }

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, req.params.id);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    await performEventDeletion(event, req);

    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
};

/** Bulk delete accepts a bounded list of ids in one request. */
const bulkDeleteBody = z.object({
  ids: z
    .array(z.string())
    .min(1, 'Select at least one event to delete')
    // A ceiling keeps one request from tying up the process indefinitely; the
    // UI pages at 100 rows, so a full page always fits in a single call.
    .max(100, 'Cannot delete more than 100 events in one request'),
});

/**
 * Deletes several events in one request.
 *
 * Every id is authorized and deleted individually — a caller cannot widen
 * their own access by batching — and each failure is reported against its own
 * id rather than failing the whole batch. The response is 207 when some ids
 * succeeded and others did not, so the client can avoid telling the user that
 * an event was removed when it was not.
 */
export const bulkDeleteEvents = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = bulkDeleteBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    // Duplicates in the payload would otherwise be reported as "not found" the
    // second time around, which reads as a failure that did not happen.
    const ids = Array.from(new Set(parsed.data.ids));
    const currentUser = (req as any).user;
    const bulkOperationId = `BULK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    const deletedIds: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of ids) {
      try {
        if (!mongoose.Types.ObjectId.isValid(id)) {
          failed.push({ id, reason: 'Invalid event id' });
          continue;
        }
        if (!(await isEventAuthorized(currentUser, id))) {
          failed.push({ id, reason: 'Access denied' });
          continue;
        }
        const event = await Event.findById(id);
        if (!event) {
          failed.push({ id, reason: 'Event not found' });
          continue;
        }

        await performEventDeletion(event, req, { bulkOperationId });
        deletedIds.push(id);
      } catch (err) {
        // One bad event must not abort the rest of the batch.
        console.error(`Bulk delete failed for event ${id}:`, err);
        failed.push({ id, reason: 'Failed to delete event' });
      }
    }

    // A summary entry alongside the per-event records, matching how bulk
    // contact imports are logged.
    await AuditService.log({
      action: 'BULK_EVENT_DELETED',
      collectionName: 'events',
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      bulkOperationId,
      bulk: {
        isBulk: true,
        operationType: 'DELETE',
        totalRecords: ids.length,
        successfulRecords: deletedIds.length,
        failedRecords: failed.length,
      },
      description: `Bulk deleted ${deletedIds.length} of ${ids.length} events`,
      success: failed.length === 0,
    });

    // 207 only when the outcome is genuinely mixed; an all-failed batch is a
    // plain failure and should not be dressed up as a partial success.
    const status = failed.length === 0 ? 200 : deletedIds.length === 0 ? 400 : 207;
    res.status(status).json({
      deletedCount: deletedIds.length,
      deletedIds,
      failed,
    });
  } catch (error) {
    console.error('Bulk delete events error:', error);
    res.status(500).json({ error: 'Failed to delete events' });
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
