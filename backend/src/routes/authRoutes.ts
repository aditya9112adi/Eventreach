import { Router } from 'express';
import { login, register, me, changePassword } from '../controllers/authController';
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

export default router;
