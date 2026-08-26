import mongoose, { Document, Schema } from 'mongoose';
import { EventStatus } from '@eventreach/shared';

export interface IEvent extends Document {
  organizerName: string;
  organizerMobile: number;         // LONG — 10-digit number
  eventName: string;               // VARCHAR(20)
  eventType: string;               // VARCHAR(20)
  eventDate: Date;                 // DATE
  eventTime: number;               // TIME stored as minutes since midnight (0–1439)
  eventVenue: string;              // VARCHAR(50)
  eventDescription?: string;       // VARCHAR(256)
  eventStatus: EventStatus;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema: Schema = new Schema(
  {
    organizerName:    { type: String,  required: true, trim: true, maxlength: 50 },
    organizerMobile:  { type: Number,  required: true, min: 1000000000, max: 9999999999 },
    eventName:        { type: String,  required: true, trim: true, maxlength: 20 },
    eventType:        { type: String,  required: true, trim: true, maxlength: 20 },
    eventDate:        { type: Date,    required: true },
    eventTime:        { type: Number,  required: true, min: 0, max: 1439 },   // minutes since midnight
    eventVenue:       { type: String,  required: true, trim: true, maxlength: 50 },
    eventDescription: { type: String,  maxlength: 256 },
    eventStatus: {
      type: String,
      required: true,
      enum: ['Upcoming', 'Completed', 'Cancelled'],
      default: 'Upcoming'
    },
  },
  { timestamps: true }
);

export const Event = mongoose.model<IEvent>('Event', EventSchema);
