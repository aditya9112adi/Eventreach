// Explicit extensions so this module is importable both by Vite and by the
// `tsx --test` runner.
import {
  appendGroupedPdfSection,
  buildMultiSheetWorkbook,
  buildReportPdf,
  exportMultiSheetToExcel,
  type ReportColumn,
  type ReportMeta,
  type ReportSheet,
} from './reportExport.ts';
import { EVENT_DELIVERY_EXPORT_COLUMNS, type DeliveryLogRow } from './deliveryLogReport.ts';
import { fetchAllDeliveryRows, type DeliveryLogPage } from './eventDeliveryExport.ts';

/**
 * The Event Report's own Excel and PDF, with the WhatsApp Delivery Log of
 * every event the generated report lists.
 *
 * The events are the report's rows - exactly the ones its table shows after
 * the search and date filters - and their messages come from one batch
 * endpoint that takes all of their ids at once. Nothing is fetched per event
 * or per recipient, and no event outside the report is read.
 *
 * This is separate from the View page's download, which is one event's log.
 */

/** A Delivery Log row as the batch endpoint returns it: labelled with its event's _id. */
export type ReportDeliveryRow = DeliveryLogRow & { eventId?: string };

/** The events of a report: only what the Delivery Log needs from each. */
export interface ReportEvent {
  _id?: string;
  eventId?: string;
  eventName?: string;
}

/** The most event ids sent in one request - the server's own limit. */
export const REPORT_EVENTS_PER_REQUEST = 1000;
/** The most messages asked for in one request - the server's own limit. */
export const REPORT_MESSAGES_PER_REQUEST = 1000;

/** One page of the batch endpoint, for these event ids. */
export type ReportDeliveryPage = (eventIds: string[], page: number, limit: number) => Promise<DeliveryLogPage>;

/**
 * Every message of every event in the report.
 *
 * One request carries all the report's event ids (up to 1000 of them) and
 * returns up to 1000 messages; only a report with more than that reads a
 * further page. The number of requests depends on how many messages there
 * are, never on how many events: three events with five messages between them
 * are one request.
 */
export const fetchReportDeliveryRows = async (
  eventIds: string[],
  getPage: ReportDeliveryPage
): Promise<ReportDeliveryRow[]> => {
  const ids = Array.from(new Set(eventIds.filter(Boolean).map(String)));
  const rows: ReportDeliveryRow[] = [];
  for (let start = 0; start < ids.length; start += REPORT_EVENTS_PER_REQUEST) {
    const chunk = ids.slice(start, start + REPORT_EVENTS_PER_REQUEST);
    rows.push(
      ...(await fetchAllDeliveryRows(
        (page, limit) => getPage(chunk, page, limit),
        REPORT_MESSAGES_PER_REQUEST
      ))
    );
  }
  return rows;
};

export interface EventDeliveryGroup<E extends ReportEvent = ReportEvent> {
  event: E;
  logs: ReportDeliveryRow[];
}

/**
 * The messages under the event each belongs to, in the report's own order.
 *
 * A row is placed by the event id the server labelled it with and nothing
 * else, so one event's messages can never appear under another; a row for an
 * event the report does not list is dropped rather than shown under the wrong
 * heading. An event with no messages keeps its place with an empty list.
 */
export const groupDeliveryByEvent = <E extends ReportEvent>(
  events: E[],
  rows: ReportDeliveryRow[]
): EventDeliveryGroup<E>[] => {
  const byEvent = new Map<string, ReportDeliveryRow[]>();
  for (const event of events) byEvent.set(String(event._id), []);
  for (const row of rows) byEvent.get(String(row.eventId))?.push(row);
  return events.map((event) => ({ event, logs: byEvent.get(String(event._id)) ?? [] }));
};

/** "EVT-000006 — Valentines". */
export const reportEventLabel = (event: ReportEvent): string =>
  [event.eventId, event.eventName].filter(Boolean).join(' — ') || String(event._id ?? '-');

/** A Delivery Log sheet row: the message, and the event it was sent for. */
export interface ReportDeliveryRecord {
  event: ReportEvent;
  log: ReportDeliveryRow;
}

/**
 * The Delivery Log sheet: which event, then the same ten columns the View
 * page's download has - one definition, so the two never word a message
 * differently.
 */
