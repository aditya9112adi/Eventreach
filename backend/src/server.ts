import dns from 'dns';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import { requireAuth } from './middleware/authMiddleware';
import { authorizeUpload } from './middleware/uploadAuthMiddleware';
import mongoSanitize from 'express-mongo-sanitize';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import { connectDB } from './config/database';
import { initSocket } from './services/socketService';
import authRoutes from './routes/authRoutes';
import eventRoutes from './routes/eventRoutes';
import contactRoutes from './routes/contactRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import campaignRoutes from './routes/campaignRoutes';
import reportRoutes from './routes/reportRoutes';
import settingsRoutes from './routes/settingsRoutes';
import adminRoutes from './routes/adminRoutes';
import auditRoutes from './routes/auditRoutes';
import { requestMiddleware } from './middleware/requestMiddleware';
import { globalLimiter } from './middleware/rateLimitMiddleware';
import { getAllowedOrigins, getFrontendBaseUrl, isFrontendUrlConfigured } from './config/appUrls';
import { verifyEmailTransport } from './utils/email';

dotenv.config();

// Node 17+ returns DNS results verbatim, which usually puts IPv6 first. Render's
// containers have no outbound IPv6 route, so an AAAA answer fails immediately
// with ENETUNREACH and the IPv4 address is never tried — which silently broke
// all outbound SMTP. Prefer IPv4 so those connections actually get made.
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = process.env.PORT || 5000;

// Render fronts services with Cloudflare, so requests traverse two proxy hops
// (Cloudflare edge -> Render router) before reaching the app. Without this,
// every request appears to come from the proxy IP and all rate limiters share
// one global bucket. Rate limiting additionally prefers the Cloudflare-supplied
// CF-Connecting-IP header (see middleware/rateLimitMiddleware.ts).
app.set('trust proxy', 2);

// Middleware
app.use(helmet());

const allowedOrigins = getAllowedOrigins();
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use('/api/', globalLimiter); // Apply global rate limiting before body parsing
app.use(express.json());
app.use(mongoSanitize()); // Prevent NoSQL injection
app.use(requestMiddleware);

// Serve uploads. Campaign media is private to its event, so the same
// authentication and per-event authorization used by the API applies here
// before any file is read from disk.
app.use(
  '/uploads',
  requireAuth,
  authorizeUpload,
  express.static(path.join(__dirname, '../../uploads'))
);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/audit', auditRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start Server
/**
 * Report configuration that silently degrades at runtime, so a misconfigured
 * deployment is obvious in the logs rather than discovered by a user.
 */
const reportConfiguration = async () => {
  if (isFrontendUrlConfigured()) {
    console.log(`Frontend URL: ${getFrontendBaseUrl()} (from FRONTEND_URL)`);
  } else {
    console.warn(
      `FRONTEND_URL is not set — falling back to ${getFrontendBaseUrl()}. ` +
        'Set it so email links always point at the right frontend.'
    );
  }

  const mail = await verifyEmailTransport();
  if (mail.ok) {
    console.log(`Email transport: OK (provider=${mail.provider})`);
  } else if (!mail.configured) {
    console.warn('Email transport: NOT CONFIGURED — password reset and approval emails will not be sent.');
  } else {
    console.error(
      `Email transport: FAILED (provider=${mail.provider}) — ${mail.error}. Outgoing email will not be delivered.`
    );
    if (mail.provider === 'smtp' && process.env.NODE_ENV === 'production') {
      console.error(
        'Hosts such as Render block outbound SMTP (ports 25/465/587). Set RESEND_API_KEY to deliver over HTTPS instead.'
      );
    }
  }
};

const startServer = async () => {
  await connectDB();
  await reportConfiguration();
  const httpServer = createServer(app);
  initSocket(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  /**
   * Graceful shutdown.
   *
   * The host sends SIGTERM before replacing the instance on a deploy. Without
   * this the process is killed outright and any request still in flight — a
   * bulk import, a campaign send — is dropped mid-write. Stop accepting new
   * connections, let the current ones finish, then close the database.
   */
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down gracefully`);
    httpServer.close(async () => {
      try {
        await mongoose.connection.close(false);
      } catch (err) {
        console.error('Error closing MongoDB connection:', err);
      }
      process.exit(0);
    });

    // Never hang forever if a connection refuses to drain.
    setTimeout(() => {
      console.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

/**
 * Last-resort process guards.
 *
 * On current Node an unhandled promise rejection terminates the process, so a
 * single missed `.catch()` anywhere in a request handler took the whole API
 * down until the host restarted it. Log and keep serving instead; a crash is
 * never the better outcome for an already-running deployment.
 */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

