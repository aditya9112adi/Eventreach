import { Request, Response } from 'express';
import { z } from 'zod';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';

const createEventSchema = z.object({
  organizerName: z.string().min(1, 'Organizer name is required'),
  organizerMobile: z.string().min(1, 'Organizer mobile is required'),
  name: z.string().min(1, 'Name is required'),
  type: z.string().min(1, 'Type is required'),
  date: z.string().min(1, 'Date is required'),
  time: z.string().min(1, 'Time is required'),
  venue: z.string().min(1, 'Venue is required'),
  description: z.string().optional(),
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

export const getEvents = async (req: Request, res: Response) => {
  try {
    const events = await Event.find().sort({ createdAt: -1 });
    res.json(events);
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getEventById = async (req: Request, res: Response) => {
  try {
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
