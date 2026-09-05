import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin';
import { User } from '../models/User';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

/**
 * Result of re-validating the account behind a token against the database.
 * `null` means the account is still allowed to use the API.
 */
const accountRejectionReason = (account: {
  status?: string;
  isAccessCancelled?: boolean;
  accessStartDate?: Date;
  accessExpiryDate?: Date;
}): string | null => {
  if (account.status === 'Rejected') {
    return 'Unauthorized: Your account registration was rejected';
  }
  if (account.status === 'Pending') {
    return 'Unauthorized: Your account is pending approval';
  }
  if (account.isAccessCancelled) {
    return 'Unauthorized: Your access has been removed';
  }
  const now = new Date();
  if (account.accessStartDate && now < new Date(account.accessStartDate)) {
    return 'Unauthorized: Your access has not started yet';
  }
  if (account.accessExpiryDate && now > new Date(account.accessExpiryDate)) {
    return 'Unauthorized: Your access has expired';
  }
  return null;
};

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

  let decoded: { id: string; email: string; role: string };
  try {
    if (!process.env.JWT_SECRET) {
      // Configuration fault, not a client fault — surface it distinctly so it is
      // not silently misread as a bad token.
      console.error('JWT_SECRET is not defined; cannot verify tokens.');
      return res.status(500).json({ error: 'Server authentication is misconfigured' });
    }

    decoded = jwt.verify(token, process.env.JWT_SECRET) as {
      id: string;
      email: string;
      role: string;
    };
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  try {
    // A JWT stays valid until it expires, so revocation, expiry and deletion must
    // be re-checked against the database on every request. Previously only the
    // Admin role was re-checked, which let revoked Users keep full API access for
    // the remaining lifetime of their token.
    // The role is taken from the database rather than the token, so a demoted
    // account cannot keep elevated privileges via an old JWT.
    let effectiveRole: string;

    if (decoded.role === 'Admin' || decoded.role === 'SuperAdmin') {
      const admin = await Admin.findById(decoded.id).select(
        'status isAccessCancelled accessStartDate accessExpiryDate role'
      );
      if (!admin) {
        return res.status(401).json({ error: 'Unauthorized: Account not found' });
      }
      effectiveRole = admin.role;
      // SuperAdmin access is not time-bound; only confirm the account still exists
      // and has not been disabled.
      if (admin.role !== 'SuperAdmin') {
        const reason = accountRejectionReason(admin);
        if (reason) {
          return res.status(401).json({ error: reason });
        }
      }
    } else if (decoded.role === 'User') {
      const user = await User.findById(decoded.id).select(
        'status isAccessCancelled accessStartDate accessExpiryDate'
      );
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized: Account not found' });
      }
      effectiveRole = 'User';
      const reason = accountRejectionReason(user);
      if (reason) {
        return res.status(401).json({ error: reason });
      }
    } else {
      return res.status(401).json({ error: 'Unauthorized: Unknown role' });
    }

    req.user = { id: decoded.id, email: decoded.email, role: effectiveRole };
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Failed to verify account status' });
  }
};
