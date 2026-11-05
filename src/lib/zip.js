import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { HttpError, badRequest } from './errors.js';
import { resolveInside } from './storage.js';
import { isExcel, isImage, naturalCompare, extOf } from './fileTypes.js';

const MAX_ENTRIES = 100_000;

/** Skip macOS metadata, hidden files and Windows thumbnails. */
function shouldSkip(name) {
  const parts = name.split('/');
  return parts.some((p) => p === '__MACOSX' || p.startsWith('.')) || /(^|\/)(thumbs\.db|desktop\.ini)$/i.test(name);
}

const isSymlink = (entry) => ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;

/**
 * Safely extract a ZIP into destDir.
 * - blocks zip-slip (../ paths), symlinks, zip bombs (total size / entry count limits)
 * Returns [{ relativePath, size }] for every file written.
 */
export function extractZip(zipPath, destDir, { maxTotalBytes }) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr) return reject(badRequest('The file is not a valid ZIP archive'));

      const files = [];
      let totalBytes = 0;
      let entryCount = 0;
      let failed = false;

      const fail = (err) => {
        if (failed) return;
        failed = true;
        try { zip.close(); } catch { /* already closed */ }
        reject(err instanceof HttpError ? err : badRequest(`Could not extract ZIP: ${err.message}`));
      };

      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve(files); });

      zip.on('entry', (entry) => {
        if (failed) return;
        const name = entry.fileName.replace(/\\/g, '/').replace(/^\/+/, '');

        entryCount += 1;
        if (entryCount > MAX_ENTRIES) return fail(badRequest(`ZIP has more than ${MAX_ENTRIES} entries`));
        if (name.endsWith('/') || shouldSkip(name) || isSymlink(entry)) return zip.readEntry();

        let target;
        try {
          target = resolveInside(destDir, ...name.split('/'));
        } catch {
          return fail(badRequest(`ZIP contains an unsafe path: ${name}`));
        }

        totalBytes += entry.uncompressedSize;
        if (totalBytes > maxTotalBytes) {
          return fail(new HttpError(413, 'Extracted content is larger than the allowed limit'));
        }

        fsp.mkdir(path.dirname(target), { recursive: true })
          .then(() => new Promise((res, rej) => {
            zip.openReadStream(entry, (err, readStream) => {
              if (err) return rej(err);
              pipeline(readStream, fs.createWriteStream(target)).then(res, rej);
            });
          }))
          .then(() => {
            files.push({ relativePath: name, size: entry.uncompressedSize });
            zip.readEntry();
          })
          .catch(fail);
      });

      zip.readEntry();
    });
  });
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Read sheet names from an .xlsx/.xlsm without loading the whole workbook (it is a ZIP itself). */
export function readXlsxSheetNames(filePath) {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return resolve([]);
      let done = false;
      const finish = (names) => {
        if (done) return;
        done = true;
        try { zip.close(); } catch { /* ignore */ }
        resolve(names);
      };
      zip.on('error', () => finish([]));
      zip.on('end', () => finish([]));
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'xl/workbook.xml') return zip.readEntry();
        zip.openReadStream(entry, (e, rs) => {
          if (e) return finish([]);
          const chunks = [];
          rs.on('data', (c) => chunks.push(c));
          rs.on('error', () => finish([]));
          rs.on('end', () => {
            const xml = Buffer.concat(chunks).toString('utf8');
            const names = [...xml.matchAll(/<(?:\w+:)?sheet\b[^>]*?\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]));
            finish(names);
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function sheetNamesFor(absPath) {
  const ext = extOf(absPath);
  if (ext === '.xlsx' || ext === '.xlsm') return readXlsxSheetNames(absPath);
  if (ext === '.csv') return ['CSV'];
  return []; // legacy .xls — names unknown without a full parser
}

/**
 * Classify extracted files into Excel files and image folders.
 * Images directly in the ZIP root go into a folder called "(root)".
 */
export async function scanExtracted(extractDir, files) {
  const excelFiles = [];
  const folders = new Map();

  for (const f of files) {
    const fileName = path.posix.basename(f.relativePath);
    if (isExcel(fileName)) {
      const abs = resolveInside(extractDir, ...f.relativePath.split('/'));
      excelFiles.push({ fileName, relativePath: f.relativePath, abs, sizeBytes: f.size, sheetNames: await sheetNamesFor(abs) });
    } else if (isImage(fileName)) {
      const dir = path.posix.dirname(f.relativePath);
      const key = dir === '.' ? '' : dir;
      if (!folders.has(key)) folders.set(key, []);
      folders.get(key).push({ fileName, relativePath: f.relativePath, sizeBytes: f.size });
    }
  }

  excelFiles.sort((a, b) => naturalCompare(a.relativePath, b.relativePath));

  const imageFolders = [...folders.entries()]
    .sort(([a], [b]) => naturalCompare(a, b))
    .map(([dir, images]) => {
      images.sort((a, b) => naturalCompare(a.fileName, b.fileName));
      return {
        name: dir ? path.posix.basename(dir) : '(root)',
        relativePath: dir,
        images: images.map((img, i) => ({ ...img, position: i + 1 })),
      };
    });

  return { excelFiles, imageFolders };
}
