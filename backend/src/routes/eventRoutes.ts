import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createEvent, createSubEvent, getEvents, getEventById, updateEvent, deleteEvent, bulkDeleteEvents, getEventUsers, getEventStatistics } from '../controllers/eventController';
import { listMembers, listMemberCandidates, addMembers, removeMember, uploadMembersPreview } from '../controllers/eventMemberController';
import { upload } from '../middleware/uploadMiddleware';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { getEventContact, updateEventContact } from '../controllers/whatsappSenderController';
import { applyBulkPoc, previewBulkPoc } from '../controllers/bulkPocController';
import { actionLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.use(requireAuth);

/**
 * multer reports a refused or oversized file by passing an Error to next(),
 * which would reach Express's default handler as a 500 with a stack trace.
 * Answer with the reason instead. The file is read from memory, 10 MB at most.
 */
const singleFile = (req: Request, res: Response, next: NextFunction) =>
  upload.single('file')(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 10 MB.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Please upload a single file.'
        : 'That file could not be accepted.';
      return res.status(400).json({ error: message });
    }
    return res.status(400).json({ error: err?.message || 'That file could not be accepted.' });
  });

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
// One POC mobile number for every event in the caller's scope. Both are POST
// so the number travels in the body, never the URL; the service scopes an
// Admin to the events they own (decision B), a Super Admin to all events.
router.post('/poc-bulk/preview', requireAdmin, previewBulkPoc);
router.post('/poc-bulk', requireAdmin, actionLimiter, applyBulkPoc);
router.get('/', getEvents);
router.get('/:id', getEventById);
router.put('/:id', updateEvent);
router.delete('/:id', requireAdmin, deleteEvent);
router.get('/:id/users', getEventUsers);
router.get('/:id/statistics', getEventStatistics);
router.get('/:id/contact', getEventContact);
router.put('/:id/contact', updateEventContact);

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
// Preview only: nothing is saved until the page confirms through POST /:id/members.
router.post('/:id/members/upload', singleFile, uploadMembersPreview);
router.delete('/:id/members/:contactId', removeMember);

export default router;
