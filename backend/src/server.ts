import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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

dotenv.config();

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

const allowedOrigins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:5173', 'https://eventreach-frontend-zeta.vercel.app'];
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use('/api/', globalLimiter); // Apply global rate limiting before body parsing
app.use(express.json());
app.use(mongoSanitize()); // Prevent NoSQL injection
app.use(requestMiddleware);

// Serve uploads statically
app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

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
const startServer = async () => {
  await connectDB();
  const httpServer = createServer(app);
  initSocket(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();

