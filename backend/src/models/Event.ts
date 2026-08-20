import mongoose, { Document, Schema } from 'mongoose';
import { EventStatus } from '@eventreach/shared';

export interface IEvent extends Document {
  name: string;
  type: string;
  date: string;
  time: string;
  venue: string;
  description?: string;
  status: EventStatus;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema: Schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true },
    date: { type: String, required: true },
    time: { type: String, required: true },
    venue: { type: String, required: true },
    description: { type: String },
    status: { 
      type: String, 
      required: true, 
      enum: ['Draft', 'Upcoming', 'Completed', 'Cancelled'],
      default: 'Draft' 
    },
  },
  { timestamps: true }
);

export const Event = mongoose.model<IEvent>('Event', EventSchema);
