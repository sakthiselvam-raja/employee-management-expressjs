import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import multer from 'multer';
import path from 'node:path';
import { badRequest, conflict, notFound, toId } from '../lib/errors.js';
import { logActivity, publicUser } from '../lib/activity.js';
import { toCsv } from '../lib/archive.js';

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

/**
 * GET /api/admin/users?search=&status=active|inactive|all[&page=1&limit=20]
 * Without `limit` every matching user is returned (old behaviour). With `limit` (max 100) the result is
 * paginated and sorted by name: { users, total, page, limit, pages }.
 * Search: every word must match the Employee ID, email or any part of the name.
 */
router.get('/', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || 'all');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const where = { role: 'USER' };
  if (status === 'active') where.isActive = true;
  if (status === 'inactive') where.isActive = false;
  const tokens = search.split(/\s+/).filter(Boolean).slice(0, 6);
  if (tokens.length) {
    where.AND = tokens.map((t) => ({
      OR: ['employeeId', 'firstName', 'middleName', 'lastName', 'email'].map((f) => ({
        [f]: { contains: t, mode: 'insensitive' },
      })),
    }));
  }

  const include = { _count: { select: { assignments: true } } };
  const shape = (u) => ({ ...publicUser(u), assignmentCount: u._count.assignments });

  if (limit) {
    const [total, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include,
      }),
    ]);
    return res.json({ users: rows.map(shape), total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) });
  }

  const users = await prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, include });
  return res.json({ users: users.map(shape) });
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

/* ------------------------------------------------------------------ */
/*  Bulk create users from a CSV file                                  */
/* ------------------------------------------------------------------ */

const MAX_BULK_ROWS = 2000;

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.csv') return cb(badRequest('Only .csv files are allowed'));
    return cb(null, true);
  },
});

const HEADER_ALIASES = {
  employeeid: 'employeeId', empid: 'employeeId', employeecode: 'employeeId', employeeno: 'employeeId',
  firstname: 'firstName', middlename: 'middleName', lastname: 'lastName', surname: 'lastName',
  email: 'email', emailid: 'email', emailaddress: 'email',
};

/** Small RFC-4180 CSV parser (quotes, escaped quotes, CRLF, BOM, comma / semicolon / tab). */
function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = count(';') > count(',') ? ';' : (count('\t') > count(',') ? '\t' : ',');

  const rows = [];
  let cells = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      cells.push(field); field = '';
    } else if (c === '\n') {
      cells.push(field); rows.push({ line: startLine, cells });
      cells = []; field = ''; line += 1; startLine = line;
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || cells.length) { cells.push(field); rows.push({ line: startLine, cells }); }
  return rows;
}

/** GET /api/admin/users/csv-template — sample file the admin can fill in */
router.get('/csv-template', (_req, res) => {
  const csv = toCsv([
    ['employeeId', 'firstName', 'middleName', 'lastName', 'email'],
    ['EMP001', 'Rahul', 'Kumar', 'Sharma', 'rahul.sharma@example.com'],
    ['EMP002', 'Priya', '', 'Nair', 'priya.nair@example.com'],
    ['EMP003', 'Arun', 'S', 'Kumar', 'arun.kumar@example.com'],
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="users_sample.csv"');
  res.send(`\uFEFF${csv}\r\n`); // BOM so Excel opens it correctly
});

/**
 * POST /api/admin/users/bulk  (multipart, field "file")
 * Columns: employeeId, firstName, middleName (optional), lastName, email.
 * Valid rows are created with the default password; bad / duplicate rows are reported back.
 */
router.post('/bulk', csvUpload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Please choose a CSV file');

  const rows = parseCsv(req.file.buffer.toString('utf8')).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (rows.length < 2) throw badRequest('The CSV file has no data rows — add at least one user below the header row');
  if (rows.length - 1 > MAX_BULK_ROWS) throw badRequest(`Too many rows — upload at most ${MAX_BULK_ROWS} users at a time`);

  // map column positions from the header row
  const col = {};
  rows[0].cells.forEach((h, idx) => {
    const key = HEADER_ALIASES[h.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (key && !(key in col)) col[key] = idx;
  });
  const missing = ['employeeId', 'firstName', 'lastName', 'email'].filter((k) => !(k in col));
  if (missing.length) {
    throw badRequest(`Missing column(s) in the header row: ${missing.join(', ')}. Expected: employeeId, firstName, middleName, lastName, email`);
  }

  const existing = await prisma.user.findMany({ select: { employeeId: true, email: true } });
  const usedIds = new Set(existing.map((u) => u.employeeId.toLowerCase()));
  const usedEmails = new Set(existing.map((u) => u.email.toLowerCase()));

  const passwordHash = await bcrypt.hash(config.defaultUserPassword, 12); // same password for all -> hash once
  const created = [];
  const errors = [];

  for (const { line, cells } of rows.slice(1)) {
    const get = (k) => (k in col ? (cells[col[k]] ?? '').trim() : '');
    const raw = {
      employeeId: get('employeeId'), firstName: get('firstName'), middleName: get('middleName'),
      lastName: get('lastName'), email: get('email'),
    };
    const fail = (reason) => errors.push({ row: line, employeeId: raw.employeeId, email: raw.email, reason });

    const parsed = userSchema.safeParse(raw);
    if (!parsed.success) { fail(parsed.error.issues[0]?.message || 'Invalid row'); continue; }
    const data = parsed.data;

    if (usedIds.has(data.employeeId.toLowerCase())) { fail('Employee ID already exists (or is repeated in this file)'); continue; }
    if (usedEmails.has(data.email)) { fail('Email already exists (or is repeated in this file)'); continue; }

    try {
      const user = await prisma.user.create({ data: { ...data, role: 'USER', passwordHash } });
      usedIds.add(data.employeeId.toLowerCase());
      usedEmails.add(data.email);
      created.push({ id: user.id, employeeId: user.employeeId, fullName: [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' '), email: user.email });
      await logActivity({
        action: 'USER_CREATED', entityType: 'User', entityId: user.id, actor: req.user,
        details: { employeeId: user.employeeId, email: user.email, bulk: true },
      });
    } catch (err) {
      fail(err?.code === 'P2002' ? 'Employee ID or email already exists' : 'Could not be created');
    }
  }

  res.json({
    total: rows.length - 1,
    createdCount: created.length,
    failedCount: errors.length,
    created,
    errors,
    defaultPassword: config.defaultUserPassword,
  });
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