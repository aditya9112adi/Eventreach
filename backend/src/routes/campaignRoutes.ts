import { Router } from 'express';
import { getCampaign, saveCampaign, uploadMedia, sendCampaign, getAllCampaigns } from '../controllers/campaignController';
import { requireAuth } from '../middleware/authMiddleware';
import { mediaUpload } from '../middleware/mediaUpload';
import { actionLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.use(requireAuth);

router.get('/all', getAllCampaigns);
router.get('/event/:eventId', getCampaign);
router.post('/event/:eventId', saveCampaign);
router.post('/event/:eventId/send', actionLimiter, sendCampaign);
router.post('/upload', mediaUpload.single('file'), uploadMedia);

export default router;
