import { Router } from 'express';
import { getCampaign, saveCampaign, uploadMedia, sendCampaign } from '../controllers/campaignController';
import { requireAuth } from '../middleware/authMiddleware';
import { mediaUpload } from '../middleware/mediaUpload';

const router = Router();

router.use(requireAuth);

router.get('/event/:eventId', getCampaign);
router.post('/event/:eventId', saveCampaign);
router.post('/event/:eventId/send', sendCampaign);
router.post('/upload', mediaUpload.single('file'), uploadMedia);

export default router;
