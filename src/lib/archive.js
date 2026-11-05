import archiver from 'archiver';
import fs from 'node:fs';

/**
 * Stream a ZIP to the response. `build(archive)` adds files.
 */
export async function streamZip(res, downloadName, build) {
  const archive = archiver('zip', { zlib: { level: 5 } });
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
