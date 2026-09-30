import { Router } from 'express';
import { getCampaignStats, getCampaignLogs, getEventTemplateLogs } from '../controllers/reportController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/campaign/:campaignId/stats', getCampaignStats);
router.get('/campaign/:campaignId/logs', getCampaignLogs);

// Proactive template sends, which belong to an event rather than a campaign.
router.get('/event/:eventId/template-logs', getEventTemplateLogs);

export default router;