export const EVENT_REPORT_DELIVERY_COLUMNS: ReportColumn<ReportDeliveryRecord>[] = [
  { header: 'Event ID', value: (r) => r.event.eventId || '-', width: 14 },
  { header: 'Event Name', value: (r) => r.event.eventName || '-', width: 22 },
  ...EVENT_DELIVERY_EXPORT_COLUMNS.map((column) => ({
    header: column.header,
    width: column.width,
    value: (r: ReportDeliveryRecord) => column.value(r.log),
  })),
];

/** Said in the PDF under an event that has no messages. */
export const NO_EVENT_MESSAGES = 'No WhatsApp messages have been sent for this event.';

/**
 * The scope lines of the Delivery Log: the report's own filters, so the log
 * says it covers the same search and dates, then how many events and messages
 * it holds - and which events had none, stated rather than left to be
 * inferred from their absence.
 */
export const buildReportDeliveryMeta = (groups: EventDeliveryGroup[], meta: ReportMeta = {}): ReportMeta => {
  const silent = groups.filter((group) => group.logs.length === 0).map((group) => reportEventLabel(group.event));
  return {
    rows: [
      ['Search Value', meta.searchValue?.trim() || '-'],
      ['Start Date', meta.startDate?.trim() || '-'],
      ['End Date', meta.endDate?.trim() || '-'],
      ['Events', String(groups.length)],
      ['Messages', String(groups.reduce((sum, group) => sum + group.logs.length, 0))],
      ['No Messages', silent.length > 0 ? silent.join(', ') : 'None'],
    ],
  };
};

const flatten = (groups: EventDeliveryGroup[]): ReportDeliveryRecord[] =>
  groups.flatMap((group) => group.logs.map((log) => ({ event: group.event, log })));

const DELIVERY_TITLE = 'Delivery Log';

/** Sheet 1 is the Event Report exactly as it has always been written; sheet 2 its Delivery Log. */
const reportSheets = <E extends ReportEvent>(
  title: string,
  columns: ReportColumn<E>[],
  events: E[],
  rows: ReportDeliveryRow[],
  meta: ReportMeta
): ReportSheet[] => {
  const groups = groupDeliveryByEvent(events, rows);
  return [
    { name: title, title, columns, rows: events, meta },
    {
      name: DELIVERY_TITLE,
      title: DELIVERY_TITLE,
      columns: EVENT_REPORT_DELIVERY_COLUMNS,
      rows: flatten(groups),
      meta: buildReportDeliveryMeta(groups, meta),
    },
  ];
};

export const buildEventReportWorkbook = <E extends ReportEvent>(
  title: string,
  columns: ReportColumn<E>[],
  events: E[],
  rows: ReportDeliveryRow[],
  meta: ReportMeta = {}
) => buildMultiSheetWorkbook(reportSheets(title, columns, events, rows, meta));

/**
 * The Event Report as it has always printed, then a Delivery Log section on
 * the following pages: one headed table per event, in the report's order.
 */
export const buildEventReportPdf = async <E extends ReportEvent>(
  title: string,
  columns: ReportColumn<E>[],
  events: E[],
  rows: ReportDeliveryRow[],
  meta: ReportMeta = {}
) => {
  const groups = groupDeliveryByEvent(events, rows);
  const doc = await buildReportPdf(title, columns, events, meta);
  return appendGroupedPdfSection(
    doc,
    DELIVERY_TITLE,
    EVENT_DELIVERY_EXPORT_COLUMNS,
    groups.map((group) => ({
      heading: `Event: ${reportEventLabel(group.event)} (${group.logs.length} ${group.logs.length === 1 ? 'message' : 'messages'})`,
      rows: group.logs,
      empty: NO_EVENT_MESSAGES,
    })),
    buildReportDeliveryMeta(groups, meta)
  );
};

export const exportEventReportExcel = async <E extends ReportEvent>(
  fileName: string,
  title: string,
  columns: ReportColumn<E>[],
  events: E[],
  rows: ReportDeliveryRow[],
  meta: ReportMeta = {}
): Promise<void> => {
  await exportMultiSheetToExcel(fileName, reportSheets(title, columns, events, rows, meta));
};

export const exportEventReportPdf = async <E extends ReportEvent>(
  fileName: string,
  title: string,
  columns: ReportColumn<E>[],
  events: E[],
  rows: ReportDeliveryRow[],
  meta: ReportMeta = {}
): Promise<void> => {
  const doc = await buildEventReportPdf(title, columns, events, rows, meta);
  doc.save(`${fileName}.pdf`);
};
