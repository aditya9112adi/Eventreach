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
  pendingAccessStartDate?: Date;
  pendingAccessEndDate?: Date;
  rejectionReason?: string;
  // Approval / rejection audit trail. All timestamps are generated server-side.
  approvedAt?: Date;
  approvedBy?: Schema.Types.ObjectId | string;
  rejectedAt?: Date;
  rejectedBy?: Schema.Types.ObjectId | string;
  /** Set on every password change so tokens issued earlier stop being accepted. */
  passwordChangedAt?: Date;
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
    // Requested by Admin during registration, used by SuperAdmin on approval
    pendingAccessStartDate: { type: Date },
    pendingAccessEndDate: { type: Date },
    rejectionReason: { type: String },
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    rejectedAt: { type: Date },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    passwordChangedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

export const Admin = mongoose.model<IAdmin>('Admin', AdminSchema);
