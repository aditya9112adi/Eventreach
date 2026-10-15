import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import { actionLimiter } from '../middleware/rateLimitMiddleware';
import {
  cancelHandler,
  completeHandler,
  disconnectHandler,
  errorHandler,
  getConfigHandler,
  listMineHandler,
  registerHandler,
  startHandler,
  verifyHandler,
} from '../controllers/whatsappOnboardingController';

/**
 * Connecting a WhatsApp number through Meta's Embedded Signup. Every route needs
 * a signed-in account; the service decides from the database who may act (an
 * Admin or Super Admin; the number's owner, or a Super Admin for verify and
 * disconnect; only the owner registers with their PIN).
 */
const router = Router();
router.use(requireAuth);

router.get('/config', getConfigHandler);
router.get('/senders', listMineHandler);
router.post('/sessions', actionLimiter, startHandler);
router.post('/sessions/:id/complete', actionLimiter, completeHandler);
router.post('/sessions/:id/cancel', cancelHandler);
router.post('/sessions/:id/error', errorHandler);
router.post('/senders/:id/register', actionLimiter, registerHandler);
router.post('/senders/:id/verify', actionLimiter, verifyHandler);
router.post('/senders/:id/disconnect', actionLimiter, disconnectHandler);

export default router;
