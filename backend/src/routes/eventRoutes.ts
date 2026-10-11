import { Router } from 'express';
import { createEvent, createSubEvent, getEvents, getEventById, updateEvent, deleteEvent, bulkDeleteEvents, getEventUsers, getEventStatistics } from '../controllers/eventController';
import { listMembers, listMemberCandidates, addMembers, removeMember } from '../controllers/eventMemberController';
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

/**
 * Sub-Events. Creating one is administrative, as creating an event is in the
 * app (the Events page offers it to Admins and SuperAdmins); deleting one goes
 * through DELETE /:id above, gated the same way. Its member list is managed by
 * anyone who may work on the event, as its Main Event's guests are. Every
 * controller still authorizes the event itself (isEventAuthorized).
 */
router.post('/:id/sub-events', requireAdmin, createSubEvent);
router.get('/:id/members', listMembers);
router.get('/:id/member-candidates', listMemberCandidates);
router.post('/:id/members', addMembers);
router.delete('/:id/members/:contactId', removeMember);

export default router;
