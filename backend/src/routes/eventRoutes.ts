import { Router } from 'express';
import { createEvent, getEvents, getEventById, updateEvent } from '../controllers/eventController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.post('/', createEvent);
router.get('/', getEvents);
router.get('/:id', getEventById);
router.put('/:id', updateEvent);

export default router;
