import { Router } from 'express';
import { addContact, getAllContacts, getContactsByEvent, uploadAndPreviewContacts, bulkImportContacts, deleteContact, updateContact } from '../controllers/contactController';
import { requireAuth } from '../middleware/authMiddleware';
import { upload } from '../middleware/uploadMiddleware';

const router = Router();

router.use(requireAuth);

router.post('/', addContact);
router.get('/', getAllContacts);
router.get('/event/:eventId', getContactsByEvent);
router.post('/event/:eventId/upload', upload.single('file'), uploadAndPreviewContacts);
router.post('/event/:eventId/import', bulkImportContacts);
router.delete('/:id', deleteContact);
router.put('/:id', updateContact);

export default router;

