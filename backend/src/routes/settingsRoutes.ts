import { Router } from 'express';
import { getSettings, updateSettings } from '../controllers/settingsController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';

const router = Router();

router.use(requireAuth);

// Settings hold integration configuration (WhatsApp credentials, webhook verify
// token). Only the Super Admin may read or change them.
router.get('/', requireRole('SuperAdmin'), getSettings);
router.put('/', requireRole('SuperAdmin'), updateSettings);

export default router;
