import { Request, Response } from 'express';
import { z } from 'zod';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { getIO } from '../services/socketService';

const createEventSchema = z.object({
  organizerName: z.string().min(1, 'Organizer name is required'),
  organizerMobile: z.string().min(1, 'Organizer mobile is required'),
  name: z.string().min(1, 'Name is required'),
  type: z.string().min(1, 'Type is required'),
  date: z.string().min(1, 'Date is required'),
  time: z.string().min(1, 'Time is required'),
  venue: z.string().min(1, 'Venue is required'),
  description: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.date) {
    const now = new Date();
    const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    
    if (data.date < todayStr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Date cannot be in the past",
        path: ['date'],
      });
    } else if (data.date === todayStr && data.time) {
      const currentHours = now.getHours().toString().padStart(2, '0');
      const currentMinutes = now.getMinutes().toString().padStart(2, '0');
      const currentTimeStr = `${currentHours}:${currentMinutes}`;
      
      if (data.time < currentTimeStr) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Time cannot be in the past",
          path: ['time'],
        });
      }
    }
  }
});

const updateEventSchema = z.object({
  organizerName: z.string().min(1, 'Organizer name is required'),
  organizerMobile: z.string().min(1, 'Organizer mobile is required'),
  name: z.string().min(1, 'Name is required'),
  type: z.string().min(1, 'Type is required'),
  date: z.string().min(1, 'Date is required'),
  time: z.string().min(1, 'Time is required'),
  venue: z.string().min(1, 'Venue is required'),
  description: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.date) {
    const now = new Date();
    const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    
    if (data.date < todayStr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Date cannot be in the past",
        path: ['date'],
      });
    } else if (data.date === todayStr && data.time) {
      const currentHours = now.getHours().toString().padStart(2, '0');
      const currentMinutes = now.getMinutes().toString().padStart(2, '0');
      const currentTimeStr = `${currentHours}:${currentMinutes}`;
      
      if (data.time < currentTimeStr) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Time cannot be in the past",
          path: ['time'],
        });
      }
    }
  }
});

export const createEvent = async (req: Request, res: Response) => {
  try {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const event = await Event.create(parsed.data);
    res.status(201).json(event);
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
      // Parse event time explicitly as IST (+05:30)
      const eventDateTime = new Date(`${event.date}T${event.time}:00+05:30`);
      if (eventDateTime < now) {
        event.status = 'Completed';
        await event.save();
        
        // Emit live socket event to notify clients
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
    res.json(events);
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
    
    // Also get contact count for this event
    const contactCount = await Contact.countDocuments({ eventId: event._id });
    
    res.json({ ...event.toObject(), contactCount });
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

    const event = await Event.findByIdAndUpdate(req.params.id, parsed.data, { new: true });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    res.json(event);
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
};




