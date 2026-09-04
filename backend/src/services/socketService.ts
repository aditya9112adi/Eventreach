import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

let io: Server;

import { Admin } from '../models/Admin';

const expiryTimeouts = new Map<string, NodeJS.Timeout>();

export const initSocket = (server: HttpServer) => {
  const allowedOrigins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:5173', 'https://eventreach-frontend-zeta.vercel.app'];
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST']
    }
  });
  
  io.on('connection', (socket) => {
    console.log('Client connected to socket:', socket.id);
    
    socket.on('identify', async (userId: string) => {
      socket.join(userId);
      console.log(`Socket ${socket.id} joined room ${userId}`);

      try {
        const admin = await Admin.findById(userId);
        if (admin && admin.accessExpiryDate) {
          const now = Date.now();
          const expiryTime = new Date(admin.accessExpiryDate).getTime();
          const msUntilExpiry = expiryTime - now;

          // Clear existing timeout if any
          if (expiryTimeouts.has(userId)) {
            clearTimeout(expiryTimeouts.get(userId)!);
          }

          if (msUntilExpiry > 0 && msUntilExpiry <= 2147483647) {
            const timeoutId = setTimeout(() => {
              io.to(userId).emit('ACCESS_EXPIRED', { message: 'Your access has expired.' });
              expiryTimeouts.delete(userId);
            }, msUntilExpiry);
            expiryTimeouts.set(userId, timeoutId);
          }
        }
      } catch (error) {
        console.error('Socket identify error:', error);
      }
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
