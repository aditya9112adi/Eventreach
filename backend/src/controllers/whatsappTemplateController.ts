import { Request, Response } from 'express';
import {
  TemplateServiceError,
  createTemplateDraft,
  deleteTemplateDraft,
  getTemplate,
  listAccountTemplates,
  listTemplates,
  reconcileTemplate,
  refreshTemplateStatus,
  reviewTemplateSubmission,
  submitTemplate,
  updateTemplateDraft,
  type TemplateActor,
} from '../services/templateService';

/**
 * HTTP for WhatsApp template management, under /api/whatsapp/templates.
 *
 * Deliberately thin: who may do what is decided in services/templateService,
 * from the database, on every call. The caller passed down is the account
 * requireAuth re-read; nothing about roles or permissions is taken from the
 * request body. Errors use the same shape as the other WhatsApp endpoints:
 * { success: false, error: { code, message, errors? } }.
 */

const actorOf = (req: Request): TemplateActor => {
  const user = (req as any).user ?? {};
  return { id: String(user.id ?? ''), email: user.email, role: user.role, name: user.name };
};

const fail = (res: Response, error: unknown, context: string) => {
  if (error instanceof TemplateServiceError) return res.status(error.httpStatus).json(error.toResponse());
  console.error(`WhatsApp templates: ${context} failed:`, (error as any)?.message || error);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
};

const requireBodyObject = (req: Request, res: Response): boolean => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'The request body must be a JSON object.' } });
    return false;
  }
  return true;
};

export const listTemplatesHandler = async (req: Request, res: Response) => {
  try {
    res.json(await listTemplates(actorOf(req), req.query));
  } catch (error) {
    fail(res, error, 'list');
  }
};

export const getTemplateHandler = async (req: Request, res: Response) => {
  try {
    res.json({ template: await getTemplate(actorOf(req), req.params.id) });
  } catch (error) {
    fail(res, error, 'read');
  }
};

export const createTemplateHandler = async (req: Request, res: Response) => {
  if (!requireBodyObject(req, res)) return;
  try {
    res.status(201).json({ template: await createTemplateDraft(actorOf(req), req.body) });
  } catch (error) {
    fail(res, error, 'create');
  }
};

export const updateTemplateHandler = async (req: Request, res: Response) => {
  if (!requireBodyObject(req, res)) return;
  try {
    res.json({ template: await updateTemplateDraft(actorOf(req), req.params.id, req.body) });
  } catch (error) {
    fail(res, error, 'update');
  }
};

export const deleteTemplateHandler = async (req: Request, res: Response) => {
  try {
    await deleteTemplateDraft(actorOf(req), req.params.id);
    res.status(204).end();
  } catch (error) {
    fail(res, error, 'delete');
  }
};

/** One page of the account's templates as Meta lists them. Read only. */
export const listAccountTemplatesHandler = async (req: Request, res: Response) => {
  try {
    res.json(await listAccountTemplates(actorOf(req), { after: req.query.after, limit: req.query.limit }));
  } catch (error) {
    fail(res, error, 'account list');
  }
};

/** The exact payload a submission would send, and a hash to confirm it with. Sends nothing. */
export const reviewTemplateHandler = async (req: Request, res: Response) => {
  try {
    res.json(await reviewTemplateSubmission(actorOf(req), req.params.id));
  } catch (error) {
    fail(res, error, 'review');
  }
};

/**
 * Every recorded outcome is a 200 with `outcome`; refused requests are 4xx/5xx.
 * The body must carry the hash of the payload the person reviewed.
 */
export const submitTemplateHandler = async (req: Request, res: Response) => {
  const hash = req.body && typeof req.body === 'object' ? (req.body as any).confirmPayloadHash : undefined;
  try {
    res.json(
      await submitTemplate(actorOf(req), req.params.id, {}, { requireConfirmation: true, confirmPayloadHash: typeof hash === 'string' && hash ? hash : undefined })
    );
  } catch (error) {
    fail(res, error, 'submit');
  }
};

export const reconcileTemplateHandler = async (req: Request, res: Response) => {
  try {
    res.json(await reconcileTemplate(actorOf(req), req.params.id));
  } catch (error) {
    fail(res, error, 'reconcile');
  }
};

/** Manual status refresh of a Pending template: 200 with an outcome, as submit. */
export const refreshTemplateHandler = async (req: Request, res: Response) => {
  try {
    res.json(await refreshTemplateStatus(actorOf(req), req.params.id));
  } catch (error) {
    fail(res, error, 'refresh');
  }
};
