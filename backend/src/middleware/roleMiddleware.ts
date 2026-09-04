import { Response, NextFunction } from 'express';
import { AuthRequest } from './authMiddleware';

export const requireRole = (role: 'SuperAdmin' | 'Admin' | 'User' | ('SuperAdmin' | 'Admin' | 'User')[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const roles = Array.isArray(role) ? role : [role];
    if (!roles.includes(req.user.role as any) && req.user.role !== 'SuperAdmin') {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    next();
  };
};
