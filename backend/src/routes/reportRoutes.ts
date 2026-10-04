import { Router } from 'express';
import { getCampaignStats, getCampaignLogs, getEventTemplateLogs, getEventDeliveryLog, getEventsDeliveryLog } from '../controllers/reportController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/campaign/:campaignId/stats', getCampaignStats);
router.get('/campaign/:campaignId/logs', getCampaignLogs);

// Proactive template sends, which belong to an event rather than a campaign.
router.get('/event/:eventId/template-logs', getEventTemplateLogs);

// One event's whole Delivery Log (campaign recipients and template sends) for
// the Event Report.
router.get('/event/:eventId/delivery-log', getEventDeliveryLog);

// Every event of a generated Event Report at once, for the report's own Excel
// and PDF. POST so a long list of event ids travels in the body; reads only.
router.post('/events/delivery-log', getEventsDeliveryLog);

export default router;
