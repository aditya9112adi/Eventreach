import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../store/authStore';

// Use the exact same API URL logic as the axios instance
const getApiUrl = () => {
  return typeof import.meta !== 'undefined' && import.meta.env.VITE_API_URL
    ? import.meta.env.VITE_API_URL.replace('/api', '')
    : 'http://localhost:5000';
};

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
});

export const useSocket = () => useContext(SocketContext);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { token } = useAuth();

  useEffect(() => {
    // The server now requires a verified JWT on the handshake and derives the
    // room from it, so there is nothing to connect to while signed out.
    if (!token) {
      setSocket(null);
      setIsConnected(false);
      return;
    }

    const SOCKET_URL = getApiUrl();
    const socketInstance = io(SOCKET_URL, {
      transports: ['websocket', 'polling'], // Allow fallback
      auth: { token },
    });

    socketInstance.on('connect', () => {
      console.log('Connected to real-time socket:', socketInstance.id);
      setIsConnected(true);
    });

    socketInstance.on('disconnect', () => {
      console.log('Disconnected from real-time socket');
      setIsConnected(false);
    });

    socketInstance.on('connect_error', (err) => {
      // An auth failure here is expected right after logout or token expiry.
      console.warn('Socket connection error:', err.message);
      setIsConnected(false);
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
    };
    // Reconnect with fresh credentials whenever the session token changes.
  }, [token]);

  return (
    <SocketContext.Provider value={{ socket, isConnected }}>
      {children}
    </SocketContext.Provider>
  );
};
