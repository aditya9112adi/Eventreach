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
  setWhatsAppTemplateAccess,
} from '../controllers/adminController';
import { getAccessReport } from '../controllers/accessReportController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { passwordResetLimiter, actionLimiter } from '../middleware/rateLimitMiddleware';

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

// Grant or revoke an Admin's permission to manage WhatsApp templates. Super
// Admin only; audited in the controller.
router.put('/admins/:id/whatsapp-template-access', requireRole('SuperAdmin'), actionLimiter, setWhatsAppTemplateAccess);

// Deployment configuration diagnostic (booleans only, never secret values).
router.get('/system-health', requireRole('SuperAdmin'), getSystemHealth);


// SuperAdmin and Admin routes
router.get('/users/access-records', requireRole(['SuperAdmin', 'Admin']), getAccessRecords);
// The Access Report, by event: each event's access holders (see accessReportController).
router.get('/access-report', requireRole(['SuperAdmin', 'Admin']), getAccessReport);
router.put('/users/:id/assign-event', requireRole(['SuperAdmin', 'Admin']), assignUserEvent);

export default router;
