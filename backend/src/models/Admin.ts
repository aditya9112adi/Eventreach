import mongoose, { Document, Schema } from 'mongoose';

export interface IAdmin extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: 'SuperAdmin' | 'Admin';
  status: 'Pending' | 'Active' | 'Rejected';
  accessGrantedOn?: Date;
  accessStartDate?: Date;
  accessExpiryDate?: Date;
  accessDurationDays?: number;
  isAccessCancelled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AdminSchema: Schema = new Schema(
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
    role: {
      type: String,
      enum: ['SuperAdmin', 'Admin'],
      default: 'Admin',
    },
    status: {
      type: String,
      enum: ['Pending', 'Active', 'Rejected'],
      default: 'Pending',
    },
    accessGrantedOn: { type: Date },
    accessStartDate: { type: Date },
    accessExpiryDate: { type: Date },
    accessDurationValue: { type: Number },
    accessDurationUnit: { type: String, enum: ['minutes', 'hours', 'days'] },
    isAccessCancelled: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

export const Admin = mongoose.model<IAdmin>('Admin', AdminSchema);
