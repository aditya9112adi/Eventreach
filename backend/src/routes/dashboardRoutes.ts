import { Router } from 'express';
import { getDashboardStats, getRecentCampaignActivity } from '../controllers/dashboardController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/stats', getDashboardStats);
router.get('/recent-activity', getRecentCampaignActivity);

export default router;
