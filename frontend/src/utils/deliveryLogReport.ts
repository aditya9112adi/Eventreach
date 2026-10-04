// Explicit extension so this module is importable both by Vite and by the
// `tsx --test` runner.
import type { ReportColumn } from './reportExport.ts';

/**
 * The Delivery Log as a report.
 *
 * The page renders its table in JSX and the download is written by ExcelJS, so
 * the two could easily drift apart. The columns are declared once here and
 * used by both — the same headings, the same order, the same values the table
 * shows — which is what keeps a downloaded log matching the screen it came
 * from.
 *
 * Kept free of React so it can be read cell by cell in a test.
 */

export interface DeliveryLogRow {
  _id?: string;
  contactId?: { fullName?: string; phoneNumber?: string } | null;
  contactName?: string;
  phoneNumber?: string;
  /** The personalised text a campaign sent. A template send has none: Meta renders it. */
  messageText?: string;
  status?: string;
  templateName?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  failedAt?: string;
  errorCode?: string | number;
  errorReason?: string;
  createdAt?: string;
}

export type DeliveryLogVariant = 'success' | 'error' | 'warning' | 'info';

/**
 * What to actually show for one recipient.
 *
 * The stored `status` alone would be misleading: 'Sent' means "WhatsApp
 * accepted it", and a read message is stored as Delivered plus a readAt
 * timestamp. This resolves the milestones, newest first, into the single
 * honest label for that row.
 */
export const describeDeliveryLog = (
  log: DeliveryLogRow
): { label: string; variant: DeliveryLogVariant } => {
  if (log.status === 'Failed') return { label: 'Failed', variant: 'error' };
  if (log.readAt) return { label: 'Read', variant: 'success' };
  if (log.deliveredAt) return { label: 'Delivered', variant: 'info' };
  if (log.status === 'Sent' || log.sentAt) return { label: 'Accepted by WhatsApp', variant: 'info' };
  return { label: 'Waiting to be processed', variant: 'warning' };
};

/** Local time, or an em dash when the milestone has not happened. */
export const deliveryStamp = (value?: string): string => {
  if (!value) return '—';
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? '—' : when.toLocaleString();
};

/** The same sentence the Details cell shows on screen. */
export const describeDeliveryDetail = (log: DeliveryLogRow): string => {
  if (log.status === 'Failed') {
    const code = log.errorCode ? `[${log.errorCode}] ` : '';
    return `${code}${log.errorReason || 'Unknown error'}`;
  }
  if (log.readAt) return 'Opened by recipient';
  if (log.deliveredAt) return 'Delivered to device';
  if (log.status === 'Sent') return 'Accepted by WhatsApp';
  // The same words the Details cell shows for a row that has not been picked
  // up yet. "Queued" here meant the download disagreed with the screen.
  return 'Waiting to be processed';
};

/** The recipient's name, with the template that was sent to them if any. */
export const deliveryContactName = (log: DeliveryLogRow): string => {
  const name = log.contactId?.fullName || log.contactName || 'Unknown';
  return log.templateName ? `${name} (${log.templateName})` : name;
};

/**
 * The eight columns the Delivery Log table shows, in the order it shows them.
 *
 * Sr No is deliberately absent: it is the table's own row counter, not data,
 * and an Excel filter over it would be meaningless.
 */
export const DELIVERY_LOG_COLUMNS: ReportColumn<DeliveryLogRow>[] = [
  { header: 'Contact', value: (r) => deliveryContactName(r), width: 26 },
  { header: 'Phone', value: (r) => r.contactId?.phoneNumber || r.phoneNumber || '-', width: 18 },
  { header: 'Status', value: (r) => describeDeliveryLog(r).label, width: 22 },
  { header: 'Accepted', value: (r) => deliveryStamp(r.sentAt), width: 20 },
  { header: 'Delivered', value: (r) => deliveryStamp(r.deliveredAt), width: 20 },
  { header: 'Read', value: (r) => deliveryStamp(r.readAt), width: 20 },
  { header: 'Failed', value: (r) => deliveryStamp(r.failedAt), width: 20 },
  { header: 'Details', value: (r) => describeDeliveryDetail(r), width: 34 },
];

/**
 * Which stored date the Delivery Log's range filters on.
 *
 * createdAt is when the row was queued, which is the one timestamp every log
 * has — sentAt, deliveredAt and readAt are all absent until the milestone is
 * reached, so filtering on those would drop the rows a delivery report most
 * needs to show.
 */
export const deliveryLogDate = (log: DeliveryLogRow): string | undefined => log.createdAt;

/**
 * The statuses the Delivery Log can be filtered by, in the order the table has
 * always offered them.
 *
 * Every value is one the backend already understands: Pending, Sent, Delivered
 * and Failed are the stored statuses, and Read is the readAt timestamp (see
 * models/MessageLog.ts). "Accepted" is deliberately not a value here - nothing
 * persists it as a status. It is the label for `Sent`, which means WhatsApp
 * accepted the message, and for the sentAt timestamp.
 */
export const DELIVERY_STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'All', label: 'All Statuses' },
  { value: 'Sent', label: 'Accepted by WhatsApp' },
  { value: 'Delivered', label: 'Delivered' },
  { value: 'Read', label: 'Read' },
  { value: 'Failed', label: 'Failed' },
  { value: 'Pending', label: 'Pending' },
];

/**
 * The Delivery Log as a downloadable document: the same columns the table
 * shows, plus what was sent.
 *
 * A campaign message stores the personalised text it carried, so that goes in
 * Message. A template message stores only the approved template's name - its
 * wording is rendered by Meta and never held here - so that goes in Template,
 * and Message is a dash rather than words this system never had.
 *
 * Contact is the plain name: the table appends the template to it for want of
 * a column, which this document has.
 */
export const EVENT_DELIVERY_EXPORT_COLUMNS: ReportColumn<DeliveryLogRow>[] = [
  { header: 'Contact', value: (r) => r.contactId?.fullName || r.contactName || 'Unknown', width: 22 },
  // Wide enough that a 13-character number and "event_document" each sit on
  // one line in the PDF - at less, both broke mid-token. Message takes the
  // narrower share instead: it is the column meant to wrap.
  { header: 'Phone', value: (r) => r.contactId?.phoneNumber || r.phoneNumber || '-', width: 24 },
  { header: 'Template', value: (r) => r.templateName || '-', width: 24 },
  { header: 'Message', value: (r) => (r.messageText && r.messageText.trim()) || '—', width: 40 },
  { header: 'Status', value: (r) => describeDeliveryLog(r).label, width: 18 },
  { header: 'Accepted', value: (r) => deliveryStamp(r.sentAt), width: 20 },
  { header: 'Delivered', value: (r) => deliveryStamp(r.deliveredAt), width: 20 },
  { header: 'Read', value: (r) => deliveryStamp(r.readAt), width: 20 },
  { header: 'Failed', value: (r) => deliveryStamp(r.failedAt), width: 20 },
  { header: 'Details', value: (r) => describeDeliveryDetail(r), width: 28 },
];
