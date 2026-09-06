import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

import { Admin } from '../models/Admin';
import { User } from '../models/User';

let io: Server;

/**
 * Broadcast room every connected Super Admin joins, used for notifications that
 * are only meaningful to them (e.g. the pending-approvals badge).
 */
const SUPERADMIN_ROOM = 'role:SuperAdmin';

const expiryTimeouts = new Map<string, NodeJS.Timeout>();

/**
 * Push the current number of pending registrations to every connected Super
 * Admin so the "User Approvals" badge stays live without a refresh.
 *
 * Called whenever the pending set changes: a new registration arrives, or a
 * request is approved or rejected.
 */
export const emitPendingApprovalsChanged = async () => {
  try {
    const [pendingUsers, pendingAdmins] = await Promise.all([
      User.countDocuments({ status: 'Pending' }),
      Admin.countDocuments({ status: 'Pending' }),
    ]);

    getIO()
      .to(SUPERADMIN_ROOM)
      .emit('PENDING_APPROVALS_CHANGED', { pendingCount: pendingUsers + pendingAdmins });
  } catch (error) {
    // Never let a notification failure break the request that triggered it.
    console.error('Failed to emit PENDING_APPROVALS_CHANGED:', error);
  }
};

interface SocketUser {
  id: string;
  email?: string;
  role?: string;
}

/**
 * Schedule an ACCESS_EXPIRED push for an Admin whose access window ends while
 * they are connected.
 */
const scheduleExpiryNotice = async (userId: string) => {
  try {
    const admin = await Admin.findById(userId).select('accessExpiryDate');
    if (!admin || !admin.accessExpiryDate) return;

    const msUntilExpiry = new Date(admin.accessExpiryDate).getTime() - Date.now();

    if (expiryTimeouts.has(userId)) {
      clearTimeout(expiryTimeouts.get(userId)!);
      expiryTimeouts.delete(userId);
    }

    // setTimeout overflows past ~24.8 days, so only schedule within that range.
    if (msUntilExpiry > 0 && msUntilExpiry <= 2147483647) {
      const timeoutId = setTimeout(() => {
        io.to(userId).emit('ACCESS_EXPIRED', { message: 'Your access has expired.' });
        expiryTimeouts.delete(userId);
      }, msUntilExpiry);
      expiryTimeouts.set(userId, timeoutId);
    }
  } catch (error) {
    console.error('Socket expiry scheduling error:', error);
  }
};

export const initSocket = (server: HttpServer) => {
  const allowedOrigins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:5173', 'https://eventreach-frontend-zeta.vercel.app'];
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST']
    }
  });

  /**
   * Authenticate the handshake.
   *
   * Previously any anonymous client could connect and then call `identify` with
   * an arbitrary user id, joining that user's room and receiving their private
   * events (event assignments, access revocation). The room is now derived from
   * a verified JWT and the client cannot choose it.
   */
  io.use(async (socket: Socket, next) => {
    const token =
      (socket.handshake.auth && (socket.handshake.auth as any).token) ||
      (typeof socket.handshake.query?.token === 'string' ? socket.handshake.query.token : undefined);

    if (!token) {
      return next(new Error('Unauthorized: missing token'));
    }
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not defined; refusing socket connections.');
      return next(new Error('Server authentication is misconfigured'));
    }

    let decoded: SocketUser;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET) as SocketUser;
    } catch {
      return next(new Error('Unauthorized: invalid token'));
    }

    if (!decoded?.id) {
      return next(new Error('Unauthorized: invalid token'));
    }

    try {
      // Mirror requireAuth: the role comes from the database, not the token, and a
      // revoked or deleted account cannot open a socket with a still-valid JWT.
      if (decoded.role === 'User') {
        const user = await User.findById(decoded.id).select('status isAccessCancelled');
        if (!user || user.status !== 'Active' || user.isAccessCancelled) {
          return next(new Error('Unauthorized: account is not active'));
        }
        (socket.data as any).user = { id: decoded.id, email: decoded.email, role: 'User' };
      } else {
        const admin = await Admin.findById(decoded.id).select('status isAccessCancelled role');
        if (!admin) {
          return next(new Error('Unauthorized: account not found'));
        }
        if (admin.role !== 'SuperAdmin' && (admin.status !== 'Active' || admin.isAccessCancelled)) {
          return next(new Error('Unauthorized: account is not active'));
        }
        (socket.data as any).user = { id: decoded.id, email: decoded.email, role: admin.role };
      }
      return next();
    } catch (error) {
      console.error('Socket handshake verification error:', error);
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user: SocketUser | undefined = (socket.data as any).user;
    if (!user?.id) {
      socket.disconnect(true);
      return;
    }

    // The room is always the authenticated user's own id.
    socket.join(user.id);
    console.log(`Socket ${socket.id} connected and joined its own room`);

    if (user.role === 'SuperAdmin') {
      // Super Admins additionally receive system-wide notifications such as the
      // live pending-approvals count.
      socket.join(SUPERADMIN_ROOM);
      void emitPendingApprovalsChanged();
    }

    if (user.role === 'Admin') {
      void scheduleExpiryNotice(user.id);
    }

    // Retained for backwards compatibility with existing clients, but the
    // supplied id is ignored — membership is fixed to the authenticated user.
    socket.on('identify', () => {
      socket.join(user.id);
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected from socket:', socket.id);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io is not initialized!');
  }
  return io;
};
