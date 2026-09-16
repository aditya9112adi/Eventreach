import { Router } from 'express';
import { addContact, getAllContacts, getContactsByEvent, uploadAndPreviewContacts, bulkImportContacts, deleteContact, bulkDeleteContacts, updateContact } from '../controllers/contactController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { upload } from '../middleware/uploadMiddleware';

const router = Router();

router.use(requireAuth);

router.post('/', addContact);
router.get('/', getAllContacts);
router.get('/event/:eventId', getContactsByEvent);
router.post('/event/:eventId/upload', upload.single('file'), uploadAndPreviewContacts);
router.post('/event/:eventId/import', bulkImportContacts);
/**
 * Deleting guests is administrative, on the same terms as deleting events: the
 * role gate refuses a User with 403 before the controller runs, and the
 * controller's scope check (isEventAuthorized on each guest's event) still
 * applies afterwards, so an Admin can only delete guests of events within their
 * scope. The role is the one requireAuth re-read from the database, not the
 * token's claim. Adding, importing and editing guests are unaffected.
 */
const requireAdmin = requireRole(['SuperAdmin', 'Admin']);

router.post('/bulk-delete', requireAdmin, bulkDeleteContacts);
router.delete('/:id', requireAdmin, deleteContact);
router.put('/:id', updateContact);

export default router;

