import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { getCampaign, saveCampaign, uploadMedia, sendCampaign, getAllCampaigns } from '../controllers/campaignController';
import { requireAuth } from '../middleware/authMiddleware';
import { mediaUpload } from '../middleware/mediaUpload';
import { actionLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.use(requireAuth);

/**
 * Turn an upload rejection into a useful 400.
 *
 * multer signals a refused file by passing an Error to next(), which without
 * this reaches Express's default handler and answers 500 with an HTML stack
 * trace — leaking internals to the browser and telling the user nothing about
 * why their file was refused.
 */
const handleUploadErrors = (err: any, _req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than WhatsApp accepts for any media type.'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Please upload a single file.'
      : 'That file could not be accepted.';
    return res.status(400).json({ error: message });
  }

  // Our own fileFilter rejections carry a message written for the user.
  if (err instanceof Error && err.message) {
    return res.status(400).json({ error: err.message });
  }

  return next(err);
};

router.get('/all', getAllCampaigns);
router.get('/event/:eventId', getCampaign);
router.post('/event/:eventId', saveCampaign);
router.post('/event/:eventId/send', actionLimiter, sendCampaign);
router.post('/upload', mediaUpload.single('file'), handleUploadErrors, uploadMedia);

// Also catches an error raised before the route handler is reached.
router.use(handleUploadErrors);

export default router;
