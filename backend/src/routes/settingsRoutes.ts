import { Router } from 'express';
import { getSettings, updateSettings } from '../controllers/settingsController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/', getSettings);
router.put('/', updateSettings);

export default router;
