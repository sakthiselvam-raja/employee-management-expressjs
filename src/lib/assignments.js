import path from 'node:path';
import { prisma } from './prisma.js';
import { badRequest, conflict, notFound } from './errors.js';
import { formatWorkDate, fullName, publicUser } from './activity.js';
import { fromStoredPath } from './storage.js';
import { addFileIfExists } from './archive.js';

export const assignmentInclude = {
  user: true,
  assignedBy: { select: { id: true, firstName: true, middleName: true, lastName: true, employeeId: true } },
  zipUpload: { select: { id: true, originalName: true, createdAt: true } },
  excelFiles: { include: { excelFile: true }, orderBy: { id: 'asc' } },
  imageRanges: { include: { imageFolder: true }, orderBy: { id: 'asc' } },
  _count: { select: { submissions: true } },
};

export function serializeExcel(e) {
  return {
    id: e.id,
    fileName: e.fileName,
    relativePath: e.relativePath,
    sizeBytes: e.sizeBytes,
    sheetNames: e.sheetNames,
  };
}

export function serializeRange(r) {
  return {
    id: r.id,
    folderId: r.imageFolderId,
    folderName: r.imageFolder?.name,
    folderPath: r.imageFolder?.relativePath,
    folderImageCount: r.imageFolder?.imageCount,
    startPosition: r.startPosition,
    endPosition: r.endPosition,
    startName: r.startName ?? null, // file name of the first / last image of the range (see attachRangeNames)
    endName: r.endName ?? null,
    count: r.endPosition - r.startPosition + 1,
  };
}

/** Map "folderId:position" -> file name for the given [{ folderId, position }] pairs (one query per call). */
export async function imageNameMap(pairs) {
  const byFolder = new Map();
  for (const { folderId, position } of pairs) {
    if (!byFolder.has(folderId)) byFolder.set(folderId, new Set());
    byFolder.get(folderId).add(position);
  }
  const map = new Map();
  if (!byFolder.size) return map;
  const rows = await prisma.imageFile.findMany({
    where: { OR: [...byFolder].map(([folderId, positions]) => ({ folderId, position: { in: [...positions] } })) },
    select: { folderId: true, position: true, fileName: true },
  });
  for (const r of rows) map.set(`${r.folderId}:${r.position}`, r.fileName);
  return map;
}

/** Add startName / endName (image file names) to every image range of the given assignments. */
export async function attachRangeNames(assignments) {
  const ranges = assignments.flatMap((a) => a.imageRanges || []);
  if (!ranges.length) return assignments;
  const pairs = ranges.flatMap((r) => [
    { folderId: r.imageFolderId, position: r.startPosition },
    { folderId: r.imageFolderId, position: r.endPosition },
  ]);
  const names = await imageNameMap(pairs);
  for (const r of ranges) {
    r.startName = names.get(`${r.imageFolderId}:${r.startPosition}`) ?? null;
    r.endName = names.get(`${r.imageFolderId}:${r.endPosition}`) ?? null;
  }
  return assignments;
}

export async function serializeAssignmentFull(a) {
  await attachRangeNames([a]);
  return serializeAssignment(a);
}

export async function serializeAssignmentsFull(list) {
  await attachRangeNames(list);
  return list.map(serializeAssignment);
}

export function serializeAssignment(a) {
  const imageRanges = (a.imageRanges || []).map(serializeRange);
  return {
    id: a.id,
    workDate: formatWorkDate(a.workDate),
    status: a.status,
    adminNotes: a.adminNotes,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    user: a.user ? publicUser(a.user) : undefined,
    assignedBy: a.assignedBy ? { id: a.assignedBy.id, fullName: fullName(a.assignedBy) } : undefined,
    zipUpload: a.zipUpload,
    excelFiles: (a.excelFiles || []).map((x) => serializeExcel(x.excelFile)),
    imageRanges,
    totalImages: imageRanges.reduce((s, r) => s + r.count, 0),
    submissionCount: a._count?.submissions ?? a.submissions?.length ?? 0,
  };
}

export function serializeSubmission(s) {
  return {
    id: s.id,
    assignmentId: s.assignmentId,
    originalName: s.originalName,
    storedName: s.storedName,
    storagePath: s.storagePath,
    sizeBytes: s.sizeBytes,
    notes: s.notes,
    hasFile: Boolean(s.storagePath),
    uploadedByRole: s.uploadedByRole,
    uploadedBy: s.uploadedBy
      ? { id: s.uploadedBy.id, fullName: fullName(s.uploadedBy), employeeId: s.uploadedBy.employeeId }
      : undefined,
    createdAt: s.createdAt,
  };
}

/** Status change with timestamps. Returns data for prisma.assignment.update. */
export function statusUpdateData(current, status) {
  const now = new Date();
  const data = { status };
  if (status === 'PENDING') {
    data.startedAt = null;
    data.completedAt = null;
  } else if (status === 'PROCESSING') {
    data.startedAt = current.startedAt || now;
    data.completedAt = null;
  } else if (status === 'COMPLETED') {
    data.startedAt = current.startedAt || now;
    data.completedAt = now;
  }
  return data;
}

/**
 * Validate an assignment payload:
 * user active, files belong to the ZIP, ranges inside folder, and no range overlaps
 * another user's range for the same folder on the same working date.
 */
