import { Router } from 'express';
import { createEvent, getEvents, getEventById } from '../controllers/eventController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.post('/', createEvent);
router.get('/', getEvents);
router.get('/:id', getEventById);

export default router;
