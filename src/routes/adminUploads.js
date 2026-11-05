import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { badRequest, conflict, notFound, toId } from '../lib/errors.js';
import {
  dirs, uniqueKey, toStoredPath, fromStoredPath, removePath, assertFileExists, fixOriginalName, safeFileName,
} from '../lib/storage.js';
import { extractZip, scanExtracted } from '../lib/zip.js';
import { previewSpreadsheet } from '../lib/excel.js';
import { streamZip, toCsv } from '../lib/archive.js';
import { logActivity, fullName, formatWorkDate } from '../lib/activity.js';
import { addAssignmentToArchive, assignmentInclude } from '../lib/assignments.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dirs.tmp),
    filename: (_req, _file, cb) => cb(null, `${uniqueKey()}.upload`),
  }),
  limits: { fileSize: config.maxZipBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') return cb(badRequest('Only .zip files are allowed'));
    return cb(null, true);
  },
});

const uploaderSelect = { select: { id: true, firstName: true, middleName: true, lastName: true, employeeId: true, role: true } };

function statusSummary(assignments) {
  const s = { total: assignments.length, PENDING: 0, PROCESSING: 0, COMPLETED: 0 };
  for (const a of assignments) s[a.status] += 1;
  s.allCompleted = s.total > 0 && s.COMPLETED === s.total;
  return s;
}

/** POST /api/admin/uploads  (multipart, field "file") — upload + extract + index */
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Please choose a ZIP file');

  const originalName = fixOriginalName(req.file.originalname);
  const key = uniqueKey();
  const storedName = `${key}_${safeFileName(originalName, 'upload.zip')}`;
  const zipAbs = path.join(dirs.zips, storedName);
  const extractAbs = path.join(dirs.extracted, key);

  try {
    await fsp.rename(req.file.path, zipAbs);
    await fsp.mkdir(extractAbs, { recursive: true });
    const files = await extractZip(zipAbs, extractAbs, { maxTotalBytes: config.maxExtractedBytes });
    const { excelFiles, imageFolders } = await scanExtracted(extractAbs, files);

    if (!excelFiles.length && !imageFolders.length) {
      throw badRequest('No Excel files or images were found in this ZIP');
    }

    const created = await prisma.zipUpload.create({
      data: {
        originalName,
        storedName,
        zipPath: toStoredPath(zipAbs),
        extractPath: toStoredPath(extractAbs),
        sizeBytes: BigInt(req.file.size),
        totalFiles: files.length,
        uploadedById: req.user.id,
        uploadedByRole: req.user.role,
        excelFiles: {
          create: excelFiles.map((e) => ({
            fileName: e.fileName,
            relativePath: e.relativePath,
            storagePath: toStoredPath(e.abs),
            sizeBytes: e.sizeBytes,
            sheetNames: e.sheetNames,
          })),
        },
        imageFolders: {
          create: imageFolders.map((f) => ({
            name: f.name,
            relativePath: f.relativePath,
            imageCount: f.images.length,
            images: {
              createMany: {
                data: f.images.map((img) => ({
                  position: img.position,
                  fileName: img.fileName,
                  relativePath: img.relativePath,
                  storagePath: `${toStoredPath(extractAbs)}/${img.relativePath}`,
                  sizeBytes: img.sizeBytes,
                })),
              },
            },
          })),
        },
      },
    });

    await logActivity({
      action: 'ZIP_UPLOADED', entityType: 'ZipUpload', entityId: created.id, actor: req.user,
      details: {
        originalName,
        storedName,
        zipPath: created.zipPath,
        extractPath: created.extractPath,
        sizeBytes: req.file.size,
        totalFiles: files.length,
        excelFiles: excelFiles.map((e) => ({ name: e.relativePath, sheets: e.sheetNames })),
        imageFolders: imageFolders.map((f) => ({ name: f.relativePath || '(root)', images: f.images.length })),
      },
    });

    res.status(201).json({
      upload: { id: created.id, originalName },
      summary: {
        totalFiles: files.length,
        excelFiles: excelFiles.length,
        imageFolders: imageFolders.length,
        totalImages: imageFolders.reduce((s, f) => s + f.images.length, 0),
      },
    });
  } catch (err) {
    await Promise.all([removePath(req.file.path), removePath(zipAbs), removePath(extractAbs)]);
    throw err;
  }
});

