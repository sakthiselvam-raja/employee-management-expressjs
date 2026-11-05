import path from 'node:path';

export const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls', '.csv']);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.svg']);

export const extOf = (name) => path.extname(String(name)).toLowerCase();
export const isExcel = (name) => EXCEL_EXTENSIONS.has(extOf(name));
export const isImage = (name) => IMAGE_EXTENSIONS.has(extOf(name));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** "img2.jpg" comes before "img10.jpg" */
export const naturalCompare = (a, b) => collator.compare(a, b);
