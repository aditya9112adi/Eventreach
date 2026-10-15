import { Request, Response } from 'express';
import { AuditService } from '../services/AuditService';
import {
  OnboardingError,
  cancelOnboarding,
  completeOnboarding,
  disconnectSender,
  getOnboardingConfig,
  listMySenders,
  registerSender,
  reportOnboardingError,
  startOnboarding,
  verifySender,
  type OnboardingActor,
  type OnboardingDeps,
} from '../services/whatsappOnboardingService';

/**
 * HTTP for connecting a WhatsApp number through Meta's Embedded Signup, under
 * /api/whatsapp-onboarding. Thin on purpose: who may do what is decided in the
 * service, from the database, on every call. No response ever carries a token,
 * a code, a PIN or the app secret.
 */

const actorOf = (req: Request): OnboardingActor => {
  const user = (req as any).user ?? {};
  return { id: String(user.id ?? ''), email: user.email, role: user.role, name: user.name };
};

const depsOf = (req: Request): OnboardingDeps => ({ auditContext: { request: AuditService.getRequestInfo(req) } });

const fail = (res: Response, error: unknown, context: string) => {
  if (error instanceof OnboardingError) return res.status(error.httpStatus).json(error.toResponse());
  console.error(`WhatsApp onboarding: ${context} failed:`, (error as any)?.message || error);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
};

const body = (req: Request) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

const handle = (context: string, run: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response) => {
  try {
    res.status(status).json(await run(req));
  } catch (error) {
    fail(res, error, context);
  }
};

export const getConfigHandler = handle('config', (req) => getOnboardingConfig(actorOf(req), depsOf(req)));
export const startHandler = handle('start', (req) => startOnboarding(actorOf(req), depsOf(req)), 201);
export const completeHandler = handle('complete', (req) => completeOnboarding(actorOf(req), req.params.id, body(req), depsOf(req)));
export const cancelHandler = handle('cancel', (req) => cancelOnboarding(actorOf(req), req.params.id, body(req), depsOf(req)));
export const errorHandler = handle('error report', (req) => reportOnboardingError(actorOf(req), req.params.id, body(req), depsOf(req)));
export const listMineHandler = handle('list', (req) => listMySenders(actorOf(req)));
export const registerHandler = handle('register', (req) => registerSender(actorOf(req), req.params.id, body(req), depsOf(req)));
export const verifyHandler = handle('verify', (req) => verifySender(actorOf(req), req.params.id, depsOf(req)));
export const disconnectHandler = handle('disconnect', (req) => disconnectSender(actorOf(req), req.params.id, depsOf(req)));
