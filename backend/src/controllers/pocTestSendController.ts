import { Request, Response } from 'express';
import { AuditService } from '../services/AuditService';
import {
  PocTestError,
  getTestSend,
  listPocRecipients,
  listPocSenders,
  listPocTemplatesForSender,
  listTestSends,
  previewTestSend,
  reconcileTestSend,
  registerPocRecipient,
  revokePocRecipient,
  sendTestMessage,
  type PocActor,
  type PocTestDeps,
} from '../services/pocTestSendService';

/**
 * HTTP for POC test sends, under /api/whatsapp/poc-test.
 *
 * Deliberately thin: who may do what, and every check on the sender, template
 * and recipient, is decided in services/pocTestSendService from the database
 * on every call. Nothing about roles, permissions or the sending number is
 * taken from the request. Errors use the shared shape
 * { success: false, error: { code, message, field?, details? } }.
 */

const actorOf = (req: Request): PocActor => {
  const user = (req as any).user ?? {};
  return { id: String(user.id ?? ''), email: user.email, role: user.role, name: user.name };
};

const depsOf = (req: Request): PocTestDeps => ({ auditContext: { request: AuditService.getRequestInfo(req) } });

const fail = (res: Response, error: unknown, context: string) => {
  if (error instanceof PocTestError) return res.status(error.httpStatus).json(error.toResponse());
  console.error(`POC test send: ${context} failed:`, (error as any)?.message || error);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
};

const bodyOf = (req: Request, res: Response): Record<string, any> | null => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'The request body must be a JSON object.' } });
    return null;
  }
  return req.body;
};

export const listPocSendersHandler = async (req: Request, res: Response) => {
  try {
    res.json(await listPocSenders(actorOf(req)));
  } catch (error) {
    fail(res, error, 'list senders');
  }
};

export const listPocTemplatesHandler = async (req: Request, res: Response) => {
  try {
    res.json(await listPocTemplatesForSender(actorOf(req), req.params.senderId));
  } catch (error) {
    fail(res, error, 'list templates');
  }
};

export const listPocRecipientsHandler = async (req: Request, res: Response) => {
  try {
    res.json(await listPocRecipients(actorOf(req)));
  } catch (error) {
    fail(res, error, 'list recipients');
  }
};

export const registerPocRecipientHandler = async (req: Request, res: Response) => {
  const body = bodyOf(req, res);
  if (!body) return;
  try {
    res.status(201).json({ recipient: await registerPocRecipient(actorOf(req), body, depsOf(req)) });
  } catch (error) {
    fail(res, error, 'register recipient');
  }
};

export const revokePocRecipientHandler = async (req: Request, res: Response) => {
  try {
    res.json({ recipient: await revokePocRecipient(actorOf(req), req.params.id, depsOf(req)) });
  } catch (error) {
    fail(res, error, 'revoke recipient');
  }
};

/** Checks everything and shows what would be sent. Sends nothing. */
export const previewTestSendHandler = async (req: Request, res: Response) => {
  const body = bodyOf(req, res);
  if (!body) return;
  try {
    res.json(await previewTestSend(actorOf(req), body));
  } catch (error) {
    fail(res, error, 'preview');
  }
};

/** The only route that can send. A recorded outcome - accepted, failed or unknown - is a 200. */
export const sendTestSendHandler = async (req: Request, res: Response) => {
  const body = bodyOf(req, res);
  if (!body) return;
  try {
    res.json(await sendTestMessage(actorOf(req), body, depsOf(req)));
  } catch (error) {
    fail(res, error, 'send');
  }
};

export const listTestSendsHandler = async (req: Request, res: Response) => {
  try {
    res.json(await listTestSends(actorOf(req), { limit: req.query.limit }));
  } catch (error) {
    fail(res, error, 'list sends');
  }
};

export const getTestSendHandler = async (req: Request, res: Response) => {
  try {
    res.json(await getTestSend(actorOf(req), req.params.id));
  } catch (error) {
    fail(res, error, 'read send');
  }
};

export const reconcileTestSendHandler = async (req: Request, res: Response) => {
  const body = bodyOf(req, res);
  if (!body) return;
  try {
    res.json(await reconcileTestSend(actorOf(req), req.params.id, body.resolution, depsOf(req)));
  } catch (error) {
    fail(res, error, 'reconcile');
  }
};
