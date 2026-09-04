import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET) as {
      id: string;
      email: string;
      role: string;
    };

    if (decoded.role === 'Admin') {
      const admin = await Admin.findById(decoded.id);
      if (!admin) {
        return res.status(401).json({ error: 'Unauthorized: Admin not found' });
      }
      if (admin.isAccessCancelled) {
        return res.status(401).json({ error: 'Unauthorized: Your access has been removed' });
      }
      if (admin.accessExpiryDate && new Date() > new Date(admin.accessExpiryDate)) {
        return res.status(401).json({ error: 'Unauthorized: Your access has expired' });
      }
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};
