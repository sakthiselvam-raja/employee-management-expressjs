import archiver from 'archiver';
import fs from 'node:fs';

/**
 * Stream a ZIP to the response. `build(archive)` adds files.
 * options.level: 0 = store only (best for images/xlsx, which are already compressed), 1-9 = deflate.
 * options.forceZip64: needed for archives bigger than 4 GB.
 */
export async function streamZip(res, downloadName, build, { level = 5, forceZip64 = false } = {}) {
  const archive = archiver('zip', { zlib: { level }, forceZip64 });
  res.attachment(downloadName);
  archive.on('warning', (err) => console.warn('[archive]', err.message));
  archive.on('error', (err) => {
    console.error('[archive]', err);
    res.destroy(err);
  });
  archive.pipe(res);
  await build(archive);
  await archive.finalize();
}

/** Add a file only if it still exists on disk. */
export function addFileIfExists(archive, absPath, nameInZip) {
  if (fs.existsSync(absPath)) archive.file(absPath, { name: nameInZip });
}

export const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');