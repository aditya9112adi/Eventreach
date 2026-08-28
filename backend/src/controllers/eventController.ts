import { Request, Response } from 'express';
import { z } from 'zod';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { getIO } from '../services/socketService';

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

export const createEvent = async (req: Request, res: Response) => {
  try {
    const parsed = eventBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const { organizerMobile, eventDate, eventTime, ...rest } = parsed.data;
    const event = await Event.create({
      ...rest,
      organizerMobile: Number(organizerMobile),
      eventDate: new Date(eventDate + 'T00:00:00.000Z'),
      eventTime: timeToMinutes(eventTime),
    });
    res.status(201).json(serialize(event));
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
};

export const updateExpiredEvents = async () => {
  try {
    const events = await Event.find({ eventStatus: { $nin: ['Completed', 'Cancelled'] } });
    const now = new Date();

    for (const event of events) {
      const dateStr = event.eventDate instanceof Date ? formatDate(event.eventDate) : String(event.eventDate);
      const timeStr = typeof event.eventTime === 'number' ? minutesToTime(event.eventTime) : String(event.eventTime);
      const eventDateTime = new Date(`${dateStr}T${timeStr}:00+05:30`);

      if (eventDateTime < now) {
        event.eventStatus = 'Completed';
        await event.save();
        try {
          getIO().emit('event-status-changed', { eventId: event._id, status: 'Completed' });
          getIO().emit('dashboard-updated');
        } catch (e) {
          console.error('Socket emit error:', e);
        }
      }
    }
  } catch (err) {
    console.error('Error updating expired events:', err);
  }
};

export const getEvents = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();
    const events = await Event.find().sort({ createdAt: -1 }).lean();
    res.json(events.map(serialize));
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getEventById = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();
    const event = await Event.findById(req.params.id).lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const contactCount = await Contact.countDocuments({ eventId: event._id });
    res.json({ ...serialize(event), contactCount });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const updateEvent = async (req: Request, res: Response) => {
  try {
    const parsed = eventBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const { organizerMobile, eventDate, eventTime, ...rest } = parsed.data;
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      {
        ...rest,
        organizerMobile: Number(organizerMobile),
        eventDate: new Date(eventDate + 'T00:00:00.000Z'),
        eventTime: timeToMinutes(eventTime),
      },
      { new: true }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(serialize(event));
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
};
