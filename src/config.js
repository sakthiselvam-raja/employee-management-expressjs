import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';

const isProd = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change_me_to_a_long_random_string') {
  if (isProd) {
    throw new Error('JWT_SECRET must be set to a long random value in production');
  }
  jwtSecret = crypto.randomBytes(48).toString('hex');
  console.warn('[config] JWT_SECRET not set — using a temporary secret (everyone is logged out on restart).');
}

const mb = (name, fallback) => Number(process.env[name] || fallback) * 1024 * 1024;

export const config = {
  isProd,
  port: Number(process.env.PORT || 5000),
  clientOrigin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),

  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  cookieName: 'ism_token',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // 'lax' when the site and API share a domain; 'none' (needs COOKIE_SECURE=true) when they are on different sites
  cookieSameSite: ['lax', 'strict', 'none'].includes(process.env.COOKIE_SAMESITE) ? process.env.COOKIE_SAMESITE : 'lax',

  adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim(),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin@123',
  adminEmail: (process.env.ADMIN_EMAIL || 'admin@ism.local').trim().toLowerCase(),
  defaultUserPassword: process.env.DEFAULT_USER_PASSWORD || 'ism@123',

  storageRoot: path.resolve(process.env.STORAGE_DIR || './storage'),
  maxZipBytes: mb('MAX_ZIP_SIZE_MB', 6144),
  maxExtractedBytes: mb('MAX_EXTRACTED_SIZE_MB', 12288),
  maxSubmissionBytes: mb('MAX_SUBMISSION_SIZE_MB', 50),
};