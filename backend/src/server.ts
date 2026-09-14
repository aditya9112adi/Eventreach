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
import webhookRoutes from './routes/webhookRoutes';
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

// WhatsApp delivery callbacks are mounted FIRST, deliberately, ahead of both
// the global rate limiter and express.json():
//   - the X-Hub-Signature-256 HMAC is computed over the raw bytes, so this
//     route needs express.raw() rather than a parsed body;
//   - a campaign produces one callback per recipient per milestone (sent,
//     delivered, read), which would trip the 200-per-15-minutes global limit
//     and make Meta retry a flood it had already delivered.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

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

  // provider is 'resend' or 'smtp' here — never logs whether either secret is
  // actually set, only which provider that check resolved to.
  const mail = await verifyEmailTransport();
  if (mail.ok) {
    // Resend is reported as configured rather than verified: it is never
    // probed at boot, because doing so would require management permissions
    // this service deliberately does not hold. Any real delivery failure is
    // logged per send instead.
    console.log(
      mail.verified
        ? `Email transport: OK (provider=${mail.provider}, credentials verified)`
        : `Email transport: OK (provider=${mail.provider}, key present — delivery errors are logged per send)`
    );
  } else if (!mail.configured) {
    console.warn(`Email transport: NOT CONFIGURED — ${mail.error}. Password reset and approval emails will not be sent.`);
  } else {
    // mail.provider can only be 'smtp' here in development: SMTP is never
    // selected in production (see activeProvider in utils/email.ts), so a
    // production failure at this point is always provider=resend.
    console.error(
      `Email transport: FAILED (provider=${mail.provider}) — ${mail.error}. Outgoing email will not be delivered.`
    );
  }
};

const startServer = async () => {
  await connectDB();

  const httpServer = createServer(app);
  initSocket(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Configuration diagnostics run AFTER the server is accepting connections.
  // reportConfiguration() does a live network check of the email provider that
  // can take 10-15s; nothing depends on its result, so it must not delay the
  // service becoming reachable — this matters most on a cold boot.
  reportConfiguration().catch((err) => {
    console.error('Configuration diagnostics failed:', err);
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

