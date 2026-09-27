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

/**
 * Assembles the PDF. Split from the download for the same reason as the
 * workbook: the document can then be built and read back in a test, where
 * `doc.save()` has no browser to save into.
 *
 * Laid out to match the Excel report rather than the plain table this used to
 * print: same title, same three filter lines, same highlighted headings, a
 * border on every cell, and the two standing notes at the foot of every page.
 */
export const buildReportPdf = async <T>(
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): Promise<any> => {
  const [jspdf, autotable]: any[] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const jsPDF = jspdf.default ?? jspdf.jsPDF ?? jspdf;
  const autoTable = autotable.default ?? autotable.autoTable ?? autotable;

  // Nine columns do not fit across a portrait page without squashing.
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;

  // Title: centred, bold, underlined — as the report reads in Excel.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(title, pageWidth / 2, 16, { align: 'center' });
  const titleWidth = doc.getTextWidth(title);
  doc.setLineWidth(0.4);
  doc.line((pageWidth - titleWidth) / 2, 18, (pageWidth + titleWidth) / 2, 18);

  // The filters this report was generated from: bold label, plain value, in
  // two aligned columns the way the spreadsheet lays them out.
  doc.setFontSize(10);
  let y = 27;
  for (const [label, value] of buildMetaRows(meta)) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20);
    doc.text(label, margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60);
    doc.text(String(value), margin + 34, y);
    y += 6;
  }

  /**
   * Column widths, shared out across the page in the proportions each report
   * already declares for Excel. Without this every column gets an equal slice,
   * which wraps "02 Oct 2026" onto two lines while a one-word Status column
   * sits half empty.
   */
  const usable = pageWidth - margin * 2;
  const declared = columns.map((column) => column.width ?? 20);
  const totalDeclared = declared.reduce((sum, width) => sum + width, 0);
  const columnStyles: Record<number, any> = {};
  declared.forEach((width, index) => {
    columnStyles[index] = { cellWidth: (width / totalDeclared) * usable };
  });

  autoTable(doc, {
    startY: y + 4,
    head: [columns.map((column) => column.header)],
    body: rows.map((row) => columns.map((column) => String(column.value(row)))),
    columnStyles,
    // 'grid' puts a line on all four sides of every cell.
    theme: 'grid',
    styles: {
      fontSize: 9,
      cellPadding: 2,
      lineWidth: 0.1,
      lineColor: [150, 158, 170],
      textColor: 20,
      // Long venues and organizer names wrap instead of running over a border.
      overflow: 'linebreak',
      valign: 'middle',
    },
    headStyles: {
      fillColor: [217, 225, 242],
      textColor: 20,
      fontStyle: 'bold',
      lineWidth: 0.1,
      lineColor: [120, 128, 140],
      halign: 'left',
    },
    // A long report repeats its headings, and a row is not split across pages.
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    margin: { left: margin, right: margin, bottom: 18 },
    tableWidth: 'auto',
    didDrawPage: () => {
      // Drawn per page so the notes are present however far the table runs.
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(90);
      const footerY = pageHeight - 8;
      doc.text(REPORT_NOTE, margin, footerY);
      doc.text(REPORT_CREDIT, pageWidth - margin, footerY, { align: 'right' });
    },
  });

  return doc;
};

export const exportToPdf = async <T>(
  fileName: string,
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): Promise<void> => {
  const doc = await buildReportPdf(title, columns, rows, meta);
  doc.save(`${fileName}.pdf`);
};
