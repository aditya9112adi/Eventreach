import { reportDayStart, reportDayEnd } from '@eventreach/shared';

/**
 * Report generation state and filtering for the Reports page.
 *
 * The filtering is the logic the page has always used, lifted out unchanged so
 * it can be tested and so the table and the Excel/PDF export run the same code.
 *
 * The reducer tracks a single report "run": nothing, loading, loaded or failed.
 * Every run carries the report it belongs to and a request id, and a response
 * is only accepted if its id is still the current one. That is what stops a
 * slow Event Report request from landing under the Contact Report tab after the
 * user has switched, or an older search overwriting a newer one.
 */

export type ReportKey = 'event' | 'access' | 'contact';

/** The filter inputs, as captured at the moment a report is generated. */
export interface ReportFilters {
  /** Key of the selected "Filter By" option. */
  mode: string;
  searchValue: string;
  startDate: string;
  endDate: string;
  /**
   * The one event the Access or Contact Report was generated for (its _id);
   * empty or absent for all events. The server applies it - see
   * reportEventParam - and the downloads state it.
   */
  eventId?: string;
}

/** The reports whose generated filters may name one event. */
export const EVENT_SCOPED_REPORTS: ReadonlyArray<ReportKey> = ['access', 'contact'];

/**
 * The event part of a report request: for the Access and Contact Reports
 * generated for one event, { eventId }; otherwise nothing. The event goes to
 * the server, which authorizes it and reads only that event's records - it is
 * never a filter applied afterwards in the browser.
 */
export const reportEventParam = (key: ReportKey, filters: ReportFilters): { eventId?: string } =>
  EVENT_SCOPED_REPORTS.includes(key) && filters.eventId ? { eventId: filters.eventId } : {};

export interface ReportRowAccessors {
  /** Free-text field the text filters search. */
  text: (row: any) => string;
  /** Status the "Status" filter matches. */
  status: (row: any) => string;
  /** Date the date-range filter uses. */
  date: (row: any) => string | undefined;
}

/**
 * Start of day / end of day so a range is inclusive of both endpoints.
 *
 * The bounds come from the shared report-day helpers rather than from the
 * viewer's own clock, so the page and the API agree about which calendar day a
 * record falls in. Reading them locally meant a browser outside IST put a
 * record on a different side of the boundary than the server did.
 */
export const withinRange = (raw: string | undefined, start: string, end: string): boolean => {
  if (!start && !end) return true;
  if (!raw) return false;
  const when = new Date(raw).getTime();
  if (Number.isNaN(when)) return false;
  if (start && when < reportDayStart(start).getTime()) return false;
  if (end && when > reportDayEnd(end).getTime()) return false;
  return true;
};

/**
 * Rows matching the filters. `isDateMode` is whether the selected option is a
 * date range; text modes match "Status" against the status and anything else
 * against the free-text field, case-insensitively.
 */
export const filterReportRows = <T>(
  rows: T[],
  accessors: ReportRowAccessors,
  filters: ReportFilters,
  isDateMode: boolean
): T[] => {
  const needle = filters.searchValue.trim().toLowerCase();
  return rows.filter((row) => {
    /**
     * The range applies to every report, whichever filter is selected.
     * It used to apply only in the "Date" mode, so a report searched by name
     * carried rows from outside the dates it printed in its own header.
     * withinRange is true when no range is set, so a dateless call is
     * unchanged.
     */
    if (!withinRange(accessors.date(row), filters.startDate, filters.endDate)) return false;
    if (isDateMode) return true;
    if (!needle) return true;
    const haystack = filters.mode === 'Status' ? accessors.status(row) : accessors.text(row);
    return haystack.toLowerCase().includes(needle);
  });
};

/**
 * Whether the two dates can produce a report.
 *
 * Returns the message to show, or null when the range is usable. Both dates
 * are required for every report: a report that does not state the period it
 * covers cannot be checked by whoever receives it, and an absent date used to
 * be printed in the header as "-".
 */
