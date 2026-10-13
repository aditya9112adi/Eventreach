import { Request, Response } from 'express';
import { AuditService } from '../services/AuditService';
import { BulkPocError, applyBulkPocUpdate, maskMobile, previewBulkPocUpdate } from '../services/bulkPocService';

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

/** POST /api/events/poc-bulk - apply it, once, to what was previewed. */
export const applyBulkPoc = async (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await applyBulkPocUpdate((req as any).user, {
      mobile: body.mobile,
      includePast: body.includePast,
      expectedCount: body.expectedCount,
      scopeToken: body.scopeToken,
    });
    const skipped = result.skipped.alreadySet + result.skipped.noLocalPoc + result.skipped.changedMeanwhile;

    await AuditService.log({
      action: 'BULK_EVENT_POC_UPDATED',
      collectionName: 'events',
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      bulkOperationId: result.bulkOperationId,
      bulk: {
        isBulk: true,
        operationType: 'UPDATE',
        totalRecords: result.expected,
        successfulRecords: result.updated,
        failedRecords: result.failed,
      },
      metadata: {
        scope: result.scope.kind,
        includePast: result.includePast,
        newMobile: maskMobile(result.mobile),
        skipped: result.skipped,
        failedBatches: result.failures.length,
      },
      description: `Updated the POC mobile number to ${maskMobile(result.mobile)} on ${result.updated} of ${result.expected} events (${result.scope.label}); ${skipped} skipped, ${result.failed} failed`,
      success: result.failed === 0,
    });

    // As bulk delete: 207 only for a genuinely mixed outcome; nothing written
    // because every batch failed is a plain failure.
    const status = result.failed === 0 ? 200 : result.updated > 0 ? 207 : 500;
    return res.status(status).json(result);
  } catch (error) {
    return sendError(res, error, 'Bulk POC update');
  }
};
