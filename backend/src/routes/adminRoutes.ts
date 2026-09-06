import { Router } from 'express';
import {
  getPendingUsers,
  approveUser,
  rejectUser,
  getAccessRecords,
  revokeAccess,
  assignUserEvent,
  getSystemHealth,
  adminResetUserPassword,
} from '../controllers/adminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { passwordResetLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.use(requireAuth);

// SuperAdmin only routes
router.get('/users/pending', requireRole('SuperAdmin'), getPendingUsers);
router.put('/users/:id/approve', requireRole('SuperAdmin'), approveUser);
router.put('/users/:id/reject', requireRole('SuperAdmin'), rejectUser);
router.put('/users/:id/revoke-access', requireRole('SuperAdmin'), revokeAccess);

// Administrative password reset — the account-recovery path for a locked-out
// Admin or User, since this product has no email delivery. Rate limited on top
// of the Super Admin requirement so a stolen session cannot cycle passwords
// across many accounts unchecked.
router.put(
  '/users/:id/reset-password',
  requireRole('SuperAdmin'),
  passwordResetLimiter,
  adminResetUserPassword
);

// Deployment configuration diagnostic (booleans only, never secret values).
router.get('/system-health', requireRole('SuperAdmin'), getSystemHealth);


// SuperAdmin and Admin routes
router.get('/users/access-records', requireRole(['SuperAdmin', 'Admin']), getAccessRecords);
router.put('/users/:id/assign-event', requireRole(['SuperAdmin', 'Admin']), assignUserEvent);

export default router;
