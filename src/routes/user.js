import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound, toId } from '../lib/errors.js';
import { appRequestOnly } from '../middleware/appOnly.js';
import {
  dirs, uniqueKey, toStoredPath, removePath, assertFileExists, fixOriginalName, safeFileName,
} from '../lib/storage.js';
import { isExcel } from '../lib/fileTypes.js';
import { previewSpreadsheet } from '../lib/excel.js';
import { streamZip } from '../lib/archive.js';
import { logActivity, parseWorkDate, formatWorkDate } from '../lib/activity.js';
import {
  assignmentInclude, serializeAssignmentFull, serializeAssignmentsFull, serializeSubmission, statusUpdateData, addAssignmentToArchive,
} from '../lib/assignments.js';

const router = Router();

const submissionUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dirs.tmp),
    filename: (_req, _file, cb) => cb(null, `${uniqueKey()}.upload`),
  }),
  limits: { fileSize: config.maxSubmissionBytes, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    if (!isExcel(file.originalname)) return cb(badRequest('Only Excel files (.xlsx, .xlsm, .xls, .csv) can be uploaded'));
    return cb(null, true);
  },
});

/** Every file route goes through this: the assignment must belong to the logged-in user. */
async function loadOwnAssignment(req) {
  const id = toId(req.params.id);
  const a = await prisma.assignment.findUnique({ where: { id }, include: assignmentInclude });
  if (!a) throw notFound('Assignment not found');
  if (a.userId !== req.user.id) throw forbidden('This assignment is not assigned to you');
  return a;
}

