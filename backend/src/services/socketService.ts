import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

import { Admin } from '../models/Admin';

let io: Server;

const expiryTimeouts = new Map<string, NodeJS.Timeout>();

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
  io.use((socket: Socket, next) => {
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

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as SocketUser;
      if (!decoded?.id) {
        return next(new Error('Unauthorized: invalid token'));
      }
      (socket.data as any).user = decoded;
      return next();
    } catch {
      return next(new Error('Unauthorized: invalid token'));
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