/** GET /api/admin/uploads — list with counts and assignment progress */
router.get('/', async (_req, res) => {
  const uploads = await prisma.zipUpload.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      uploadedBy: uploaderSelect,
      imageFolders: { select: { imageCount: true } },
      assignments: { select: { status: true } },
      _count: { select: { excelFiles: true, imageFolders: true } },
    },
  });

  res.json({
    uploads: uploads.map((u) => ({
      id: u.id,
      originalName: u.originalName,
      storedName: u.storedName,
      zipPath: u.zipPath,
      extractPath: u.extractPath,
      sizeBytes: u.sizeBytes,
      totalFiles: u.totalFiles,
      createdAt: u.createdAt,
      uploadedBy: { ...u.uploadedBy, fullName: fullName(u.uploadedBy) },
      uploadedByRole: u.uploadedByRole,
      excelCount: u._count.excelFiles,
      folderCount: u._count.imageFolders,
      imageCount: u.imageFolders.reduce((s, f) => s + f.imageCount, 0),
      assignmentSummary: statusSummary(u.assignments),
    })),
  });
});

/** GET /api/admin/uploads/:id — Excel files, image folders (+ who has which range) */
router.get('/:id', async (req, res) => {
  const id = toId(req.params.id);
  const u = await prisma.zipUpload.findUnique({
    where: { id },
    include: {
      uploadedBy: uploaderSelect,
      excelFiles: {
        orderBy: { relativePath: 'asc' },
        include: { assignments: { include: { assignment: { include: { user: true } } } } },
      },
      imageFolders: {
        orderBy: { relativePath: 'asc' },
        include: { ranges: { include: { assignment: { include: { user: true } } }, orderBy: { startPosition: 'asc' } } },
      },
      assignments: { select: { status: true } },
    },
  });
  if (!u) throw notFound('Upload not found');

  const assignee = (a) => ({
    assignmentId: a.id,
    workDate: formatWorkDate(a.workDate),
    status: a.status,
    userId: a.userId,
    userName: fullName(a.user),
    employeeId: a.user.employeeId,
  });

  res.json({
    upload: {
      id: u.id,
      originalName: u.originalName,
      storedName: u.storedName,
      zipPath: u.zipPath,
      extractPath: u.extractPath,
      sizeBytes: u.sizeBytes,
      totalFiles: u.totalFiles,
      createdAt: u.createdAt,
      uploadedBy: { ...u.uploadedBy, fullName: fullName(u.uploadedBy) },
      uploadedByRole: u.uploadedByRole,
      assignmentSummary: statusSummary(u.assignments),
      totalImages: u.imageFolders.reduce((s, f) => s + f.imageCount, 0),
      excelFiles: u.excelFiles.map((e) => ({
        id: e.id,
        fileName: e.fileName,
        relativePath: e.relativePath,
        storagePath: e.storagePath,
        sizeBytes: e.sizeBytes,
        sheetNames: e.sheetNames,
        assignedTo: e.assignments.map((l) => assignee(l.assignment)),
      })),
      imageFolders: u.imageFolders.map((f) => ({
        id: f.id,
        name: f.name,
        relativePath: f.relativePath,
        imageCount: f.imageCount,
        ranges: f.ranges.map((r) => ({
          id: r.id,
          startPosition: r.startPosition,
          endPosition: r.endPosition,
          ...assignee(r.assignment),
        })),
      })),
    },
  });
});

/** GET /api/admin/uploads/:id/download — everything: extracted files + user submissions + summary CSV */
router.get('/:id/download', async (req, res) => {
  const id = toId(req.params.id);
  const u = await prisma.zipUpload.findUnique({
    where: { id },
    include: { assignments: { include: assignmentInclude, orderBy: [{ workDate: 'asc' }, { id: 'asc' }] } },
  });
  if (!u) throw notFound('Upload not found');

  const base = path.basename(u.originalName, path.extname(u.originalName));
  await streamZip(res, `${base}_export.zip`, async (archive) => {
    archive.directory(fromStoredPath(u.extractPath), 'original_files');

    const rows = [['Assignment ID', 'Work date', 'Employee ID', 'User', 'Status', 'Excel files', 'Image ranges', 'Completed at']];
    for (const a of u.assignments) {
      rows.push([
        a.id,
        formatWorkDate(a.workDate),
        a.user.employeeId,
        fullName(a.user),
        a.status,
        a.excelFiles.map((x) => x.excelFile.relativePath).join('; '),
        a.imageRanges.map((r) => `${r.imageFolder.relativePath || '(root)'} ${r.startPosition}-${r.endPosition}`).join('; '),
        a.completedAt ? a.completedAt.toISOString() : '',
      ]);
      const folder = `user_work/${formatWorkDate(a.workDate)}_${safeFileName(a.user.employeeId)}_A${a.id}`;
      const subs = await prisma.submission.findMany({ where: { assignmentId: a.id } });
      for (const s of subs) {
        if (s.storagePath) archive.file(fromStoredPath(s.storagePath), { name: `${folder}/${s.storedName}` });
      }
      const notes = subs.filter((s) => s.notes).map((s) => `[${s.createdAt.toISOString()}] ${s.originalName || '(no file)'}\n${s.notes}\n`);
      if (notes.length) archive.append(notes.join('\n'), { name: `${folder}/notes.txt` });
    }
    archive.append(toCsv(rows), { name: 'assignments_summary.csv' });
  });

  await logActivity({ action: 'ZIP_DOWNLOADED', entityType: 'ZipUpload', entityId: id, actor: req.user, details: { originalName: u.originalName } });
});

