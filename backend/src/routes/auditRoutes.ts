import express from 'express';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { getAuditLogs, getAuditStatistics } from '../controllers/auditController';

const router = express.Router();

// Only SuperAdmin or authorized admins can view audit logs
router.get('/', requireAuth, requireRole('SuperAdmin'), getAuditLogs);
router.get('/statistics', requireAuth, requireRole('SuperAdmin'), getAuditStatistics);

export default router;
