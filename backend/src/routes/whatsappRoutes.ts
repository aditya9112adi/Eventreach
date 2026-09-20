import { Router } from 'express';
import {
  testTemplateMessage,
  previewEventTemplate,
  sendEventTemplate,
} from '../controllers/whatsappController';
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

export default router;
