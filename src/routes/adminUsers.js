import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { conflict, notFound, toId } from '../lib/errors.js';
import { logActivity, publicUser } from '../lib/activity.js';

const router = Router();

const optionalText = z
  .string()
  .trim()
  .max(100)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const userSchema = z.object({
  employeeId: z
    .string()
    .trim()
    .min(1, 'Employee ID is required')
    .max(50)
    .regex(/^[A-Za-z0-9._-]+$/, 'Employee ID can contain letters, numbers, dot, dash and underscore only'),
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  middleName: optionalText,
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

async function findUserOr404(id) {
  const user = await prisma.user.findFirst({ where: { id, role: 'USER' } });
  if (!user) throw notFound('User not found');
  return user;
}

async function assertUnique({ employeeId, email }, excludeId) {
  const clash = await prisma.user.findFirst({
    where: {
      id: excludeId ? { not: excludeId } : undefined,
      OR: [
        { employeeId: { equals: employeeId, mode: 'insensitive' } },
        { email: { equals: email, mode: 'insensitive' } },
      ],
    },
  });
  if (clash) {
    const field = clash.employeeId.toLowerCase() === employeeId.toLowerCase() ? 'Employee ID' : 'Email';
    throw conflict(`${field} is already used by another account`);
  }
}

/** GET /api/admin/users?search=&status=active|inactive|all */
router.get('/', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || 'all');
  const where = { role: 'USER' };
  if (status === 'active') where.isActive = true;
  if (status === 'inactive') where.isActive = false;
  if (search) {
    where.OR = ['employeeId', 'firstName', 'middleName', 'lastName', 'email'].map((f) => ({
      [f]: { contains: search, mode: 'insensitive' },
    }));
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { assignments: true } } },
  });
  res.json({ users: users.map((u) => ({ ...publicUser(u), assignmentCount: u._count.assignments })) });
});

/** POST /api/admin/users — password is always the default (ism@123) */
router.post('/', async (req, res) => {
  const data = userSchema.parse(req.body);
  await assertUnique(data);
  const user = await prisma.user.create({
    data: { ...data, role: 'USER', passwordHash: await bcrypt.hash(config.defaultUserPassword, 12) },
  });
  await logActivity({
    action: 'USER_CREATED', entityType: 'User', entityId: user.id, actor: req.user,
    details: { employeeId: user.employeeId, email: user.email },
  });
  res.status(201).json({ user: publicUser(user), defaultPassword: config.defaultUserPassword });
});

router.get('/:id', async (req, res) => {
  const user = await findUserOr404(toId(req.params.id));
  res.json({ user: publicUser(user) });
});

router.put('/:id', async (req, res) => {
  const id = toId(req.params.id);
  const before = await findUserOr404(id);
  const data = userSchema.parse(req.body);
  await assertUnique(data, id);
  const user = await prisma.user.update({ where: { id }, data });
  await logActivity({
    action: 'USER_UPDATED', entityType: 'User', entityId: id, actor: req.user,
    details: { before: publicUser(before), after: publicUser(user) },
  });
  res.json({ user: publicUser(user) });
});

router.patch('/:id/status', async (req, res) => {
  const id = toId(req.params.id);
  await findUserOr404(id);
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  const user = await prisma.user.update({ where: { id }, data: { isActive } });
  await logActivity({ action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', entityType: 'User', entityId: id, actor: req.user });
  res.json({ user: publicUser(user) });
});

router.post('/:id/reset-password', async (req, res) => {
  const id = toId(req.params.id);
  await findUserOr404(id);
  await prisma.user.update({
    where: { id },
    data: { passwordHash: await bcrypt.hash(config.defaultUserPassword, 12) },
  });
  await logActivity({ action: 'USER_PASSWORD_RESET', entityType: 'User', entityId: id, actor: req.user });
  res.json({ message: 'Password reset to the default password', defaultPassword: config.defaultUserPassword });
});

/** Users who already have assignments can only be deactivated (history is kept). */
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id);
  const user = await findUserOr404(id);
  const [assignments, submissions] = await Promise.all([
    prisma.assignment.count({ where: { userId: id } }),
    prisma.submission.count({ where: { uploadedById: id } }),
  ]);
  if (assignments || submissions) {
    throw conflict('This user has assignment history — deactivate the account instead of deleting it');
  }
  await prisma.user.delete({ where: { id } });
  await logActivity({
    action: 'USER_DELETED', entityType: 'User', entityId: id, actor: req.user,
    details: { employeeId: user.employeeId, email: user.email },
  });
  res.json({ message: 'User deleted' });
});

export default router;