export async function validateAssignmentInput(input, excludeAssignmentId = null) {
  const { userId, zipUploadId, workDate, excelFileIds, imageRanges } = input;

  const [user, zip] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.zipUpload.findUnique({ where: { id: zipUploadId }, select: { id: true } }),
  ]);
  if (!user || user.role !== 'USER') throw badRequest('Selected user does not exist');
  if (!user.isActive) throw badRequest('Selected user is deactivated');
  if (!zip) throw notFound('Uploaded ZIP not found');

  const uniqueExcel = [...new Set(excelFileIds)];
  if (uniqueExcel.length) {
    const count = await prisma.excelFile.count({ where: { id: { in: uniqueExcel }, zipUploadId } });
    if (count !== uniqueExcel.length) throw badRequest('One or more Excel files do not belong to this ZIP');
  }

  const folderIds = [...new Set(imageRanges.map((r) => r.imageFolderId))];
  const folders = folderIds.length
    ? await prisma.imageFolder.findMany({ where: { id: { in: folderIds }, zipUploadId } })
    : [];
  const folderMap = new Map(folders.map((f) => [f.id, f]));

  for (const r of imageRanges) {
    const folder = folderMap.get(r.imageFolderId);
    if (!folder) throw badRequest('One or more image folders do not belong to this ZIP');
    if (r.startPosition < 1 || r.endPosition > folder.imageCount || r.startPosition > r.endPosition) {
      throw badRequest(`Range ${r.startPosition}–${r.endPosition} is invalid for folder "${folder.name}" (1–${folder.imageCount})`);
    }
  }

  // Overlaps inside the same request
  for (let i = 0; i < imageRanges.length; i += 1) {
    for (let j = i + 1; j < imageRanges.length; j += 1) {
      const a = imageRanges[i];
      const b = imageRanges[j];
      if (a.imageFolderId === b.imageFolderId && a.startPosition <= b.endPosition && b.startPosition <= a.endPosition) {
        throw badRequest(`Ranges ${a.startPosition}–${a.endPosition} and ${b.startPosition}–${b.endPosition} overlap in folder "${folderMap.get(a.imageFolderId).name}"`);
      }
    }
  }

  // Overlaps with other assignments — an image is assigned once, whatever the working date
  if (imageRanges.length) {
    const existing = await prisma.assignmentImageRange.findMany({
      where: {
        imageFolderId: { in: folderIds },
        assignment: { id: excludeAssignmentId ? { not: excludeAssignmentId } : undefined },
      },
      include: { assignment: { include: { user: true } } },
    });
    for (const r of imageRanges) {
      const clash = existing.find((e) => e.imageFolderId === r.imageFolderId
        && e.startPosition <= r.endPosition && r.startPosition <= e.endPosition);
      if (clash) {
        throw conflict(
          `Images ${clash.startPosition}–${clash.endPosition} of folder "${folderMap.get(r.imageFolderId).name}" are already assigned to ${fullName(clash.assignment.user)} (${clash.assignment.user.employeeId}) (${formatWorkDate(clash.assignment.workDate)})`,
        );
      }
    }
  }

  return { user, excelFileIds: uniqueExcel };
}

/**
 * A user can only be given (or moved to) new work once all of their earlier tasks are completed.
 * excludeAssignmentId lets an edit ignore the assignment that is being edited.
 */
export async function assertNoOpenTask(user, excludeAssignmentId = null) {
  const openTask = await prisma.assignment.findFirst({
    where: { userId: user.id, status: { not: 'COMPLETED' }, id: excludeAssignmentId ? { not: excludeAssignmentId } : undefined },
    include: { zipUpload: { select: { originalName: true } } },
    orderBy: { workDate: 'asc' },
  });
  if (openTask) {
    throw conflict(
      `${fullName(user)} (${user.employeeId}) still has an unfinished task (${formatWorkDate(openTask.workDate)}, ${openTask.status.toLowerCase()}, ${openTask.zipUpload.originalName}). Complete it before assigning new work.`,
    );
  }
}

/** Add an assignment's Excel files, image ranges and (optionally) submissions to an archive. */
export async function addAssignmentToArchive(archive, assignment, { prefix = '', includeSubmissions = true } = {}) {
  for (const link of assignment.excelFiles) {
    const e = link.excelFile;
    addFileIfExists(archive, fromStoredPath(e.storagePath), path.posix.join(prefix, 'excel', e.relativePath));
  }

  for (const r of assignment.imageRanges) {
    const images = await prisma.imageFile.findMany({
      where: { folderId: r.imageFolderId, position: { gte: r.startPosition, lte: r.endPosition } },
      orderBy: { position: 'asc' },
    });
    const folderLabel = r.imageFolder.relativePath || 'root';
    for (const img of images) {
      addFileIfExists(archive, fromStoredPath(img.storagePath), path.posix.join(prefix, 'images', folderLabel, img.fileName));
    }
  }

  if (includeSubmissions) {
    const subs = await prisma.submission.findMany({ where: { assignmentId: assignment.id }, orderBy: { createdAt: 'asc' } });
    const notes = [];
    for (const s of subs) {
      if (s.storagePath) {
        addFileIfExists(archive, fromStoredPath(s.storagePath), path.posix.join(prefix, 'submissions', s.storedName));
      }
      if (s.notes) notes.push(`[${s.createdAt.toISOString()}] ${s.originalName || '(no file)'}\n${s.notes}\n`);
    }
    if (notes.length) archive.append(notes.join('\n'), { name: path.posix.join(prefix, 'submissions', 'notes.txt') });
  }
}