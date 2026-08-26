import { Request, Response } from 'express';
import { z } from 'zod';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { getIO } from '../services/socketService';

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Return today's date string in YYYY-MM-DD (IST-aware) */
const todayIST = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .split('T')[0];
};

/** Convert a YYYY-MM-DD string to a UTC midnight Date for storage */
const toDateObj = (dateStr: string): Date => new Date(dateStr + 'T00:00:00.000Z');

/** Format a stored Date back to YYYY-MM-DD for frontend consumption */
export const formatDateToString = (d: Date): string =>
  d instanceof Date ? d.toISOString().split('T')[0] : String(d);

/** Serialize an event document so date → YYYY-MM-DD string and mobile → string */
const serializeEvent = (ev: any) => {
  const obj = ev.toObject ? ev.toObject() : { ...ev };
  if (obj.date instanceof Date) obj.date = formatDateToString(obj.date);
  if (typeof obj.organizerMobile === 'number') obj.organizerMobile = String(obj.organizerMobile);
  return obj;
};

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const eventBody = z.object({
  organizerName:   z.string().min(1, 'Event Organizer is required').max(50, 'Event Organizer must be at most 50 characters'),
  organizerMobile: z.string().regex(/^\d{10}$/, 'Mobile No must be exactly 10 digits'),
  name:            z.string().min(1, 'Event Name is required').max(20, 'Event Name must be at most 20 characters'),
  type:            z.string().min(1, 'Event Type is required').max(20, 'Event Type must be at most 20 characters'),
  date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Event Date must be in YYYY-MM-DD format'),
  time:            z.string().regex(/^\d{2}:\d{2}$/, 'Event Time must be in HH:MM format'),
  venue:           z.string().min(1, 'Event Venue is required').max(50, 'Event Venue must be at most 50 characters'),
  description:     z.string().max(256, 'Event Description must be at most 256 characters').optional(),
}).superRefine((data, ctx) => {
  const today = todayIST();
  if (data.date < today) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Event Date cannot be in the past', path: ['date'] });
  } else if (data.date === today && data.time) {
    const now = new Date();
    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');
    if (data.time < `${hh}:${mm}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Event Time cannot be in the past', path: ['time'] });
    }
  }
});

const createEventSchema = eventBody;
const updateEventSchema = eventBody;

// ─── Controllers ─────────────────────────────────────────────────────────────

export const createEvent = async (req: Request, res: Response) => {
  try {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { organizerMobile, date, ...rest } = parsed.data;
    const event = await Event.create({
      ...rest,
      organizerMobile: Number(organizerMobile),   // String → Number (LONG)
      date: toDateObj(date),                       // String → Date
    });
    res.status(201).json(serializeEvent(event));
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
};

export const updateExpiredEvents = async () => {
  try {
    const events = await Event.find({ status: { $nin: ['Completed', 'Cancelled'] } });
    const now = new Date();

    for (const event of events) {
      const dateStr = event.date instanceof Date
        ? formatDateToString(event.date)
        : String(event.date);
      const eventDateTime = new Date(`${dateStr}T${event.time}:00+05:30`);

      if (eventDateTime < now) {
        event.status = 'Completed';
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
    const events = await Event.find().sort({ createdAt: -1 });
    res.json(events.map(serializeEvent));
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getEventById = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const contactCount = await Contact.countDocuments({ eventId: event._id });
    res.json({ ...serializeEvent(event), contactCount });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const updateEvent = async (req: Request, res: Response) => {
  try {
    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { organizerMobile, date, ...rest } = parsed.data;
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      {
        ...rest,
        organizerMobile: Number(organizerMobile),
        date: toDateObj(date),
      },
      { new: true }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(serializeEvent(event));
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
};
