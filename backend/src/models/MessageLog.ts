import mongoose, { Schema, Document } from 'mongoose';

export interface IMessageLog extends Document {
  campaignId: mongoose.Types.ObjectId;
  contactId: mongoose.Types.ObjectId;
  phoneNumber: string;
  status: 'Pending' | 'Sent' | 'Delivered' | 'Failed';
  errorReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const messageLogSchema = new Schema(
  {
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
      index: true
    },
    contactId: {
      type: Schema.Types.ObjectId,
      ref: 'Contact',
      required: true
    },
    phoneNumber: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['Pending', 'Sent', 'Delivered', 'Failed'],
      default: 'Pending'
    },
    errorReason: {
      type: String
    }
  },
  { timestamps: true }
);

export const MessageLog = mongoose.model<IMessageLog>('MessageLog', messageLogSchema);
