import { Request, Response } from 'express';
import { AuditService } from '../services/AuditService';
import { BulkPocError, applyBulkPocUpdate, previewBulkPocUpdate } from '../services/bulkPocService';

/**
 * Bulk POC mobile update (bulkPocService). The number travels in the request
 * body, never the URL, and is masked in the audit entry.
 */

const sendError = (res: Response, error: unknown, context: string) => {
  if (error instanceof BulkPocError) {
    return res.status(error.httpStatus).json({ error: error.message, code: error.code, ...(error.details ?? {}) });
  }
  console.error(`${context} failed:`, (error as any)?.message || 'unknown error');
  return res.status(500).json({ error: 'Failed to update POC numbers', code: 'INTERNAL_ERROR' });
};

/** POST /api/events/poc-bulk/preview - what one confirmation would change. Writes nothing. */
export const previewBulkPoc = async (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    return res.json(await previewBulkPocUpdate((req as any).user, { mobile: body.mobile, includePast: body.includePast }));
  } catch (error) {
    return sendError(res, error, 'Bulk POC preview');
  }
};

/**
 * POST /api/events/poc-bulk - apply it, once, to what was previewed. The
 * service owns the run's audit entries and recovery data; this maps the
 * outcome to a status. 207 means anything other than a clean, fully recorded
 * success: some events failed, or the outcome record could not be saved.
 */
export const applyBulkPoc = async (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await applyBulkPocUpdate(
      (req as any).user,
      { mobile: body.mobile, includePast: body.includePast, expectedCount: body.expectedCount, scopeToken: body.scopeToken },
      { auditContext: { actor: AuditService.getActorFromReq(req), request: AuditService.getRequestInfo(req) } }
    );
    // As bulk delete: nothing written because every batch failed is a plain failure.
    const status = result.failed === 0 ? (result.audit.completed ? 200 : 207) : result.updated > 0 ? 207 : 500;
    return res.status(status).json(result);
  } catch (error) {
    return sendError(res, error, 'Bulk POC update');
  }
};
