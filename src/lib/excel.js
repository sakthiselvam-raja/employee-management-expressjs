import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { extOf } from './fileTypes.js';

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_COLS = 60;

function sheetToRows(worksheet, maxRows) {
  const rows = [];
  let truncated = false;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= maxRows) {
      truncated = true;
      return;
    }
    const cells = [];
    const last = Math.min(row.cellCount, MAX_COLS);
    for (let c = 1; c <= last; c += 1) {
      const cell = row.getCell(c);
      let text = '';
      try { text = cell.text ?? ''; } catch { text = String(cell.value ?? ''); }
      cells.push(String(text));
    }
    rows.push(cells);
  });
  return { name: worksheet.name, rows, truncated, totalRows: worksheet.actualRowCount };
}

/** Returns { sheets: [{ name, rows: string[][], truncated }] } or { unsupported: reason } */
export async function previewSpreadsheet(absPath, maxRows = 200, extOverride) {
  const ext = extOverride || extOf(absPath);
  const { size } = await fs.stat(absPath);
  if (size > MAX_PREVIEW_BYTES) return { unsupported: 'File is too large to preview — please download it.' };
  if (ext === '.xls') return { unsupported: 'Preview is not available for old .xls files — please download it.' };

  const workbook = new ExcelJS.Workbook();
  try {
    if (ext === '.csv') {
      await workbook.csv.readFile(absPath);
    } else {
      await workbook.xlsx.readFile(absPath);
    }
  } catch {
    return { unsupported: 'The file could not be read for preview — please download it.' };
  }
  return { sheets: workbook.worksheets.map((ws) => sheetToRows(ws, maxRows)) };
}