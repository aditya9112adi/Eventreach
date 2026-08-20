import { Router } from 'express';
import { getPendingUsers, approveUser, rejectUser, getActiveUsers, grantReportAccess } from '../controllers/adminController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';

const router = Router();

// Protect all admin routes: must be authenticated and have SuperAdmin role
router.use(requireAuth);
// @ts-ignore
router.use(requireRole('SuperAdmin'));

router.get('/users/pending', getPendingUsers);
router.put('/users/:id/approve', approveUser);
router.put('/users/:id/reject', rejectUser);

router.get('/users/active', getActiveUsers);
router.put('/users/:id/grant-report-access', grantReportAccess);

export default router;
