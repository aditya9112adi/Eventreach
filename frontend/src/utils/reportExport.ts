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
 */

export interface ReportColumn<T> {
  /** Column heading, used verbatim in both Excel and PDF. */
  header: string;
  /** Pulls the printable cell value out of a row. */
  value: (row: T) => string | number;
  /** Column width in characters (Excel only). */
  width?: number;
}

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

export const exportToExcel = async <T>(
  fileName: string,
  title: string,
  columns: ReportColumn<T>[],
  rows: T[]
): Promise<void> => {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(title.slice(0, 31) || 'Report');

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width ?? 20,
  }));

  rows.forEach((row) => {
    sheet.addRow(columns.map((column) => column.value(row)));
  });

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle' };
  // Keeps the headings visible while scrolling a long report.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

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
  subtitle?: string
): Promise<void> => {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  // Reports are wide (up to eight columns), so landscape avoids squashing.
  const doc = new jsPDF({ orientation: 'landscape' });

  doc.setFontSize(16);
  doc.text(title, 14, 16);

  doc.setFontSize(10);
  doc.setTextColor(110);
  if (subtitle) doc.text(subtitle, 14, 23);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, subtitle ? 29 : 23);
  doc.text(`Total records: ${rows.length}`, 14, subtitle ? 35 : 29);

  autoTable(doc, {
    startY: subtitle ? 40 : 34,
    head: [columns.map((column) => column.header)],
    body: rows.map((row) => columns.map((column) => String(column.value(row)))),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 246, 248] },
    margin: { left: 14, right: 14 },
  });

  doc.save(`${fileName}.pdf`);
};
