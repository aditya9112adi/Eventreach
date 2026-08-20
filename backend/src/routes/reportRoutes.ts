import { Router } from 'express';
import { getCampaignStats, getCampaignLogs } from '../controllers/reportController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/campaign/:campaignId/stats', getCampaignStats);
router.get('/campaign/:campaignId/logs', getCampaignLogs);

export default router;
