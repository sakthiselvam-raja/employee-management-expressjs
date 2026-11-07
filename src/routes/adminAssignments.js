import { Router } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, toId } from '../lib/errors.js';
import { dirs, removePath, safeFileName } from '../lib/storage.js';
import { logActivity, parseWorkDate, fullName, formatWorkDate } from '../lib/activity.js';
import {
  assignmentInclude, serializeAssignment, serializeSubmission, statusUpdateData, validateAssignmentInput,
} from '../lib/assignments.js';
import { streamAssignmentZip } from './adminUploads.js';

const router = Router();

const STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED'];

const assignmentSchema = z
  .object({
    userId: z.coerce.number().int().positive('Select a user'),
    zipUploadId: z.coerce.number().int().positive('Select an uploaded ZIP'),
    workDate: z.string().refine((v) => parseWorkDate(v), 'Working date must be YYYY-MM-DD'),
    excelFileIds: z.array(z.coerce.number().int().positive()).default([]),
    imageRanges: z
      .array(
        z.object({
          imageFolderId: z.coerce.number().int().positive(),
          startPosition: z.coerce.number().int().min(1, 'Range start must be 1 or more'),
          endPosition: z.coerce.number().int().min(1, 'Range end must be 1 or more'),
        }),
      )
      .default([]),
    adminNotes: z.string().trim().max(2000).optional().nullable().transform((v) => v || null),
  })
  .refine((v) => v.excelFileIds.length || v.imageRanges.length, {
    message: 'Assign at least one Excel file or one image range',
    path: ['excelFileIds'],
  });

const rangeSummary = (ranges) => ranges.map((r) => ({ folderId: r.imageFolderId, start: r.startPosition, end: r.endPosition }));

async function loadAssignment(id) {
  const a = await prisma.assignment.findUnique({ where: { id }, include: assignmentInclude });
  if (!a) throw notFound('Assignment not found');
  return a;
}

/**
 * GET /api/admin/assignments
 * Filters: date=YYYY-MM-DD | from & to, status, userId, zipUploadId, search (user name / employee ID / email)
 * Pagination (optional): page & pageSize (5-100) -> { assignments, total, page, pageSize, pages, counts }
 * Without pageSize the old behaviour is kept (up to 2000 rows).
 */
