import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest, notFound } from './errors.js';

const root = config.storageRoot;

export const dirs = {
  root,
  tmp: path.join(root, 'tmp'),
  zips: path.join(root, 'zips'),
  extracted: path.join(root, 'extracted'),
  submissions: path.join(root, 'submissions'),
};

export async function ensureStorageDirs() {
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
}

/** Resolve `parts` under `base` and refuse anything that escapes it (path traversal / zip-slip). */
export function resolveInside(base, ...parts) {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...parts);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw badRequest('Unsafe file path');
  }
  return target;
}

/** DB stores paths relative to STORAGE_DIR using forward slashes. */
export const toStoredPath = (absPath) => path.relative(root, absPath).split(path.sep).join('/');
export const fromStoredPath = (stored) => resolveInside(root, ...String(stored).split('/'));

export async function assertFileExists(stored) {
  const abs = fromStoredPath(stored);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    throw notFound('File is missing on the server');
  }
  return abs;
}

export const uniqueKey = () => `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

export async function removePath(absPath) {
  await fs.rm(absPath, { recursive: true, force: true });
}

/** Keep letters, numbers, dot, dash, underscore and spaces; used for stored names. */
export function safeFileName(name, fallback = 'file') {
  const base = path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
  return base.replace(/^\.+/, '') || fallback;
}

/** Multer decodes the original file name as latin1; convert it back to UTF-8. */
export function fixOriginalName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}
