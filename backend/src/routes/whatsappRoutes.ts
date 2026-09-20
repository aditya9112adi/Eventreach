import { Router } from 'express';
import { testTemplateMessage } from '../controllers/whatsappController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { actionLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.use(requireAuth);

// Sends a real WhatsApp message, so it is limited to the Super Admin and to the
// same rate limit as other send actions.
router.post('/test-template', requireRole('SuperAdmin'), actionLimiter, testTemplateMessage);

export default router;
