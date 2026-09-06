import { Router } from 'express';
import {
  getPendingUsers,
  approveUser,
  rejectUser,
  getAccessRecords,
  revokeAccess,
  assignUserEvent,
  getSystemHealth,
  getPasswordResetRequests,
  issuePasswordResetLink,
  dismissPasswordResetRequest,
} from '../controllers/adminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';

const router = Router();

router.use(requireAuth);

// SuperAdmin only routes
router.get('/users/pending', requireRole('SuperAdmin'), getPendingUsers);
router.put('/users/:id/approve', requireRole('SuperAdmin'), approveUser);
router.put('/users/:id/reject', requireRole('SuperAdmin'), rejectUser);
router.put('/users/:id/revoke-access', requireRole('SuperAdmin'), revokeAccess);

// Deployment configuration diagnostic (booleans only, never secret values).
router.get('/system-health', requireRole('SuperAdmin'), getSystemHealth);

// Password reset requests. Only a Super Admin may see them or mint a reset link.
router.get('/password-reset-requests', requireRole('SuperAdmin'), getPasswordResetRequests);
router.post('/password-reset-requests/:id/issue-link', requireRole('SuperAdmin'), issuePasswordResetLink);
router.post('/password-reset-requests/:id/dismiss', requireRole('SuperAdmin'), dismissPasswordResetRequest);

// SuperAdmin and Admin routes
router.get('/users/access-records', requireRole(['SuperAdmin', 'Admin']), getAccessRecords);
router.put('/users/:id/assign-event', requireRole(['SuperAdmin', 'Admin']), assignUserEvent);

export default router;
