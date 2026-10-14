import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import {
  listWhatsAppSenders, syncWhatsAppSendersController, updateWhatsAppSender, refreshWhatsAppSenderStatus,
} from '../controllers/whatsappSenderController';

const router = Router();
router.use(requireAuth);
router.get('/', listWhatsAppSenders);
router.post('/sync', requireRole(['SuperAdmin']), syncWhatsAppSendersController);
router.patch('/:id', requireRole(['SuperAdmin']), updateWhatsAppSender);
router.post('/:id/refresh-status', requireRole(['SuperAdmin']), refreshWhatsAppSenderStatus);
export default router;
