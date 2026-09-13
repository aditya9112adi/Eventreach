import { Router } from 'express';
import {
  login, register, me, changePassword,
  forgotPassword, verifyResetToken, resetPassword,
} from '../controllers/authController';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimitMiddleware';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.post('/login', authLimiter, login);
router.post('/register', authLimiter, register);

// Authoritative session check used by the frontend on load so role-based UI is
// driven by the server rather than cached localStorage state.
router.get('/me', requireAuth, me);

// Self-service password change for any signed-in role. Rate limited to blunt
// online guessing of the current password.
router.post('/change-password', requireAuth, passwordResetLimiter, changePassword);

// Self-service password recovery for a signed-out account (any role, no
// admin approval). All three are unauthenticated by nature and share the
// same rate-limit budget: this is the exact abuse surface passwordResetLimiter
// was built for (enumeration probing, mail-bombing, token guessing).
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/verify-reset-token', passwordResetLimiter, verifyResetToken);
router.post('/reset-password', passwordResetLimiter, resetPassword);

export default router;
