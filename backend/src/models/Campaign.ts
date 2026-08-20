import mongoose, { Schema, Document } from 'mongoose';

export interface IMediaAttachment {
  url: string;
  type: 'image' | 'video' | 'audio' | 'document';
  filename: string;
}

export interface ICampaign extends Document {
  eventId: mongoose.Types.ObjectId;
  messageText: string;
  mediaAttachments: IMediaAttachment[];
  status: 'Draft' | 'Scheduled' | 'Sending' | 'Completed';
  createdAt: Date;
  updatedAt: Date;
}

const mediaAttachmentSchema = new Schema({
  url: { type: String, required: true },
  type: { type: String, enum: ['image', 'video', 'audio', 'document'], required: true },
  filename: { type: String, required: true },
});

const campaignSchema = new Schema(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      unique: true // 1-to-1 relationship for now: one campaign per event in the MVP
    },
    messageText: {
      type: String,
      default: ''
    },
    mediaAttachments: [mediaAttachmentSchema],
    status: {
      type: String,
      enum: ['Draft', 'Scheduled', 'Sending', 'Completed'],
      default: 'Draft'
    }
  },
  { timestamps: true }
);

export const Campaign = mongoose.model<ICampaign>('Campaign', campaignSchema);
