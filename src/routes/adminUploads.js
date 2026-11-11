import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { HttpError, badRequest, conflict, notFound, toId } from '../lib/errors.js';
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

const GB = 1024 ** 3;
const gb = (n) => (n / GB).toFixed(1);
const DISK_FACTOR = 2.3; // ZIP copy + extracted copy + some headroom

async function freeDiskBytes() {
  const st = await fsp.statfs(dirs.root);
  return Number(st.bavail) * Number(st.bsize);
}

/** Reject early — before gigabytes are transferred — when the ZIP is too big or the disk is too full. */
async function preflight(req, _res, next) {
  const len = Number(req.headers['content-length']);
  if (len) {
    if (len > config.maxZipBytes + 10 * 1024 * 1024) {
      throw new HttpError(413, `This ZIP is ${gb(len)} GB. The allowed maximum is ${gb(config.maxZipBytes)} GB.`);
    }
    const free = await freeDiskBytes().catch(() => null);
    if (free !== null && free < len * DISK_FACTOR) {
      throw new HttpError(507, `Not enough free disk space on the server: about ${gb(len * DISK_FACTOR)} GB needed, ${gb(free)} GB free.`);
    }
  }
  next();
}

/** GET /api/admin/uploads/limits — what the upload page shows and checks before sending a big file */
router.get('/limits', async (_req, res) => {
  const free = await freeDiskBytes().catch(() => null);
  res.json({ maxZipBytes: config.maxZipBytes, maxExtractedBytes: config.maxExtractedBytes, freeDiskBytes: free, diskFactor: DISK_FACTOR });
});

/** POST /api/admin/uploads  (multipart, field "file") — upload + extract + index */
router.post('/', preflight, upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Please choose a ZIP file');

  const originalName = fixOriginalName(req.file.originalname);
  const key = uniqueKey();
  const storedName = `${key}_${safeFileName(originalName, 'upload.zip')}`;
  const zipAbs = path.join(dirs.zips, storedName);
  const extractAbs = path.join(dirs.extracted, key);
  let createdId = null;

  try {
    await fsp.rename(req.file.path, zipAbs);
    await fsp.mkdir(extractAbs, { recursive: true });
    const files = await extractZip(zipAbs, extractAbs, { maxTotalBytes: config.maxExtractedBytes });
    const { excelFiles, imageFolders } = await scanExtracted(extractAbs, files);

    if (!excelFiles.length && !imageFolders.length) {
      throw badRequest('No Excel files or images were found in this ZIP');
    }

    // 1) the ZIP, its Excel files and the (empty) folders
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
          create: imageFolders.map((f) => ({ name: f.name, relativePath: f.relativePath, imageCount: f.images.length })),
        },
      },
      include: { imageFolders: { select: { id: true, relativePath: true } } },
    });
    createdId = created.id;

    // 2) the images, in chunks (a ZIP can hold tens of thousands of images — one huge insert would hit database limits)
    const folderIdByPath = new Map(created.imageFolders.map((f) => [f.relativePath, f.id]));
    const CHUNK = 5000;
    for (const f of imageFolders) {
      const folderId = folderIdByPath.get(f.relativePath);
      for (let i = 0; i < f.images.length; i += CHUNK) {
        await prisma.imageFile.createMany({
          data: f.images.slice(i, i + CHUNK).map((img) => ({
            folderId,
            position: img.position,
            fileName: img.fileName,
            relativePath: img.relativePath,
            storagePath: `${toStoredPath(extractAbs)}/${img.relativePath}`,
            sizeBytes: img.sizeBytes,
          })),
        });
      }
    }

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
    // roll back everything: half-indexed database rows and the files on disk
    if (createdId) await prisma.zipUpload.delete({ where: { id: createdId } }).catch(() => {});
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

/** GET /api/admin/uploads/:id/submissions-download — only the files users submitted (no original ZIP content) */
router.get('/:id/submissions-download', async (req, res) => {
  const id = toId(req.params.id);
  const u = await prisma.zipUpload.findUnique({
    where: { id },
    include: { assignments: { include: { user: true }, orderBy: [{ workDate: 'asc' }, { id: 'asc' }] } },
  });
  if (!u) throw notFound('Upload not found');

  const base = path.basename(u.originalName, path.extname(u.originalName));
  await streamZip(res, `${base}_submissions.zip`, async (archive) => {
    for (const a of u.assignments) {
      const folder = `${formatWorkDate(a.workDate)}_${safeFileName(a.user.employeeId)}_A${a.id}`;
      const subs = await prisma.submission.findMany({ where: { assignmentId: a.id }, orderBy: { createdAt: 'asc' } });
      for (const s of subs) {
        if (s.storagePath) archive.file(fromStoredPath(s.storagePath), { name: `${folder}/${s.storedName}` });
      }
      const notes = subs.filter((s) => s.notes).map((s) => `[${s.createdAt.toISOString()}] ${s.originalName || '(no file)'}\n${s.notes}\n`);
      if (notes.length) archive.append(notes.join('\n'), { name: `${folder}/notes.txt` });
    }
  });

  await logActivity({ action: 'ZIP_DOWNLOADED', entityType: 'ZipUpload', entityId: id, actor: req.user, details: { originalName: u.originalName, submissionsOnly: true } });
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
  const to = Number(req.query.to) || 2147483647;
  const folder = await prisma.imageFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw notFound('Folder not found');
  const where = { folderId, position: { gte: from, lte: to } };
  const select = { id: true, position: true, fileName: true, sizeBytes: true };

  // optional pagination: ?page=1&pageSize=24 (pageSize 5-100); without pageSize every image is returned
  if (req.query.pageSize) {
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 24));
    const page = Math.max(1, Number(req.query.page) || 1);
    const [total, images] = await Promise.all([
      prisma.imageFile.count({ where }),
      prisma.imageFile.findMany({ where, orderBy: { position: 'asc' }, select, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ folder, images, total, page, pageSize });
  }
  const images = await prisma.imageFile.findMany({ where, orderBy: { position: 'asc' }, select });
  return res.json({ folder, images });
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