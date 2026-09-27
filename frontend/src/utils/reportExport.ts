// Explicit extension so this module is importable both by Vite and by the
// `node --experimental-strip-types` test runner.
import { formatFileStamp } from './datetime.ts';

/**
 * Report downloading (Excel + PDF).
 *
 * Both writers are pulled in with a dynamic `import()` so the libraries only
 * reach the browser when someone actually clicks Download. Reports is already a
 * lazily loaded route, and neither ExcelJS nor jsPDF is small, so keeping them
 * out of the initial bundle matters.
 *
 * Both formats carry the same thing: the report's name, the filters it was
 * generated from, the table, and the two standing notes at the end. The rows
 * handed in are the rows the page is showing — no export re-queries anything.
 */

export interface ReportColumn<T> {
  /** Column heading, used verbatim in both Excel and PDF. */
  header: string;
  /** Pulls the printable cell value out of a row. */
  value: (row: T) => string | number;
  /** Column width in characters (Excel only). */
  width?: number;
}

/** The filters the report was generated from, printed at the top of it. */
export interface ReportMeta {
  searchValue?: string;
  startDate?: string;
  endDate?: string;
}

/** Shown at the foot of every report, in both formats. Wording is fixed. */
export const REPORT_NOTE = 'Note :: This report is system generated';
export const REPORT_CREDIT = 'Designed & developed by SmartStack Soft Solutions';

/** The three filter lines, always present so a report states its own scope. */
export const buildMetaRows = (meta: ReportMeta = {}): Array<[string, string]> => [
  ['Search Value', meta.searchValue?.trim() || '-'],
  ['Start Date', meta.startDate?.trim() || '-'],
  ['End Date', meta.endDate?.trim() || '-'],
];

/**
 * Builds the download name, e.g. "AccessReport_UserName_21082026".
 *
 * Anything that is not a letter or digit is stripped from the caller-supplied
 * parts so a filter label can never introduce a path separator or a character
 * Windows rejects in a file name.
 */
export const buildReportFileName = (
  reportName: string,
  filterLabel: string,
  when: Date = new Date()
): string => {
  const clean = (part: string) => part.replace(/[^A-Za-z0-9]/g, '');
  return `${clean(reportName)}_${clean(filterLabel)}_${formatFileStamp(when)}`;
};

/** Triggers a browser download for a generated blob, then releases the URL. */
const saveBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const THIN_BORDER = { style: 'thin' as const, color: { argb: 'FF9AA5B1' } };
const ALL_BORDERS = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

/**
 * Assembles the workbook. Separated from the download so it can be inspected
 * in a test — cell by cell, including the fonts, fills and borders — without a
 * browser.
 */
export const buildReportWorkbook = async <T>(
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): Promise<any> => {
  // exceljs is CommonJS: the bundler hands back a namespace carrying Workbook
  // directly, node puts the same object under `default`. Accept either, so the
  // workbook can be built in a test as well as in the browser.
  const imported: any = await import('exceljs');
  const ExcelJS = imported.default ?? imported;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(title.slice(0, 31) || 'Report');

  sheet.columns = columns.map((column) => ({
    key: column.header,
    width: column.width ?? 20,
  }));

  // Title, centred across the table.
  const titleRow = sheet.addRow([title]);
  titleRow.font = { bold: true, size: 14 };
  titleRow.alignment = { horizontal: 'center' };
  if (columns.length > 1) {
    sheet.mergeCells(titleRow.number, 1, titleRow.number, columns.length);
  }
  sheet.addRow([]);

  // The filters this report was generated from.
  for (const [label, value] of buildMetaRows(meta)) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }
  sheet.addRow([]);

  const headerRow = sheet.addRow(columns.map((column) => column.header));
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle' };
  headerRow.eachCell((cell: any) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    cell.border = ALL_BORDERS;
  });

  rows.forEach((row) => {
    const added = sheet.addRow(columns.map((column) => column.value(row)));
    added.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.border = ALL_BORDERS;
    });
  });

  sheet.addRow([]);
  const noteRow = sheet.addRow([REPORT_NOTE]);
  noteRow.font = { italic: true };
  sheet.addRow([REPORT_CREDIT]);

  // Keeps the headings visible while scrolling a long report.
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }];

  return workbook;
};

export const exportToExcel = async <T>(
  fileName: string,
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): Promise<void> => {
  const workbook = await buildReportWorkbook(title, columns, rows, meta);
  const buffer = await workbook.xlsx.writeBuffer();
  saveBlob(
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    `${fileName}.xlsx`
  );
};

export const exportToPdf = async <T>(
  fileName: string,
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): Promise<void> => {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  // Reports are wide (up to nine columns), so landscape avoids squashing.
  const doc = new jsPDF({ orientation: 'landscape' });
  const left = 14;

  doc.setFontSize(16);
  doc.text(title, doc.internal.pageSize.getWidth() / 2, 16, { align: 'center' });

  doc.setFontSize(10);
  doc.setTextColor(60);
  let y = 26;
  for (const [label, value] of buildMetaRows(meta)) {
    doc.text(`${label}: ${value}`, left, y);
    y += 6;
  }
  doc.setTextColor(110);
  doc.text(`Total records: ${rows.length}`, left, y);

  autoTable(doc, {
    startY: y + 6,
    head: [columns.map((column) => column.header)],
    body: rows.map((row) => columns.map((column) => String(column.value(row)))),
    // 'grid' draws a line on every side of every cell.
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 2, lineWidth: 0.1, lineColor: [150, 150, 150] },
    headStyles: { fillColor: [217, 225, 242], textColor: 20, fontStyle: 'bold', lineWidth: 0.1, lineColor: [120, 120, 120] },
    margin: { left, right: left },
  });

  // The two standing notes, under the table on the last page.
  const endY = (doc as any).lastAutoTable?.finalY ?? y + 10;
  const footerY = Math.min(endY + 10, doc.internal.pageSize.getHeight() - 10);
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(REPORT_NOTE, left, footerY);
  doc.text(REPORT_CREDIT, doc.internal.pageSize.getWidth() - left, footerY, { align: 'right' });

  doc.save(`${fileName}.pdf`);
};
