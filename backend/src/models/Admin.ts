import mongoose, { Document, Schema } from 'mongoose';

export interface IAdmin extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: 'SuperAdmin' | 'Admin';
  status: 'Pending' | 'Active' | 'Rejected';
  reportAccessExpiry?: Date;
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
    reportAccessExpiry: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

export const Admin = mongoose.model<IAdmin>('Admin', AdminSchema);
