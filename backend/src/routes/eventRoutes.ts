import { Router } from 'express';
import { createEvent, getEvents, getEventById, updateEvent, deleteEvent, getEventUsers, getEventStatistics } from '../controllers/eventController';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.use(requireAuth);

router.post('/', createEvent);
router.get('/', getEvents);
router.get('/:id', getEventById);
router.put('/:id', updateEvent);
router.delete('/:id', deleteEvent);
router.get('/:id/users', getEventUsers);
router.get('/:id/statistics', getEventStatistics);

export default router;
