import { Router } from 'express';
import {
  testTemplateMessage,
  previewEventTemplate,
  sendEventTemplate,
} from '../controllers/whatsappController';
import {
  listTemplatesHandler,
  getTemplateHandler,
  createTemplateHandler,
  updateTemplateHandler,
  deleteTemplateHandler,
  submitTemplateHandler,
  reconcileTemplateHandler,
  refreshTemplateHandler,
} from '../controllers/whatsappTemplateController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { actionLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.use(requireAuth);

// Sends a real WhatsApp message, so it is limited to the Super Admin and to the
// same rate limit as other send actions.
router.post('/test-template', requireRole('SuperAdmin'), actionLimiter, testTemplateMessage);

// Sending an approved template to ONE guest of an event, from the Campaign
// Composer. Not Super Admin only: it messages a guest of a specific event, so
// it carries the same per-event authorization as the rest of that flow
// (isEventAuthorized, applied inside the handler) rather than a role check.
router.get('/event-template-preview', previewEventTemplate);
router.post('/event-template', actionLimiter, sendEventTemplate);

// WhatsApp template management. No role check here on purpose: the template
// service decides - from the database, on every call - whether the account is
// a Super Admin or an Admin holding the explicit grant, and answers 403
// otherwise. Calls that reach Meta share the send-action rate limit.
router.get('/templates', listTemplatesHandler);
router.post('/templates', createTemplateHandler);
router.get('/templates/:id', getTemplateHandler);
router.patch('/templates/:id', updateTemplateHandler);
router.delete('/templates/:id', deleteTemplateHandler);
router.post('/templates/:id/submit', actionLimiter, submitTemplateHandler);
router.post('/templates/:id/reconcile', actionLimiter, reconcileTemplateHandler);
// Asks Meta for a Pending template's status. Read only at Meta; also spaced
// out per template in the service.
router.post('/templates/:id/refresh', actionLimiter, refreshTemplateHandler);

export default router;
