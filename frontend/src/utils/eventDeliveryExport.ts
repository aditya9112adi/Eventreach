// Explicit extensions so this module is importable both by Vite and by the
// `tsx --test` runner.
import {
  buildDetailsAndTableWorkbook,
  buildReportPdf,
  buildReportFileName,
  exportDetailsAndTableToExcel,
  type DetailsAndTableWorkbook,
  type ReportMeta,
} from './reportExport.ts';
import { EVENT_DELIVERY_EXPORT_COLUMNS, type DeliveryLogRow } from './deliveryLogReport.ts';
import { formatDateTime } from './datetime.ts';

/**
 * An event's Delivery Log, downloaded from its View page.
 *
 * Nothing here holds or copies messages: the rows are the MessageLog records
 * the Delivery Log endpoint returns for the one event being viewed - its
 * campaign's recipients and its template sends - and the writers are the same
 * ones every other report uses.
 */

/** One page of the event's log, as GET /reports/event/:id/delivery-log answers. */
export interface DeliveryLogPage {
  logs: DeliveryLogRow[];
  total: number;
}

/** The most a single request asks for; the server allows no more than this. */
export const EXPORT_PAGE_SIZE = 500;

/**
 * Every message of the event, not just the page the table is showing.
 *
 * The on-screen log asks for the latest 200; a download must not quietly stop
 * there. It reads page after page until it holds the total the server reports
 * - one request per 500 messages, never one per message - and stops early on
 * an empty page so a total that shrank mid-read cannot spin it forever.
 */
export const fetchAllDeliveryRows = async (
  getPage: (page: number, limit: number) => Promise<DeliveryLogPage>,
  pageSize = EXPORT_PAGE_SIZE,
  maxPages = 200
): Promise<DeliveryLogRow[]> => {
  const rows: DeliveryLogRow[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const { logs, total } = await getPage(page, pageSize);
    for (const row of logs) {
      // A message that moved between pages while they were being read is
      // counted once.
      const key = row._id ?? `${page}:${rows.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (logs.length === 0 || rows.length >= total) break;
  }
  return rows;
};

/**
 * The event's own lines, then how many messages the document covers and when
 * it was made. The event lines are handed in by the page, built from the same
 * columns the Event Report table uses, so the two never describe an event
 * differently.
 */
export const buildEventDeliveryDetails = (
  eventDetails: Array<[string, string]>,
  rows: DeliveryLogRow[],
  when: Date = new Date()
): Array<[string, string]> => [
  ...eventDetails,
  ['Messages', String(rows.length)],
  ['Generated On', formatDateTime(when, '-')],
];

const TITLE = 'Delivery Log';

/** Event fields on one sheet, its messages on the next: one definition for both uses. */
const workbookOptions = (
  eventDetails: Array<[string, string]>,
  rows: DeliveryLogRow[],
  when: Date
): DetailsAndTableWorkbook<DeliveryLogRow> => ({
  detailsSheet: 'Event Details',
  detailsTitle: 'Event Details',
  details: buildEventDeliveryDetails(eventDetails, rows, when),
  tableSheet: TITLE,
  tableTitle: TITLE,
  columns: EVENT_DELIVERY_EXPORT_COLUMNS,
  rows,
  tableMeta: deliveryTableMeta(eventDetails, rows),
});

export const buildEventDeliveryWorkbook = (
  eventDetails: Array<[string, string]>,
  rows: DeliveryLogRow[],
  when: Date = new Date()
) => buildDetailsAndTableWorkbook(workbookOptions(eventDetails, rows, when));

/**
 * The scope lines above the message table: which event, and how many
 * messages. Stated on the sheet itself so a page printed on its own still says
 * what it is.
 */
const deliveryTableMeta = (eventDetails: Array<[string, string]>, rows: DeliveryLogRow[]): ReportMeta => {
  const field = (label: string) => eventDetails.find(([key]) => key === label)?.[1];
  const id = field('Event ID');
  const name = field('Event Name');
  return {
    rows: [
      ['Event', [id, name].filter(Boolean).join(' | ') || '-'],
      ['Messages', String(rows.length)],
    ],
  };
};

/**
 * The PDF: the event's details at the top, then every message. Long message
 * text wraps inside its cell and the table runs onto as many pages as it needs
 * - buildReportPdf repeats the headings on each - so nothing is cut short.
 */
export const buildEventDeliveryPdf = (
  eventDetails: Array<[string, string]>,
  rows: DeliveryLogRow[],
  when: Date = new Date()
) =>
  buildReportPdf(TITLE, EVENT_DELIVERY_EXPORT_COLUMNS, rows, {
    rows: buildEventDeliveryDetails(eventDetails, rows, when),
  });

export const eventDeliveryFileName = (eventCode: string, when: Date = new Date()) =>
  buildReportFileName('DeliveryLog', eventCode || 'Event', when);

export const exportEventDeliveryExcel = async (
  eventCode: string,
  eventDetails: Array<[string, string]>,
  rows: DeliveryLogRow[]
): Promise<string> => {
  const name = eventDeliveryFileName(eventCode);
  await exportDetailsAndTableToExcel(name, workbookOptions(eventDetails, rows, new Date()));
  return `${name}.xlsx`;
};

export const exportEventDeliveryPdf = async (
  eventCode: string,
  eventDetails: Array<[string, string]>,
  rows: DeliveryLogRow[]
): Promise<string> => {
  const name = eventDeliveryFileName(eventCode);
  const doc = await buildEventDeliveryPdf(eventDetails, rows);
  doc.save(`${name}.pdf`);
  return `${name}.pdf`;
};
