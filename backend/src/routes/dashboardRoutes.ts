import { Router } from 'express';
import { getDashboardStats, getRecentCampaignActivity } from '../controllers/dashboardController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/stats', getDashboardStats);
router.get('/recent-activity', getRecentCampaignActivity);
router.get('/activity', getRecentCampaignActivity); // alias used by frontend

export default router;
