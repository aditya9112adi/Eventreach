import { AuditLog } from '../models/AuditLog';

// Sensitive fields to sanitize
const SENSITIVE_FIELDS = ['password', 'hash', 'token', 'secret', 'passwordHash', 'refreshToken', 'apiKey'];

function sanitizeObject(obj: any): any {
  if (!obj) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);

  const sanitized = { ...obj };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase()) || SENSITIVE_FIELDS.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '***REDACTED***';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeObject(sanitized[key]);
    }
  }
  return sanitized;
}

function getChangedFields(before: any, after: any): string[] {
  if (!before || !after) return [];
  const changed: string[] = [];
  
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push(key);
    }
  }
  return changed;
}

export interface AuditParams {
  action: string;
  collectionName: string;
  documentId?: string | null;
  actor?: {
    userId: string | null;
    email: string | null;
    name: string | null;
    role: string | null;
  } | null;
  request?: {
    requestId: string | null;
    ip: string | null;
    userAgent: string | null;
    method: string | null;
    endpoint: string | null;
  } | null;
  before?: any;
  after?: any;
  description?: string;
  bulkOperationId?: string | null;
  bulk?: {
    isBulk: boolean;
    operationType?: string | null;
    totalRecords?: number | null;
    successfulRecords?: number | null;
    failedRecords?: number | null;
    affectedIdsCount?: number | null;
  };
  metadata?: any;
  success?: boolean;
  error?: { message?: string | null; code?: string | null };
}

export class AuditService {
  static async log(params: AuditParams) {
    if (params.collectionName === 'audit_logs') return; // Prevent infinite loops

    try {
      let changedFields: string[] = [];
      let beforeSanitized = null;
      let afterSanitized = null;

      if (params.before || params.after) {
        beforeSanitized = sanitizeObject(params.before?.toObject ? params.before.toObject() : params.before);
        afterSanitized = sanitizeObject(params.after?.toObject ? params.after.toObject() : params.after);
        changedFields = getChangedFields(beforeSanitized, afterSanitized);
      }

      const logEntry = new AuditLog({
        actor: params.actor || { userId: null, email: null, name: 'System', role: 'SYSTEM' },
        action: params.action,
        collectionName: params.collectionName,
        documentId: params.documentId || null,
        bulkOperationId: params.bulkOperationId || null,
        requestId: params.request?.requestId || null,
        description: params.description || '',
        changes: {
          before: beforeSanitized,
          after: afterSanitized,
          changedFields
        },
        bulk: params.bulk ? { ...params.bulk, isBulk: true } : { isBulk: false },
        request: params.request || {},
        metadata: params.metadata || {},
        success: params.success !== false,
        error: params.error || {}
      });

      await logEntry.save();
    } catch (err) {
      console.error('Audit Logging failed:', err);
      // We do NOT throw here. Audit failures should not crash business logic unless critical.
    }
  }

  static getActorFromReq(req: any) {
    if (!req.user) return null;
    return {
      userId: req.user.id || req.user._id?.toString(),
      email: req.user.email,
      name: req.user.name || req.user.email,
      role: req.user.role
    };
  }

  static getRequestInfo(req: any) {
    return {
      requestId: req.requestId || null,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'],
      method: req.method,
      endpoint: req.originalUrl
    };
  }
}
