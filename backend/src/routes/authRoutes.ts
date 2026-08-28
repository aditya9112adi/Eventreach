import { Router } from 'express';
import { login, register } from '../controllers/authController';
import { authLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.post('/login', authLimiter, login);
router.post('/register', authLimiter, register);

export default router;
