import { forbidden } from '../lib/errors.js';

/**
 * Inline image views must come from the app itself (fetch/XHR or <img>), never from someone opening
 * the file URL in the address bar or a frame. Browsers tell us what asked for the file in `Sec-Fetch-Dest`:
 * 'document' = typed/pasted URL or link, 'iframe'/'frame'/'embed'/'object' = embedded page.
 * Explicit downloads (?download=1) are left alone because they are normal link clicks.
 * (Older browsers that send no Sec-Fetch headers are not blocked; login + ownership checks still apply.)
 */
const DIRECT = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

export function appRequestOnly(req, _res, next) {
  if (req.query.download === '1') return next();
  const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  if (DIRECT.has(dest)) throw forbidden('This file can only be viewed inside the application');
  return next();
}