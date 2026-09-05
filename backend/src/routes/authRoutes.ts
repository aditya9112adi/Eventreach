import { Router } from 'express';
import { login, register, me } from '../controllers/authController';
import { authLimiter } from '../middleware/rateLimitMiddleware';
import { requireAuth } from '../middleware/authMiddleware';

const router = Router();

router.post('/login', authLimiter, login);
router.post('/register', authLimiter, register);

// Authoritative session check used by the frontend on load so role-based UI is
// driven by the server rather than cached localStorage state.
router.get('/me', requireAuth, me);

export default router;
