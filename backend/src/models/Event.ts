import mongoose, { Document, Schema } from 'mongoose';
import { EventStatus } from '@eventreach/shared';

export interface IEvent extends Document {
  organizerName: string;
  organizerMobile: number;
  name: string;
  type: string;
  date: Date;
  time: string;       // Stored as "HH:MM" — MongoDB has no native TIME type
  venue: string;
  description?: string;
  status: EventStatus;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema: Schema = new Schema(
  {
    organizerName:   { type: String,  required: true, trim: true, maxlength: 50 },
    organizerMobile: { type: Number,  required: true, min: 1000000000, max: 9999999999 }, // 10-digit LONG
    name:            { type: String,  required: true, trim: true, maxlength: 20 },
    type:            { type: String,  required: true, trim: true, maxlength: 20 },
    date:            { type: Date,    required: true },                                    // DATE type
    time:            { type: String,  required: true, match: /^\d{2}:\d{2}$/ },           // TIME as HH:MM
    venue:           { type: String,  required: true, trim: true, maxlength: 50 },
    description:     { type: String,  maxlength: 256 },
    status: {
      type: String,
      required: true,
      enum: ['Upcoming', 'Completed', 'Cancelled'],
      default: 'Upcoming'
    },
  },
  { timestamps: true }
);

export const Event = mongoose.model<IEvent>('Event', EventSchema);
