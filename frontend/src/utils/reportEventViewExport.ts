import { formatDateTime } from './datetime';
import {
  buildDetailsAndTableWorkbook,
  buildReportFileName,
  buildReportPdf,
  exportDetailsAndTableToExcel,
  type DetailsAndTableWorkbook,
  type ReportColumn,
} from './reportExport';

/**
 * Excel and PDF of one event's View on the Access or Contact Report - laid out
 * as the Event Report's own View downloads are: the event's details, then its
 * records.
 *
 * The records are exactly the ones the View shows: the event's records that
 * match the report's search, or - after "Show all records" - every record of
 * the event. The document says which, and with which search and period.
 */
export interface EventViewExport<T> {
  /** "Access Details" or "Contact Details": the document's and table's title. */
  title: string;
  /** "AccessReport" or "ContactReport": the start of the file name. */
  fileName: string;
  /** The event's lines, worded as the Event Report table words them. */
  eventDetails: Array<[string, string]>;
  columns: ReportColumn<T>[];
  rows: T[];
  /** The report's search when the View shows its matching records; null for every record. */
  match: Record<string, string | undefined> | null;
}

const detail = (details: Array<[string, string]>, label: string) => details.find(([key]) => key === label)?.[1] ?? '';

/** The search the View's records match, whichever filter carried it. */
const searchOf = (match: Record<string, string | undefined>) =>
  (match.q ?? match.username ?? match.name ?? match.status ?? '').trim();

/** The event's lines, then what the document holds and when it was made. */
export const eventViewDetails = <T>(input: EventViewExport<T>, when: Date = new Date()): Array<[string, string]> => [
  ...input.eventDetails,
  ['Records', String(input.rows.length)],
  ['Showing', input.match ? "Records matching the report's filters" : 'All records of the event'],
  ...(input.match
    ? ([
        ['Search Value', searchOf(input.match) || '-'],
        ['Start Date', input.match.startDate || '-'],
        ['End Date', input.match.endDate || '-'],
      ] as Array<[string, string]>)
    : []),
  ['Generated On', formatDateTime(when, '-')],
];

const workbookOptions = <T>(input: EventViewExport<T>, when: Date): DetailsAndTableWorkbook<T> => ({
  detailsSheet: 'Event Details',
  detailsTitle: 'Event Details',
  details: eventViewDetails(input, when),
  tableSheet: input.title,
  tableTitle: input.title,
  columns: input.columns,
  rows: input.rows,
  // Stated on the table sheet too, so a page printed on its own says what it is.
  tableMeta: {
    rows: [
      ['Event', [detail(input.eventDetails, 'Event ID'), detail(input.eventDetails, 'Event Name')].filter(Boolean).join(' | ') || '-'],
      ['Records', String(input.rows.length)],
    ],
  },
});

export const buildEventViewWorkbook = <T>(input: EventViewExport<T>, when: Date = new Date()) =>
  buildDetailsAndTableWorkbook(workbookOptions(input, when));

/** The PDF: the event's details at the top, then every record shown. */
export const buildEventViewPdf = <T>(input: EventViewExport<T>, when: Date = new Date()) =>
  buildReportPdf(input.title, input.columns, input.rows, { rows: eventViewDetails(input, when) });

/** e.g. "AccessReport_EVT000008_11102026". */
export const eventViewFileName = <T>(input: EventViewExport<T>, when: Date = new Date()) =>
  buildReportFileName(input.fileName, detail(input.eventDetails, 'Event ID') || 'Event', when);

export const exportEventViewExcel = async <T>(input: EventViewExport<T>): Promise<string> => {
  const name = eventViewFileName(input);
  await exportDetailsAndTableToExcel(name, workbookOptions(input, new Date()));
  return `${name}.xlsx`;
};

export const exportEventViewPdf = async <T>(input: EventViewExport<T>): Promise<string> => {
  const name = eventViewFileName(input);
  const doc = await buildEventViewPdf(input);
  doc.save(`${name}.pdf`);
  return `${name}.pdf`;
};
