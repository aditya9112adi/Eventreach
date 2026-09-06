import { Router } from 'express';
import {
  login,
  register,
  me,
  forgotPassword,
  resetPassword,
} from '../controllers/authController';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimitMiddleware';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.post('/login', authLimiter, login);
router.post('/register', authLimiter, register);

// Password reset, available to every role (SuperAdmin, Admin, User) via the same
// mechanism. Rate limited separately to curb enumeration and mail-bombing.
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password', passwordResetLimiter, resetPassword);

// Authoritative session check used by the frontend on load so role-based UI is
// driven by the server rather than cached localStorage state.
router.get('/me', requireAuth, me);

export default router;
