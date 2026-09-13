import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';

// Sensitive fields to sanitize
const SENSITIVE_FIELDS = ['password', 'hash', 'token', 'secret', 'passwordHash', 'refreshToken', 'apiKey'];

/**
 * True for a BSON Int64. Event.organizerMobile hydrates as a native `bigint`
 * through Mongoose; a document read through the raw driver can also hand
 * back a BSON Long instance instead — both need the same handling here.
 */
const isBsonLong = (v: any): boolean => !!v && typeof v === 'object' && mongoose.mongo.Long.isLong(v);

/**
 * True only for a plain object literal or a Mongoose lean()/toObject() result
 * — never for a Date, ObjectId, Buffer or other class instance that also
 * happens to be `typeof === 'object'`. That distinction matters: recursing
 * into one of those with a naive `{...obj}` spread destroys it, because its
 * real value lives outside its own enumerable properties (a Date spreads to
 * `{}`; an ObjectId spreads to its raw buffer bytes).
 */
const isPlainObject = (v: any): boolean => {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Deep-clones audit data into a form that is always safe to JSON.stringify
 * (used below for change-detection) and to store in a Mixed field, redacting
 * sensitive keys at any depth.
 *
 * - bigint and BSON Long (organizerMobile, BSON Int64) become a decimal
 *   string — never a Number, which would silently lose precision past 2^53 —
 *   and JSON.stringify throws outright on a raw bigint, so this must happen
 *   before anything here reaches it.
 * - Date, ObjectId, Buffer and any other non-plain object are returned
 *   exactly as they are: see isPlainObject for why recursing into them would
 *   corrupt them instead.
 * - Arrays and plain objects are walked recursively, so a BigInt or a Date
 *   nested at any depth (e.g. inside mediaAttachments, or a bulk snapshot
 *   array) is handled the same way as one at the top level.
 */
function sanitizeObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint' || isBsonLong(obj)) return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (!isPlainObject(obj)) return obj; // Date, ObjectId, Buffer, etc. — left intact

  const sanitized: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase()) || SENSITIVE_FIELDS.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '***REDACTED***';
    } else {
      sanitized[key] = sanitizeObject(obj[key]);
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
        // No current caller puts a raw document here, but metadata is Mixed
        // just like changes.before/after — sanitized the same way in case a
        // future caller ever does.
        metadata: sanitizeObject(params.metadata) || {},
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
