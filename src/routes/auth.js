import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { logActivity, publicUser } from '../lib/activity.js';
import { authenticate, signToken, setAuthCookie, clearAuthCookie } from '../middleware/auth.js';

const router = Router();

// Only FAILED logins (wrong password / unknown user) count; successful logins never use up the limit,
// so many users on one network can log in freely.
const loginLimiter = rateLimit({
  windowMs: 2 * 60 * 1000, // a blocked network can try again after at most 2 minutes
  limit: 30,               // failed logins allowed per IP in that window
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many failed login attempts — please try again in 2 minutes' },
});

// Used when no user is found so the response time doesn't reveal which accounts exist
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

async function finishLogin(req, res, user, password) {
  const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid username or password');
  if (!user.isActive) throw new HttpError(403, 'Your account has been disabled — contact the admin');

  const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  setAuthCookie(res, signToken(updated));
  await logActivity({ action: 'LOGIN', entityType: 'User', entityId: user.id, actor: user, details: { ip: req.ip } });
  res.json({ user: publicUser(updated) });
}

const adminLoginSchema = z.object({
  username: z.string().transform((v) => v.replace(/\s+/g, '')).pipe(z.string().min(1, 'Username is required')), // no spaces
  password: z.string().min(1, 'Password is required'),
});

/** POST /api/auth/admin/login  { username, password } */
router.post('/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = adminLoginSchema.parse(req.body);
  const user = await prisma.user.findFirst({
    where: { role: 'ADMIN', employeeId: { equals: username, mode: 'insensitive' } },
  });
  await finishLogin(req, res, user, password);
});

const userLoginSchema = z.object({
  identifier: z.string().transform((v) => v.replace(/\s+/g, '')).pipe(z.string().min(1, 'Employee ID or email is required')), // no spaces
  password: z.string().min(1, 'Password is required'),
});

/** POST /api/auth/user/login  { identifier: employeeId | email, password } */
router.post('/user/login', loginLimiter, async (req, res) => {
  const { identifier, password } = userLoginSchema.parse(req.body);
  const user = await prisma.user.findFirst({
    where: {
      role: 'USER',
      OR: [
        { employeeId: { equals: identifier, mode: 'insensitive' } },
        { email: { equals: identifier, mode: 'insensitive' } },
      ],
    },
  });
  await finishLogin(req, res, user, password);
});

router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out' });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters').max(100),
});

/** Users can change their own password (the admin password is controlled by .env). */
router.post('/change-password', authenticate, async (req, res) => {
  if (req.user.role !== 'USER') throw badRequest('The admin password is set in the server .env file');
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  if (!(await bcrypt.compare(currentPassword, req.user.passwordHash))) {
    throw badRequest('Current password is incorrect');
  }
  await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 12) },
  });
  await logActivity({ action: 'PASSWORD_CHANGED', entityType: 'User', entityId: req.user.id, actor: req.user });
  res.json({ message: 'Password updated' });
});

export default router;