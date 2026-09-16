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
}

export interface ReportRowAccessors {
  /** Free-text field the text filters search. */
  text: (row: any) => string;
  /** Status the "Status" filter matches. */
  status: (row: any) => string;
  /** Date the date-range filter uses. */
  date: (row: any) => string | undefined;
}

/** Start of day / end of day so a range is inclusive of both endpoints. */
export const withinRange = (raw: string | undefined, start: string, end: string): boolean => {
  if (!start && !end) return true;
  if (!raw) return false;
  const when = new Date(raw).getTime();
  if (Number.isNaN(when)) return false;
  if (start && when < new Date(`${start}T00:00:00`).getTime()) return false;
  if (end && when > new Date(`${end}T23:59:59.999`).getTime()) return false;
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
    if (isDateMode) return withinRange(accessors.date(row), filters.startDate, filters.endDate);
    if (!needle) return true;
    const haystack = filters.mode === 'Status' ? accessors.status(row) : accessors.text(row);
    return haystack.toLowerCase().includes(needle);
  });
};

/** Whether the inputs differ from the ones a report was generated with. */
export const filtersDiffer = (a: ReportFilters | null, b: ReportFilters): boolean =>
  !a ||
  a.mode !== b.mode ||
  a.searchValue !== b.searchValue ||
  a.startDate !== b.startDate ||
  a.endDate !== b.endDate;

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
