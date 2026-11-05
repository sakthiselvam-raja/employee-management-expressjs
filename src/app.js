import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { authenticate, requireRole } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import adminUserRoutes from './routes/adminUsers.js';
import adminUploadRoutes, { adminFilesRouter } from './routes/adminUploads.js';
import adminAssignmentRoutes from './routes/adminAssignments.js';
import adminReportRoutes from './routes/adminReports.js';
import userRoutes from './routes/user.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProd) app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  if (!config.isProd) app.use(morgan('dev'));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);

  // ---- Admin-only API ----
  const admin = express.Router();
  admin.use(authenticate, requireRole('ADMIN'));
  admin.use('/users', adminUserRoutes);
  admin.use('/uploads', adminUploadRoutes);
  admin.use('/assignments', adminAssignmentRoutes);
  admin.use('/files', adminFilesRouter);
  admin.use('/', adminReportRoutes);
  app.use('/api/admin', admin);

  // ---- User-only API ----
  app.use('/api/user', authenticate, requireRole('USER'), userRoutes);

  app.use('/api', notFoundHandler);

  // ---- Serve the built React app in production (frontend/dist) ----
  const dist = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
