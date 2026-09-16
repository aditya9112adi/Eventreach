import { Router } from 'express';
import { createEvent, getEvents, getEventById, updateEvent, deleteEvent, bulkDeleteEvents, getEventUsers, getEventStatistics } from '../controllers/eventController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';

const router = Router();

router.use(requireAuth);

// Deleting an event is administrative. The role gate runs before the
// controller, so a User is refused with 403 without the event being looked up;
// the controller's own scope check (isEventAuthorized) still applies afterwards,
// so an Admin can only delete events within their own scope. The role here is
// the one authMiddleware re-read from the database, not the token's claim.
const requireAdmin = requireRole(['SuperAdmin', 'Admin']);

router.post('/', createEvent);
// POST rather than DELETE /bulk: a DELETE path segment would be captured by
// the `/:id` route below and treated as an event id.
router.post('/bulk-delete', requireAdmin, bulkDeleteEvents);
router.get('/', getEvents);
router.get('/:id', getEventById);
router.put('/:id', updateEvent);
router.delete('/:id', requireAdmin, deleteEvent);
router.get('/:id/users', getEventUsers);
router.get('/:id/statistics', getEventStatistics);

export default router;
