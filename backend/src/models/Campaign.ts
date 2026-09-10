import mongoose, { Schema, Document } from 'mongoose';

export interface IMediaAttachment {
  url: string;
  type: 'image' | 'video' | 'audio' | 'document';
  filename: string;
}

export interface IMessageHistory {
  messageText: string;
  mediaAttachments: IMediaAttachment[];
  sentAt: Date;
}

export interface ICampaign extends Document {
  eventId: mongoose.Types.ObjectId;
  messageText: string;
  mediaAttachments: IMediaAttachment[];
  status: 'Draft' | 'Scheduled' | 'Sending' | 'Completed';
  history: IMessageHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const mediaAttachmentSchema = new Schema<IMediaAttachment>(
  {
    url: { type: String, required: true, trim: true },
    type: { type: String, enum: ['image', 'video', 'audio', 'document'], required: true },
    filename: { type: String, required: true, trim: true },
  },
  { _id: false }
);

/**
 * Sent-message history. Previously declared inline, which meant the attachment
 * shape here was a second, looser definition than the one used for the live
 * draft. It now reuses mediaAttachmentSchema so both are validated identically.
 */
const messageHistorySchema = new Schema<IMessageHistory>(
  {
    messageText: { type: String, default: '' },
    mediaAttachments: { type: [mediaAttachmentSchema], default: [] },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const campaignSchema = new Schema(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      unique: true // 1-to-1 relationship for now: one campaign per event in the MVP
    },
    // No maximum length: none exists in the UI or API today, and imposing one
    // could reject drafts that already exist. The migration's dry-run reports
    // the longest stored value so a limit can be chosen deliberately later.
    messageText: {
      type: String,
      default: ''
    },
    mediaAttachments: { type: [mediaAttachmentSchema], default: [] },
    status: {
      type: String,
      required: true,
      enum: ['Draft', 'Scheduled', 'Sending', 'Completed'],
      default: 'Draft'
    },
    history: { type: [messageHistorySchema], default: [] }
  },
  { timestamps: true }
);

export const Campaign = mongoose.model<ICampaign>('Campaign', campaignSchema);
