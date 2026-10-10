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
  /**
   * The event an Access or Contact Report was generated for ("EVT-000006 |
   * Valentines", or "All Events"), printed as a fourth filter line. Left out,
   * the report states the three lines it always has.
   */
  event?: string;
  /**
   * Lines to print in place of the three filter lines, for a document that is
   * not the result of a search - an event's Delivery Log states the event it
   * belongs to rather than a search value and a date range.
   */
  rows?: Array<[string, string]>;
}

/** Shown at the foot of every report, in both formats. Wording is fixed. */
export const REPORT_NOTE = 'Note :: This report is system generated';
export const REPORT_CREDIT = 'Designed & developed by SmartStack Soft Solutions';

/** The three filter lines, always present so a report states its own scope. */
export const buildMetaRows = (meta: ReportMeta = {}): Array<[string, string]> =>
  meta.rows && meta.rows.length > 0
    ? meta.rows
    : [
        ['Search Value', meta.searchValue?.trim() || '-'],
        ['Start Date', meta.startDate?.trim() || '-'],
        ['End Date', meta.endDate?.trim() || '-'],
        ...(meta.event !== undefined ? [['Event', meta.event.trim() || '-'] as [string, string]] : []),
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
/**
 * exceljs is CommonJS: the bundler hands back a namespace carrying Workbook
 * directly, node puts the same object under `default`. Accept either, so the
 * workbook can be built in a test as well as in the browser.
 */
const newWorkbook = async (): Promise<any> => {
  const imported: any = await import('exceljs');
  const ExcelJS = imported.default ?? imported;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  return workbook;
};

/** Excel refuses a sheet name over 31 characters. */
const sheetName = (name: string) => name.slice(0, 31) || 'Report';

/**
 * One report table on its own sheet: title, the lines stating its scope, the
 * highlighted and bordered table with a filter on every column, and the two
 * standing notes. Every report sheet in the application is written by this, so
 * a second sheet in a workbook looks exactly like a report on its own.
 */
const addReportSheet = <T>(
  workbook: any,
  name: string,
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): any => {
  const sheet = workbook.addWorksheet(sheetName(name));

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

  /**
   * The filter covers the headings and the data, and stops there.
   *
   * Taken before the notes are written: a dropdown that included them would
   * offer "Note :: This report is system generated" as a value of the first
   * column. The metadata above the table is outside it for the same reason,
   * which is why the table starts at its own header row rather than at A1.
   */
  const lastDataRow = headerRow.number + rows.length;
  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: lastDataRow, column: columns.length },
  };

  sheet.addRow([]);
  const noteRow = sheet.addRow([REPORT_NOTE]);
  noteRow.font = { italic: true };
  sheet.addRow([REPORT_CREDIT]);

  // Keeps the headings visible while scrolling a long report.
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }];

  return sheet;
};

export const buildReportWorkbook = async <T>(
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): Promise<any> => {
  const workbook = await newWorkbook();
  addReportSheet(workbook, title, title, columns, rows, meta);
  return workbook;
};

/** One sheet of a multi-sheet report: written exactly as a report on its own. */
export interface ReportSheet<T = any> {
  name: string;
  title: string;
  columns: ReportColumn<T>[];
  rows: T[];
  meta?: ReportMeta;
}

/**
 * Several report tables, one per sheet, in the order given. The Event Report
 * uses it for its events on the first sheet and their Delivery Log on the
 * second; with one sheet it is the same workbook buildReportWorkbook writes.
 */
export const buildMultiSheetWorkbook = async (sheets: ReportSheet[]): Promise<any> => {
  const workbook = await newWorkbook();
  for (const sheet of sheets) {
    addReportSheet(workbook, sheet.name, sheet.title, sheet.columns, sheet.rows, sheet.meta ?? {});
  }
  return workbook;
};

/**
 * A two-sheet workbook: a details sheet of label/value lines, then a report
 * table on the second sheet. The Delivery Log export uses it - the event on
 * the first sheet, its messages on the second - so the table is not pushed
 * down by a block of event fields and keeps its own filter row.
 */
export interface DetailsAndTableWorkbook<T> {
  detailsSheet: string;
  detailsTitle: string;
  details: Array<[string, string]>;
  tableSheet: string;
  tableTitle: string;
  columns: ReportColumn<T>[];
  rows: T[];
  tableMeta?: ReportMeta;
}

export const buildDetailsAndTableWorkbook = async <T>(
  options: DetailsAndTableWorkbook<T>
): Promise<any> => {
  const workbook = await newWorkbook();
  const sheet = workbook.addWorksheet(sheetName(options.detailsSheet));
  sheet.columns = [{ width: 24 }, { width: 70 }];

  const titleRow = sheet.addRow([options.detailsTitle]);
  titleRow.font = { bold: true, size: 14 };
  titleRow.alignment = { horizontal: 'center' };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 2);
  sheet.addRow([]);

  for (const [label, value] of options.details) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    // A long venue or note wraps inside its cell instead of running off it.
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.border = ALL_BORDERS;
    });
  }

  sheet.addRow([]);
  const noteRow = sheet.addRow([REPORT_NOTE]);
  noteRow.font = { italic: true };
  sheet.addRow([REPORT_CREDIT]);

  addReportSheet(
    workbook,
    options.tableSheet,
    options.tableTitle,
    options.columns,
    options.rows,
    options.tableMeta ?? {}
  );
  return workbook;
};

const saveWorkbook = async (workbook: any, fileName: string): Promise<void> => {
  const buffer = await workbook.xlsx.writeBuffer();
  saveBlob(
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    `${fileName}.xlsx`
  );
};

