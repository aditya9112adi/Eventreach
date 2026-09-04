import { Router } from 'express';
import { getPendingUsers, approveUser, rejectUser, getAccessRecords, revokeAccess, assignUserEvent } from '../controllers/adminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';

const router = Router();

router.use(requireAuth);

// SuperAdmin only routes
router.get('/users/pending', requireRole('SuperAdmin'), getPendingUsers);
router.put('/users/:id/approve', requireRole('SuperAdmin'), approveUser);
router.put('/users/:id/reject', requireRole('SuperAdmin'), rejectUser);
router.put('/users/:id/revoke-access', requireRole('SuperAdmin'), revokeAccess);

// SuperAdmin and Admin routes
router.get('/users/access-records', requireRole(['SuperAdmin', 'Admin']), getAccessRecords);
router.put('/users/:id/assign-event', requireRole(['SuperAdmin', 'Admin']), assignUserEvent);

export default router;
