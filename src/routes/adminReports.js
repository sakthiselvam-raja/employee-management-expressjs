import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { badRequest } from '../lib/errors.js';
import { fullName, parseWorkDate, publicUser } from '../lib/activity.js';
import { serializeSubmission } from '../lib/assignments.js';

const router = Router();

const pageParams = (q) => {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize };
};

/** GET /api/admin/dashboard?date=YYYY-MM-DD */
router.get('/dashboard', async (req, res) => {
  const date = parseWorkDate(req.query.date || new Date().toISOString().slice(0, 10));
  if (!date) throw badRequest('Invalid date');

  const [activeUsers, totalUsers, uploads, dayAssignments, recentSubmissions] = await Promise.all([
    prisma.user.count({ where: { role: 'USER', isActive: true } }),
    prisma.user.count({ where: { role: 'USER' } }),
    prisma.zipUpload.count(),
    prisma.assignment.findMany({
      where: { workDate: date },
      include: { user: true, imageRanges: true, _count: { select: { excelFiles: true, submissions: true } } },
    }),
    prisma.submission.findMany({
      take: 8,
      orderBy: { createdAt: 'desc' },
      include: { uploadedBy: true, assignment: { select: { id: true, workDate: true, zipUpload: { select: { originalName: true } } } } },
    }),
  ]);

  const byStatus = { PENDING: 0, PROCESSING: 0, COMPLETED: 0 };
  const perUser = new Map();
  for (const a of dayAssignments) {
    byStatus[a.status] += 1;
    if (!perUser.has(a.userId)) {
      perUser.set(a.userId, { user: publicUser(a.user), total: 0, PENDING: 0, PROCESSING: 0, COMPLETED: 0, images: 0, excel: 0 });
    }
    const p = perUser.get(a.userId);
    p.total += 1;
    p[a.status] += 1;
    p.images += a.imageRanges.reduce((s, r) => s + r.endPosition - r.startPosition + 1, 0);
    p.excel += a._count.excelFiles;
  }

  res.json({
    date: req.query.date,
    stats: { activeUsers, totalUsers, uploads, assignments: dayAssignments.length, ...byStatus },
    perUser: [...perUser.values()].sort((a, b) => a.user.fullName.localeCompare(b.user.fullName)),
    recentSubmissions: recentSubmissions.map((s) => ({
      ...serializeSubmission(s),
      zipName: s.assignment.zipUpload.originalName,
      workDate: s.assignment.workDate.toISOString().slice(0, 10),
    })),
  });
});

/** GET /api/admin/history/files — every file that entered the system: ZIPs (admin) + Excel re-uploads (users) */
router.get('/history/files', async (req, res) => {
  const { page, pageSize } = pageParams(req.query);
  const who = String(req.query.uploadedBy || 'all'); // all | ADMIN | USER
  const take = page * pageSize;

  const [zips, subs, zipCount, subCount] = await Promise.all([
    who === 'USER' ? [] : prisma.zipUpload.findMany({
      take, orderBy: { createdAt: 'desc' },
      include: {
        uploadedBy: true,
        excelFiles: { select: { relativePath: true, sheetNames: true } },
        imageFolders: { select: { name: true, relativePath: true, imageCount: true } },
      },
    }),
    who === 'ADMIN' ? [] : prisma.submission.findMany({
      take, orderBy: { createdAt: 'desc' }, where: { storagePath: { not: null } },
      include: { uploadedBy: true, assignment: { select: { id: true, workDate: true, zipUpload: { select: { originalName: true } } } } },
    }),
    who === 'USER' ? 0 : prisma.zipUpload.count(),
    who === 'ADMIN' ? 0 : prisma.submission.count({ where: { storagePath: { not: null } } }),
  ]);

  const rows = [
    ...zips.map((z) => ({
      key: `zip-${z.id}`,
      kind: 'ZIP',
      id: z.id,
      originalName: z.originalName,
      storedName: z.storedName,
      storagePath: z.zipPath,
      extractPath: z.extractPath,
      sizeBytes: Number(z.sizeBytes),
      uploadedBy: { id: z.uploadedBy.id, fullName: fullName(z.uploadedBy), employeeId: z.uploadedBy.employeeId },
      uploadedByRole: z.uploadedByRole,
      createdAt: z.createdAt,
      excelFiles: z.excelFiles,
      imageFolders: z.imageFolders,
    })),
    ...subs.map((s) => ({
      key: `sub-${s.id}`,
      kind: 'SUBMISSION',
      id: s.id,
      originalName: s.originalName,
      storedName: s.storedName,
      storagePath: s.storagePath,
      sizeBytes: s.sizeBytes,
      notes: s.notes,
      uploadedBy: { id: s.uploadedBy.id, fullName: fullName(s.uploadedBy), employeeId: s.uploadedBy.employeeId },
      uploadedByRole: s.uploadedByRole,
      createdAt: s.createdAt,
      assignmentId: s.assignment.id,
      workDate: s.assignment.workDate.toISOString().slice(0, 10),
      zipName: s.assignment.zipUpload.originalName,
    })),
  ]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice((page - 1) * pageSize, page * pageSize);

  res.json({ rows, page, pageSize, total: zipCount + subCount });
});

/** GET /api/admin/history/activity?action=&page= — permanent audit trail (survives deletes) */
router.get('/history/activity', async (req, res) => {
  const { page, pageSize, skip } = pageParams(req.query);
  const where = {};
  if (req.query.action) where.action = String(req.query.action);
  if (req.query.entityType) where.entityType = String(req.query.entityType);

  const [rows, total, actions] = await Promise.all([
    prisma.activityLog.findMany({ where, skip, take: pageSize, orderBy: { createdAt: 'desc' }, include: { actor: true } }),
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
  ]);

  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      actor: r.actor ? { id: r.actor.id, fullName: fullName(r.actor), employeeId: r.actor.employeeId } : null,
      actorRole: r.actorRole,
      details: r.details,
      createdAt: r.createdAt,
    })),
    total,
    page,
    pageSize,
    actions: actions.map((a) => a.action),
  });
});

export default router;