/** DELETE /api/admin/uploads/:id?force=true — removes DB rows and all files on disk */
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id);
  const force = req.query.force === 'true';
  const u = await prisma.zipUpload.findUnique({
    where: { id },
    include: {
      assignments: { select: { id: true, status: true } },
      _count: { select: { excelFiles: true, imageFolders: true } },
      imageFolders: { select: { imageCount: true } },
    },
  });
  if (!u) throw notFound('Upload not found');

  const unfinished = u.assignments.filter((a) => a.status !== 'COMPLETED').length;
  if (unfinished && !force) {
    throw conflict(`${unfinished} assignment(s) for this ZIP are not completed yet`, { unfinished });
  }

  await prisma.zipUpload.delete({ where: { id } });
  await Promise.all([
    removePath(fromStoredPath(u.zipPath)),
    removePath(fromStoredPath(u.extractPath)),
    ...u.assignments.map((a) => removePath(path.join(dirs.submissions, String(a.id)))),
  ]);

  await logActivity({
    action: 'ZIP_DELETED', entityType: 'ZipUpload', entityId: id, actor: req.user,
    details: {
      originalName: u.originalName,
      storedName: u.storedName,
      uploadedAt: u.createdAt,
      excelFiles: u._count.excelFiles,
      imageFolders: u._count.imageFolders,
      images: u.imageFolders.reduce((s, f) => s + f.imageCount, 0),
      assignmentsDeleted: u.assignments.length,
      forced: Boolean(unfinished),
    },
  });
  res.json({ message: 'Upload and its files were deleted' });
});

/* ---------- file access for admin ---------- */

export const adminFilesRouter = Router();

adminFilesRouter.get('/folders/:id/images', async (req, res) => {
  const folderId = toId(req.params.id);
  const from = Number(req.query.from) || 1;
  const to = Number(req.query.to) || Number.MAX_SAFE_INTEGER;
  const folder = await prisma.imageFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw notFound('Folder not found');
  const images = await prisma.imageFile.findMany({
    where: { folderId, position: { gte: from, lte: to } },
    orderBy: { position: 'asc' },
    select: { id: true, position: true, fileName: true, sizeBytes: true },
  });
  res.json({ folder, images });
});

adminFilesRouter.get('/images/:id', async (req, res) => {
  const img = await prisma.imageFile.findUnique({ where: { id: toId(req.params.id) } });
  if (!img) throw notFound('Image not found');
  const abs = await assertFileExists(img.storagePath);
  if (req.query.download === '1') return res.download(abs, img.fileName, { dotfiles: 'allow' });
  res.set('Cache-Control', 'private, max-age=3600');
  return res.sendFile(abs, { dotfiles: 'allow' });
});

adminFilesRouter.get('/excel/:id/download', async (req, res) => {
  const e = await prisma.excelFile.findUnique({ where: { id: toId(req.params.id) } });
  if (!e) throw notFound('Excel file not found');
  res.download(await assertFileExists(e.storagePath), e.fileName, { dotfiles: 'allow' });
});

adminFilesRouter.get('/excel/:id/preview', async (req, res) => {
  const e = await prisma.excelFile.findUnique({ where: { id: toId(req.params.id) } });
  if (!e) throw notFound('Excel file not found');
  res.json({ fileName: e.fileName, ...(await previewSpreadsheet(await assertFileExists(e.storagePath))) });
});

adminFilesRouter.get('/submissions/:id/download', async (req, res) => {
  const s = await prisma.submission.findUnique({ where: { id: toId(req.params.id) } });
  if (!s || !s.storagePath) throw notFound('Submitted file not found');
  res.download(await assertFileExists(s.storagePath), s.originalName || s.storedName, { dotfiles: 'allow' });
});

adminFilesRouter.get('/submissions/:id/preview', async (req, res) => {
  const s = await prisma.submission.findUnique({ where: { id: toId(req.params.id) } });
  if (!s || !s.storagePath) throw notFound('Submitted file not found');
  res.json({ fileName: s.originalName, ...(await previewSpreadsheet(await assertFileExists(s.storagePath))) });
});

/** Re-used by the assignments router for a single assignment download */
export async function streamAssignmentZip(res, assignment, label) {
  await streamZip(res, `${label}.zip`, (archive) => addAssignmentToArchive(archive, assignment));
}

export default router;
