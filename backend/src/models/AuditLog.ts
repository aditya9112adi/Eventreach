import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
  timestamp: Date;
  actor: {
    userId: string | null;
    email: string | null;
    name: string | null;
    role: string | null;
  };
  action: string;
  collectionName: string;
  documentId: string | null;
  bulkOperationId: string | null;
  requestId: string | null;
  source: string;
  description: string;
  changes: {
    before: any;
    after: any;
    changedFields: string[];
  };
  bulk: {
    isBulk: boolean;
    operationType: string | null;
    totalRecords: number | null;
    successfulRecords: number | null;
    failedRecords: number | null;
    affectedIdsCount: number | null;
  };
  request: {
    ip: string | null;
    userAgent: string | null;
    method: string | null;
    endpoint: string | null;
  };
  metadata: any;
  success: boolean;
  error: {
    message: string | null;
    code: string | null;
  };
}

const auditLogSchema = new Schema(
  {
    timestamp: { type: Date, default: Date.now, required: true },
    actor: {
      userId: { type: String, default: null },
      email: { type: String, default: null },
      name: { type: String, default: null },
      role: { type: String, default: null }
    },
    action: { type: String, required: true },
    collectionName: { type: String, required: true },
    documentId: { type: String, default: null },
    bulkOperationId: { type: String, default: null },
    requestId: { type: String, default: null },
    source: { type: String, default: 'API' },
    description: { type: String, default: '' },
    changes: {
      before: { type: Schema.Types.Mixed, default: null },
      after: { type: Schema.Types.Mixed, default: null },
      changedFields: [{ type: String }]
    },
    bulk: {
      isBulk: { type: Boolean, default: false },
      operationType: { type: String, default: null },
      totalRecords: { type: Number, default: null },
      successfulRecords: { type: Number, default: null },
      failedRecords: { type: Number, default: null },
      affectedIdsCount: { type: Number, default: null }
    },
    request: {
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
      method: { type: String, default: null },
      endpoint: { type: String, default: null }
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    success: { type: Boolean, default: true },
    error: {
      message: { type: String, default: null },
      code: { type: String, default: null }
    }
  },
  { timestamps: false }
);

// Optimize search queries
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ 'actor.userId': 1, timestamp: -1 });
auditLogSchema.index({ collectionName: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ documentId: 1, collectionName: 1, timestamp: -1 });
auditLogSchema.index({ bulkOperationId: 1 });
auditLogSchema.index({ requestId: 1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