export const exportDetailsAndTableToExcel = async <T>(
  fileName: string,
  options: DetailsAndTableWorkbook<T>
): Promise<void> => {
  await saveWorkbook(await buildDetailsAndTableWorkbook(options), fileName);
};

export const exportMultiSheetToExcel = async (fileName: string, sheets: ReportSheet[]): Promise<void> => {
  await saveWorkbook(await buildMultiSheetWorkbook(sheets), fileName);
};

export const exportToExcel = async <T>(
  fileName: string,
  title: string,
  columns: ReportColumn<T>[],
  rows: T[],
  meta: ReportMeta = {}
): Promise<void> => {
  await saveWorkbook(await buildReportWorkbook(title, columns, rows, meta), fileName);
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
  const y = drawPdfMetaRows(doc, meta, 27);

  autoTable(doc, {
    ...pdfTableOptions(doc, columns, rows),
    startY: y + 4,
    // Drawn per page so the notes are present however far the table runs.
    didDrawPage: () => drawPdfFooter(doc),
  });

  return doc;
};

const PDF_MARGIN = 12;

/** The two standing notes, at the foot of a page. */
const drawPdfFooter = (doc: any) => {
  const pageWidth = doc.internal.pageSize.getWidth();
  const footerY = doc.internal.pageSize.getHeight() - 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(REPORT_NOTE, PDF_MARGIN, footerY);
  doc.text(REPORT_CREDIT, pageWidth - PDF_MARGIN, footerY, { align: 'right' });
};

/**
 * How every report table in a PDF is laid out, so a section appended to a
 * report looks exactly like the report above it.
 */
const pdfTableOptions = <T>(doc: any, columns: ReportColumn<T>[], rows: T[]) => {
  const margin = PDF_MARGIN;
  /**
   * Column widths, shared out across the page in the proportions each report
   * already declares for Excel. Without this every column gets an equal slice,
   * which wraps "02 Oct 2026" onto two lines while a one-word Status column
   * sits half empty.
   */
  const usable = doc.internal.pageSize.getWidth() - margin * 2;
  const declared = columns.map((column) => column.width ?? 20);
  const totalDeclared = declared.reduce((sum, width) => sum + width, 0);
  const columnStyles: Record<number, any> = {};
  declared.forEach((width, index) => {
    columnStyles[index] = { cellWidth: (width / totalDeclared) * usable };
  });

  return {
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
  };
};

/** The scope lines under a PDF title: bold label, plain value, wrapped. Returns the next y. */
const drawPdfMetaRows = (doc: any, meta: ReportMeta, startY: number): number => {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFontSize(10);
  let y = startY;
  for (const [label, value] of buildMetaRows(meta)) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20);
    doc.text(label, PDF_MARGIN, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60);
    // Wrapped rather than run off the page: an event's venue or a note can be
    // longer than the space beside its label, and none of it may be lost.
    const lines: string[] = doc.splitTextToSize(String(value), pageWidth - PDF_MARGIN * 2 - 34);
    doc.text(lines, PDF_MARGIN + 34, y);
    y += 6 + Math.max(0, lines.length - 1) * 4.5;
  }
  return y;
};

/** One titled table of a grouped PDF section; `empty` is said when it has no rows. */
export interface PdfGroup<T> {
  heading: string;
  rows: T[];
  empty: string;
}

/**
 * Appends a section to a PDF that already holds a report: it starts on a new
 * page with its own title and scope lines, then one headed table per group -
 * the Event Report's Delivery Log, one table per event. A group with no rows
 * says so in a line instead of printing an empty table.
 *
 * The tables wrap and run onto as many pages as they need, exactly like the
 * report's own; the standing notes are written once on every page the
 * section adds.
 */
export const appendGroupedPdfSection = async <T>(
  doc: any,
  title: string,
  columns: ReportColumn<T>[],
  groups: PdfGroup<T>[],
  meta: ReportMeta = {}
): Promise<any> => {
  const autotable: any = await import('jspdf-autotable');
  const autoTable = autotable.default ?? autotable.autoTable ?? autotable;
  const pageWidth = doc.internal.pageSize.getWidth();
  const bottom = doc.internal.pageSize.getHeight() - 18;
  const margin = PDF_MARGIN;

  doc.addPage();
  const firstPage = doc.getNumberOfPages();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(title, pageWidth / 2, 16, { align: 'center' });
  const titleWidth = doc.getTextWidth(title);
  doc.setLineWidth(0.4);
  doc.line((pageWidth - titleWidth) / 2, 18, (pageWidth + titleWidth) / 2, 18);

  let y = drawPdfMetaRows(doc, meta, 27) + 4;

  for (const group of groups) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(20);
    const headingLines: string[] = doc.splitTextToSize(group.heading, pageWidth - margin * 2);
    // A heading is never left alone at the foot of a page: it moves to the
    // next one with room for at least the table's header and a row under it.
    if (y + headingLines.length * 5 + 22 > bottom) {
      doc.addPage();
      y = 16;
    }
    doc.text(headingLines, margin, y);
    y += headingLines.length * 5;

    if (group.rows.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(90);
      doc.text(group.empty, margin, y + 1);
      y += 12;
      continue;
    }

    autoTable(doc, { ...pdfTableOptions(doc, columns, group.rows), startY: y });
    y = doc.lastAutoTable.finalY + 10;
  }

  // Every page this section added gets the notes once: none of them had them.
  for (let page = firstPage; page <= doc.getNumberOfPages(); page++) {
    doc.setPage(page);
    drawPdfFooter(doc);
  }
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
