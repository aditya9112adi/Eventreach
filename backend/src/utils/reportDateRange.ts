/**
 * The Start Date / End Date a report is generated for.
 *
 * The report tabs read the ordinary list endpoints — /events is also what the
 * dashboard, the event list, the composer and the import screen call — so the
 * range stays OPTIONAL here. A request that sends no dates is an ordinary
 * listing and is answered exactly as it always was; requiring them would break
 * every one of those callers.
 *
 * What is not optional is that a range, once given, makes sense. A malformed
 * or inverted one is refused with 400 rather than quietly matching everything
 * (which would overstate the report) or nothing (which would understate it).
 *
 * Each report filters on its own field — events on eventDate, contacts on
 * createdAt, access records on accessGrantedOn — so the bounds are produced
 * here and the field is named by the caller.
 */

import { reportDayStart, reportDayEnd } from '@eventreach/shared';

/** A range the caller sent that cannot be used. Answered as 400. */
export class ReportDateRangeError extends Error {
  readonly field: 'startDate' | 'endDate';

  constructor(message: string, field: 'startDate' | 'endDate') {
    super(message);
    this.name = 'ReportDateRangeError';
    this.field = field;
  }
}

export interface ReportDateRange {
  /** Inclusive lower bound, at the very start of the chosen day. */
  start?: Date;
  /** Inclusive upper bound, at the very end of the chosen day. */
  end?: Date;
}

/** What <input type="date"> submits. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar day is resolved through the shared report-day helpers, so the
 * browser and the server put a record on the same side of a boundary. Doing it
 * here in UTC while the page did it against the viewer's clock made a Contact
 * Report disagree with its own API by five and a half hours.
 */
const parseBound = (
  raw: unknown,
  field: 'startDate' | 'endDate',
  label: string
): Date | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;

  const when = DATE_ONLY.test(text)
    ? (field === 'startDate' ? reportDayStart(text) : reportDayEnd(text))
    : new Date(text);

  if (Number.isNaN(when.getTime())) {
    throw new ReportDateRangeError(`${label} is not a valid date.`, field);
  }
  return when;
};

/**
 * Reads startDate/endDate off a request query.
 *
 * Throws ReportDateRangeError for anything unusable, so a caller that reaches
 * the database has already been given a range it can trust.
 */
export const parseReportDateRange = (query: any): ReportDateRange => {
  const start = parseBound(query?.startDate, 'startDate', 'Start Date');
  const end = parseBound(query?.endDate, 'endDate', 'End Date');

  /**
   * Half a range identifies a report request that is missing the other half.
   *
   * A request with NO dates is an ordinary listing — the dashboard, the event
   * list, the composer — and is left alone. One date can only have come from a
   * report, and a report must state both ends of the period it covers, so the
   * missing one is named rather than silently treated as "everything after" or
   * "everything before".
   */
  if (start && !end) {
    throw new ReportDateRangeError('End Date is required.', 'endDate');
  }
  if (end && !start) {
    throw new ReportDateRangeError('Start Date is required.', 'startDate');
  }

  if (start && end && end.getTime() < start.getTime()) {
    throw new ReportDateRangeError('End Date cannot be earlier than Start Date.', 'endDate');
  }

  return { start, end };
};

/**
 * The Mongo clause for one field, or {} when no range was asked for — which is
 * what keeps a dateless listing exactly as it was.
 */
export const dateRangeFilter = (field: string, range: ReportDateRange): Record<string, any> => {
  const bounds: Record<string, Date> = {};
  if (range.start) bounds.$gte = range.start;
  if (range.end) bounds.$lte = range.end;
  return Object.keys(bounds).length > 0 ? { [field]: bounds } : {};
};

/**
 * The same test applied in memory, for a list that is assembled in the server
 * rather than queried — the access report reads accessGrantedOn and falls back
 * to createdAt, which is a rule Mongo cannot express as one indexed clause.
 */
export const withinReportRange = (value: unknown, range: ReportDateRange): boolean => {
  if (!range.start && !range.end) return true;
  if (value === undefined || value === null || value === '') return false;
  const when = new Date(value as any).getTime();
  if (Number.isNaN(when)) return false;
  if (range.start && when < range.start.getTime()) return false;
  if (range.end && when > range.end.getTime()) return false;
  return true;
};

/** Turns the error into the 400 body the API already uses elsewhere. */
export const reportDateRangeResponse = (error: ReportDateRangeError) => ({
  error: error.message,
  field: error.field,
});
