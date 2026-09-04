import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  status: 'Pending' | 'Active' | 'Rejected';
  accessGrantedOn?: Date;
  accessStartDate?: Date;
  accessExpiryDate?: Date;
  accessDurationDays?: number;
  isAccessCancelled?: boolean;
  assignedEventId?: Schema.Types.ObjectId | string;
  adminId?: Schema.Types.ObjectId | string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema: Schema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['Pending', 'Active', 'Rejected'],
      default: 'Pending', // Keeping pending to allow SuperAdmin approval per plan
    },
    accessGrantedOn: { type: Date },
    accessStartDate: { type: Date },
    accessExpiryDate: { type: Date },
    accessDurationValue: { type: Number },
    accessDurationUnit: { type: String, enum: ['minutes', 'hours', 'days'] },
    isAccessCancelled: { type: Boolean, default: false },
    assignedEventId: { type: Schema.Types.ObjectId, ref: 'Event', index: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'Admin', index: true },
  },
  {
    timestamps: true,
  }
);

export const User = mongoose.model<IUser>('User', UserSchema);