/** GET /api/user/assignments?date=&status= */
router.get('/assignments', async (req, res) => {
  const where = { userId: req.user.id };
  if (req.query.date) {
    const d = parseWorkDate(req.query.date);
    if (!d) throw badRequest('Invalid date');
    where.workDate = d;
  }
  if (['PENDING', 'PROCESSING', 'COMPLETED'].includes(req.query.status)) where.status = req.query.status;

  const list = await prisma.assignment.findMany({
    where,
    include: assignmentInclude,
    orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  // Users never need their own profile repeated on every row
  res.json({ assignments: (await serializeAssignmentsFull(list)).map((a) => ({ ...a, user: undefined })) });
});

router.get('/assignments/:id', async (req, res) => {
  const a = await loadOwnAssignment(req);
  const submissions = await prisma.submission.findMany({
    where: { assignmentId: a.id },
    include: { uploadedBy: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    assignment: { ...(await serializeAssignmentFull(a)), user: undefined },
    submissions: submissions.map((s) => ({ ...serializeSubmission(s), storagePath: undefined, storedName: undefined })),
  });
});

/** PATCH /api/user/assignments/:id/status { status: PROCESSING | COMPLETED } */
router.patch('/assignments/:id/status', async (req, res) => {
  const a = await loadOwnAssignment(req);
  const { status } = z.object({ status: z.enum(['PROCESSING', 'COMPLETED']) }).parse(req.body);
  const updated = await prisma.assignment.update({
    where: { id: a.id },
    data: statusUpdateData(a, status),
    include: assignmentInclude,
  });
  await logActivity({
    action: 'STATUS_CHANGED', entityType: 'Assignment', entityId: a.id, actor: req.user,
    details: { from: a.status, to: status, workDate: formatWorkDate(a.workDate) },
  });
  res.json({ assignment: { ...(await serializeAssignmentFull(updated)), user: undefined } });
});

/* ---------- Excel files ---------- */

function findExcel(a, excelId) {
  const link = a.excelFiles.find((x) => x.excelFileId === excelId);
  if (!link) throw forbidden('This Excel file is not part of your assignment');
  return link.excelFile;
}

router.get('/assignments/:id/excel/:excelId/download', async (req, res) => {
  const a = await loadOwnAssignment(req);
  const e = findExcel(a, toId(req.params.excelId));
  res.download(await assertFileExists(e.storagePath), e.fileName, { dotfiles: 'allow' });
});

router.get('/assignments/:id/excel/:excelId/preview', async (req, res) => {
  const a = await loadOwnAssignment(req);
  const e = findExcel(a, toId(req.params.excelId));
  res.json({ fileName: e.fileName, ...(await previewSpreadsheet(await assertFileExists(e.storagePath))) });
});

/* ---------- Images (only inside the user's ranges) ---------- */

function findRange(a, rangeId) {
  const r = a.imageRanges.find((x) => x.id === rangeId);
  if (!r) throw forbidden('This image range is not part of your assignment');
  return r;
}

router.get('/assignments/:id/ranges/:rangeId/images', async (req, res) => {
  const a = await loadOwnAssignment(req);
  const r = findRange(a, toId(req.params.rangeId));
  const where = { folderId: r.imageFolderId, position: { gte: r.startPosition, lte: r.endPosition } };
  const select = { id: true, position: true, fileName: true, sizeBytes: true };
  const range = { id: r.id, folderName: r.imageFolder.name, startPosition: r.startPosition, endPosition: r.endPosition };

  // optional pagination: ?page=1&pageSize=24 (pageSize 5-100); without pageSize every image is returned
  if (req.query.pageSize) {
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 24));
    const page = Math.max(1, Number(req.query.page) || 1);
    const [total, images] = await Promise.all([
      prisma.imageFile.count({ where }),
      prisma.imageFile.findMany({ where, orderBy: { position: 'asc' }, select, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ range, images, total, page, pageSize });
  }
  const images = await prisma.imageFile.findMany({ where, orderBy: { position: 'asc' }, select });
  return res.json({ range, images });
});

router.get('/assignments/:id/images/:imageId', appRequestOnly, async (req, res) => {
  const a = await loadOwnAssignment(req);
  const img = await prisma.imageFile.findUnique({ where: { id: toId(req.params.imageId) } });
  const allowed = img && a.imageRanges.some((r) => r.imageFolderId === img.folderId
    && img.position >= r.startPosition && img.position <= r.endPosition);
  if (!allowed) throw forbidden('This image is not part of your assignment');

  const abs = await assertFileExists(img.storagePath);
  if (req.query.download === '1') return res.download(abs, img.fileName, { dotfiles: 'allow' });
  res.set('Cache-Control', 'private, max-age=3600');
  return res.sendFile(abs, { dotfiles: 'allow' });
});

router.get('/assignments/:id/ranges/:rangeId/download', async (req, res) => {
  const a = await loadOwnAssignment(req);
  const r = findRange(a, toId(req.params.rangeId));
  const images = await prisma.imageFile.findMany({
    where: { folderId: r.imageFolderId, position: { gte: r.startPosition, lte: r.endPosition } },
    orderBy: { position: 'asc' },
  });
  const label = `${safeFileName(r.imageFolder.name)}_${r.startPosition}-${r.endPosition}`;
  await streamZip(res, `${label}.zip`, async (archive) => {
    for (const img of images) {
      archive.file(await assertFileExists(img.storagePath), { name: `${label}/${img.fileName}` });
    }
  });
});

/** Everything assigned (Excel + all image ranges) in one ZIP */
router.get('/assignments/:id/download', async (req, res) => {
  const a = await loadOwnAssignment(req);
  await streamZip(res, `assignment_${a.id}_${formatWorkDate(a.workDate)}.zip`, (archive) =>
    addAssignmentToArchive(archive, a, { includeSubmissions: false }));
});

/* ---------- Re-upload Excel + notes ---------- */

/**
 * POST /api/user/assignments/:id/submissions  (multipart)
 * fields: file (Excel, optional if notes given), notes, markCompleted=true|false
 */
router.post('/assignments/:id/submissions', submissionUpload.single('file'), async (req, res) => {
  let a;
  try {
    a = await loadOwnAssignment(req);
  } catch (err) {
    if (req.file) await removePath(req.file.path);
    throw err;
  }

  const notes = String(req.body?.notes || '').trim().slice(0, 5000) || null;
  if (!req.file && !notes) throw badRequest('Attach an Excel file or write a note');

  let fileData = {};
  if (req.file) {
    const originalName = fixOriginalName(req.file.originalname);
    const storedName = `${uniqueKey()}_${safeFileName(originalName, 'submission.xlsx')}`;
    const destDir = path.join(dirs.submissions, String(a.id));
    await fsp.mkdir(destDir, { recursive: true });
    const destAbs = path.join(destDir, storedName);
    await fsp.rename(req.file.path, destAbs);
    fileData = { originalName, storedName, storagePath: toStoredPath(destAbs), sizeBytes: req.file.size };
  }

  const submission = await prisma.submission.create({
    data: { assignmentId: a.id, uploadedById: req.user.id, uploadedByRole: req.user.role, notes, ...fileData },
    include: { uploadedBy: true },
  });

  let assignment = a;
  if (req.body?.markCompleted === 'true' && a.status !== 'COMPLETED') {
    assignment = await prisma.assignment.update({
      where: { id: a.id }, data: statusUpdateData(a, 'COMPLETED'), include: assignmentInclude,
    });
  } else if (a.status === 'PENDING') {
    assignment = await prisma.assignment.update({
      where: { id: a.id }, data: statusUpdateData(a, 'PROCESSING'), include: assignmentInclude,
    });
  }

  await logActivity({
    action: 'SUBMISSION_UPLOADED', entityType: 'Assignment', entityId: a.id, actor: req.user,
    details: { submissionId: submission.id, file: fileData.originalName || null, storagePath: fileData.storagePath || null, hasNotes: Boolean(notes), statusAfter: assignment.status },
  });

  res.status(201).json({
    submission: { ...serializeSubmission(submission), storagePath: undefined, storedName: undefined },
    assignment: { ...(await serializeAssignmentFull(assignment)), user: undefined },
  });
});

/** POST /api/user/preview-file (multipart "file") — preview of a file the user just chose, nothing is stored */
router.post('/preview-file', submissionUpload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to preview');
  try {
    const originalName = fixOriginalName(req.file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    res.json({ fileName: originalName, ...(await previewSpreadsheet(req.file.path, 2000, ext)) });
  } finally {
    await removePath(req.file.path);
  }
});

router.get('/submissions/:id/preview', async (req, res) => {
  const s = await prisma.submission.findUnique({
    where: { id: toId(req.params.id) },
    include: { assignment: { select: { userId: true } } },
  });
  if (!s || !s.storagePath) throw notFound('File not found');
  if (s.assignment.userId !== req.user.id) throw forbidden();
  res.json({ fileName: s.originalName, ...(await previewSpreadsheet(await assertFileExists(s.storagePath))) });
});

/** DELETE /api/user/submissions/:id — a user can remove their own submission (file + notes) */
router.delete('/submissions/:id', async (req, res) => {
  const s = await prisma.submission.findUnique({
    where: { id: toId(req.params.id) },
    include: { assignment: { select: { id: true, userId: true } } },
  });
  if (!s) throw notFound('Submission not found');
  if (s.assignment.userId !== req.user.id || s.uploadedById !== req.user.id) throw forbidden('You can only delete your own submissions');

  await prisma.submission.delete({ where: { id: s.id } });
  if (s.storagePath) {
    try { await removePath(await assertFileExists(s.storagePath)); } catch { /* file already gone */ }
  }
  await logActivity({
    action: 'SUBMISSION_DELETED', entityType: 'Assignment', entityId: s.assignment.id, actor: req.user,
    details: { submissionId: s.id, file: s.originalName || null, hadNotes: Boolean(s.notes) },
  });
  res.json({ ok: true });
});

router.get('/submissions/:id/download', async (req, res) => {
  const s = await prisma.submission.findUnique({
    where: { id: toId(req.params.id) },
    include: { assignment: { select: { userId: true } } },
  });
  if (!s || !s.storagePath) throw notFound('File not found');
  if (s.assignment.userId !== req.user.id) throw forbidden();
  res.download(await assertFileExists(s.storagePath), s.originalName || s.storedName, { dotfiles: 'allow' });
});

export default router;