router.get('/', async (req, res) => {
  const where = {};
  const { date, from, to, status, userId, zipUploadId } = req.query;

  if (date) {
    const d = parseWorkDate(date);
    if (!d) throw badRequest('Invalid date');
    where.workDate = d;
  } else if (from || to) {
    where.workDate = {};
    if (from) where.workDate.gte = parseWorkDate(from) ?? undefined;
    if (to) where.workDate.lte = parseWorkDate(to) ?? undefined;
  }
  if (userId) where.userId = toId(userId, 'userId');
  if (zipUploadId) where.zipUploadId = toId(zipUploadId, 'zipUploadId');

  const tokens = String(req.query.search || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (tokens.length) {
    where.user = {
      AND: tokens.map((t) => ({
        OR: ['employeeId', 'firstName', 'middleName', 'lastName', 'email'].map((f) => ({ [f]: { contains: t, mode: 'insensitive' } })),
      })),
    };
  }

  const whereNoStatus = { ...where }; // status counts ignore the status filter itself
  if (status && STATUSES.includes(status)) where.status = status;
  const orderBy = [{ workDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];

  if (req.query.pageSize) {
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const page = Math.max(1, Number(req.query.page) || 1);
    const [total, rows, grouped] = await Promise.all([
      prisma.assignment.count({ where }),
      prisma.assignment.findMany({ where, include: assignmentInclude, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.assignment.groupBy({ by: ['status'], where: whereNoStatus, _count: { _all: true } }),
    ]);
    const counts = { PENDING: 0, PROCESSING: 0, COMPLETED: 0 };
    grouped.forEach((g) => { counts[g.status] = g._count._all; });
    return res.json({
      assignments: rows.map(serializeAssignment), total, page, pageSize, pages: Math.max(Math.ceil(total / pageSize), 1), counts,
    });
  }

  const assignments = await prisma.assignment.findMany({ where, include: assignmentInclude, orderBy, take: 2000 });
  return res.json({ assignments: assignments.map(serializeAssignment) });
});

router.get('/:id', async (req, res) => {
  const id = toId(req.params.id);
  const a = await loadAssignment(id);
  const submissions = await prisma.submission.findMany({
    where: { assignmentId: id },
    include: { uploadedBy: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ assignment: serializeAssignment(a), submissions: submissions.map(serializeSubmission) });
});

/** POST /api/admin/assignments */
router.post('/', async (req, res) => {
  const input = assignmentSchema.parse(req.body);
  const workDate = parseWorkDate(input.workDate);
  const { user, excelFileIds } = await validateAssignmentInput({ ...input, workDate });

  const created = await prisma.assignment.create({
    data: {
      userId: input.userId,
      zipUploadId: input.zipUploadId,
      workDate,
      adminNotes: input.adminNotes,
      assignedById: req.user.id,
      excelFiles: { create: excelFileIds.map((excelFileId) => ({ excelFileId })) },
      imageRanges: { create: input.imageRanges },
    },
    include: assignmentInclude,
  });

  await logActivity({
    action: 'ASSIGNMENT_CREATED', entityType: 'Assignment', entityId: created.id, actor: req.user,
    details: {
      user: `${fullName(user)} (${user.employeeId})`,
      zipUploadId: input.zipUploadId,
      zipName: created.zipUpload.originalName,
      workDate: input.workDate,
      excelFiles: created.excelFiles.map((x) => x.excelFile.relativePath),
      imageRanges: created.imageRanges.map((r) => `${r.imageFolder.relativePath || '(root)'}: ${r.startPosition}-${r.endPosition}`),
    },
  });
  res.status(201).json({ assignment: serializeAssignment(created) });
});

/** PUT /api/admin/assignments/:id — modify or reassign (change user / date / files / ranges) */
router.put('/:id', async (req, res) => {
  const id = toId(req.params.id);
  const before = await loadAssignment(id);
  const input = assignmentSchema.parse(req.body);
  if (input.zipUploadId !== before.zipUploadId) throw badRequest('An assignment cannot be moved to a different ZIP');

  const workDate = parseWorkDate(input.workDate);
  const { user, excelFileIds } = await validateAssignmentInput({ ...input, workDate }, id);
  const reassigned = before.userId !== input.userId;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.assignmentExcel.deleteMany({ where: { assignmentId: id } });
    await tx.assignmentImageRange.deleteMany({ where: { assignmentId: id } });
    return tx.assignment.update({
      where: { id },
      data: {
        userId: input.userId,
        workDate,
        adminNotes: input.adminNotes,
        ...(reassigned ? { status: 'PENDING', startedAt: null, completedAt: null } : {}),
        excelFiles: { create: excelFileIds.map((excelFileId) => ({ excelFileId })) },
        imageRanges: { create: input.imageRanges },
      },
      include: assignmentInclude,
    });
  });

  await logActivity({
    action: reassigned ? 'ASSIGNMENT_REASSIGNED' : 'ASSIGNMENT_UPDATED', entityType: 'Assignment', entityId: id, actor: req.user,
    details: {
      from: { user: `${fullName(before.user)} (${before.user.employeeId})`, workDate: formatWorkDate(before.workDate), excelFileIds: before.excelFiles.map((x) => x.excelFileId), imageRanges: rangeSummary(before.imageRanges) },
      to: { user: `${fullName(user)} (${user.employeeId})`, workDate: input.workDate, excelFileIds, imageRanges: rangeSummary(input.imageRanges) },
    },
  });
  res.json({ assignment: serializeAssignment(updated) });
});

/** PATCH /api/admin/assignments/:id/status { status } */
router.patch('/:id/status', async (req, res) => {
  const id = toId(req.params.id);
  const { status } = z.object({ status: z.enum(STATUSES) }).parse(req.body);
  const before = await loadAssignment(id);
  const updated = await prisma.assignment.update({
    where: { id },
    data: statusUpdateData(before, status),
    include: assignmentInclude,
  });
  await logActivity({
    action: 'STATUS_CHANGED', entityType: 'Assignment', entityId: id, actor: req.user,
    details: { from: before.status, to: status, user: before.user.employeeId, workDate: formatWorkDate(before.workDate) },
  });
  res.json({ assignment: serializeAssignment(updated) });
});

/** POST /api/admin/assignments/bulk-status { ids: [], status } */
router.post('/bulk-status', async (req, res) => {
  const { ids, status } = z.object({ ids: z.array(z.number().int().positive()).min(1), status: z.enum(STATUSES) }).parse(req.body);
  const list = await prisma.assignment.findMany({ where: { id: { in: ids } } });
  await prisma.$transaction(list.map((a) => prisma.assignment.update({ where: { id: a.id }, data: statusUpdateData(a, status) })));
  await logActivity({ action: 'STATUS_CHANGED_BULK', entityType: 'Assignment', actor: req.user, details: { ids: list.map((a) => a.id), to: status } });
  res.json({ updated: list.length });
});

/** GET /api/admin/assignments/:id/download — assigned files + user submissions */
router.get('/:id/download', async (req, res) => {
  const a = await loadAssignment(toId(req.params.id));
  await streamAssignmentZip(res, a, `${formatWorkDate(a.workDate)}_${safeFileName(a.user.employeeId)}_A${a.id}`);
});

/** DELETE /api/admin/assignments/:id — removes the assignment and the files the user submitted */
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id);
  const a = await loadAssignment(id);
  await prisma.assignment.delete({ where: { id } });
  await removePath(path.join(dirs.submissions, String(id)));
  await logActivity({
    action: 'ASSIGNMENT_DELETED', entityType: 'Assignment', entityId: id, actor: req.user,
    details: {
      user: `${fullName(a.user)} (${a.user.employeeId})`,
      zipName: a.zipUpload.originalName,
      workDate: formatWorkDate(a.workDate),
      status: a.status,
      completedAt: a.completedAt,
      submissions: a._count.submissions,
    },
  });
  res.json({ message: 'Assignment deleted' });
});

export default router;