export const validateReportDateRange = (startDate: string, endDate: string): string | null => {
  const start = startDate.trim();
  const end = endDate.trim();

  // Named individually so a half-filled form says which half is missing.
  if (!start && !end) return 'Start Date and End Date are required.';
  if (!start) return 'Start Date is required.';
  if (!end) return 'End Date is required.';

  if (reportDayEnd(end).getTime() < reportDayStart(start).getTime()) {
    return 'End Date cannot be earlier than Start Date.';
  }
  return null;
};

/** Whether the inputs differ from the ones a report was generated with. */
export const filtersDiffer = (a: ReportFilters | null, b: ReportFilters): boolean =>
  !a ||
  a.mode !== b.mode ||
  a.searchValue !== b.searchValue ||
  a.startDate !== b.startDate ||
  a.endDate !== b.endDate ||
  (a.eventId ?? '') !== (b.eventId ?? '');

// ── Run state ────────────────────────────────────────────────────────────────

export type ReportRunStatus = 'idle' | 'loading' | 'success' | 'error';

export interface ReportRunState {
  /** The report this run belongs to. */
  reportKey: ReportKey;
  status: ReportRunStatus;
  /** Id of the request whose response is still wanted. */
  requestId: number;
  rows: any[];
  error: string | null;
  /** Filters the displayed report was generated with; null until a search. */
  applied: ReportFilters | null;
}

export type ReportRunAction =
  | { type: 'start'; reportKey: ReportKey; requestId: number; filters: ReportFilters }
  | { type: 'success'; requestId: number; rows: any[] }
  | { type: 'failure'; requestId: number; error: string }
  /** Back to "no report generated" — used for tab switches and Clear. */
  | { type: 'reset'; reportKey: ReportKey; requestId: number };

export const initialReportRun = (reportKey: ReportKey): ReportRunState => ({
  reportKey,
  status: 'idle',
  requestId: 0,
  rows: [],
  error: null,
  applied: null,
});

export const reportRunReducer = (state: ReportRunState, action: ReportRunAction): ReportRunState => {
  switch (action.type) {
    case 'start':
      return {
        reportKey: action.reportKey,
        status: 'loading',
        requestId: action.requestId,
        // Previous rows are dropped rather than shown under the new filters.
        rows: [],
        error: null,
        applied: action.filters,
      };
    case 'success':
      // A response for a superseded request (another search, a tab switch or
      // Clear since) is ignored.
      if (action.requestId !== state.requestId || state.status !== 'loading') return state;
      return { ...state, status: 'success', rows: action.rows, error: null };
    case 'failure':
      if (action.requestId !== state.requestId || state.status !== 'loading') return state;
      return { ...state, status: 'error', rows: [], error: action.error };
    case 'reset':
      return { ...initialReportRun(action.reportKey), requestId: action.requestId };
    default:
      return state;
  }
};

/** Results may be shown only for a completed run of the report on screen. */
export const hasResultsFor = (state: ReportRunState, reportKey: ReportKey): boolean =>
  state.status === 'success' && state.reportKey === reportKey;

// ── Report type selection ────────────────────────────────────────────────────

export interface ReportSelection {
  /** False until a report type has been chosen on this visit. */
  chosen: boolean;
  reportKey: ReportKey;
}

/**
 * Whether choosing `next` starts that report from its filter-only state.
 *
 * The first choice always does, as does switching to a different type — so a
 * report's filters and results never carry over into another. Choosing the
 * type that is already selected does not, so an accidental second click cannot
 * throw away a generated report. Choosing never fetches anything either way.
 */
export const selectingResetsReport = (current: ReportSelection, next: ReportKey): boolean =>
  !current.chosen || current.reportKey !== next;

/**
 * The report type named by the `?type=` URL parameter the sidebar links set,
 * or null when there is none, it is unknown, or it is the Access Report for a
 * role that may not see it. Null means "no report type chosen".
 */
export const parseReportType = (value: string | null, canViewAccessReport: boolean): ReportKey | null => {
  if (value === 'event' || value === 'contact') return value;
  if (value === 'access') return canViewAccessReport ? 'access' : null;
  return null;
};
