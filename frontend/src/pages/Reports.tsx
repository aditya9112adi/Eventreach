import { useState, useEffect, useMemo, useCallback, useReducer, useRef } from 'react';
import api from '../services/api';
import { useAuth } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CampaignReportContent } from './Campaigns/CampaignReport';
import { FileText, CalendarDays, ShieldCheck, Users } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { PaginationControls } from '../components/ui/PaginationControls';
import { EventSearch } from '../components/ui/EventSearch';
import { ReportFilterBar, type ReportFilterOption } from '../components/ui/ReportFilterBar';
import { EventDeliveryLog } from '../components/ui/EventDeliveryLog';
import { formatDate, formatDateTime } from '../utils/datetime';
import { getAccessStatus } from '../utils/accessStatus';
import { formatEventType } from '../utils/eventType';
import { getPaginatedData, getSerialNumber } from '../utils/pagination';
import {
  filterReportRows,
  validateReportDateRange,
  filtersDiffer,
  hasResultsFor,
  selectingResetsReport,
  parseReportType,
  initialReportRun,
  reportRunReducer,
  type ReportFilters,
  type ReportKey,
} from '../utils/reportSearch';
import {
  buildReportFileName,
  exportToExcel,
  exportToPdf,
  type ReportColumn,
} from '../utils/reportExport';

interface ReportDefinition {
  key: ReportKey;
  /** Tab label. */
  label: string;
  icon: typeof FileText;
  /** Used to build the download name, e.g. "AccessReport". */
  fileName: string;
  /** Endpoint the rows come from. Authorization is enforced server-side. */
  endpoint: string;
  options: ReportFilterOption[];
  /** Free-text field the "name" filter searches. */
  text: (row: any) => string;
  /** Status the "Status" filter matches and the table shows. */
  status: (row: any) => string;
  /** Date the "Date" range filters on. */
  date: (row: any) => string | undefined;
  columns: ReportColumn<any>[];
}

const value = (input: unknown, fallback = ''): string =>
  input === null || input === undefined || input === '' ? fallback : String(input);

const REPORTS: Record<ReportKey, ReportDefinition> = {
  event: {
    key: 'event',
    label: 'Event Report',
    icon: CalendarDays,
    fileName: 'EventReport',
    endpoint: '/events',
    options: [
      { key: 'EventName', label: 'Name / ID', type: 'text' },
      { key: 'EventID', label: 'Event ID', type: 'text' },
      { key: 'Status', label: 'Status', type: 'text' },
      { key: 'Date', label: 'Date', type: 'date' },
    ],
    // Searched for both the "Name / ID" and "Event ID" text filters, so
    // "Wedding" and "EVT-000003" both match.
    text: (row) => `${value(row.eventId)} ${value(row.eventName)}`,
    status: (row) => value(row.eventStatus, 'Upcoming'),
    date: (row) => row.eventDate,
    columns: [
      { header: 'Event ID', value: (r) => value(r.eventId, '-'), width: 14 },
      { header: 'Event Name', value: (r) => value(r.eventName), width: 28 },
      { header: 'Event Type', value: (r) => value(formatEventType(r.eventType), '-'), width: 18 },
      { header: 'Organizer', value: (r) => value(r.organizerName, '-'), width: 22 },
      { header: 'Mobile', value: (r) => value(r.organizerMobile, '-'), width: 16 },
      { header: 'Date', value: (r) => formatDate(r.eventDate, '-'), width: 14 },
      { header: 'Time', value: (r) => value(r.eventTime, '-'), width: 12 },
      { header: 'Venue', value: (r) => value(r.eventVenue, '-'), width: 26 },
      { header: 'Status', value: (r) => value(r.eventStatus, 'Upcoming'), width: 14 },
    ],
  },
  access: {
    key: 'access',
    label: 'Access Report',
    icon: ShieldCheck,
    fileName: 'AccessReport',
    endpoint: '/admin/users/access-records',
    options: [
      { key: 'UserName', label: 'UserName', type: 'text' },
      { key: 'Status', label: 'Status', type: 'text' },
      { key: 'Date', label: 'Date', type: 'date' },
    ],
    text: (row) => `${value(row.name)} ${value(row.email)}`,
    status: (row) => getAccessStatus(row),
    date: (row) => row.accessGrantedOn || row.createdAt,
    columns: [
      { header: 'Name', value: (r) => value(r.name, '-'), width: 24 },
      { header: 'Email', value: (r) => value(r.email, '-'), width: 30 },
      { header: 'Role', value: (r) => value(r.role || r.type, '-'), width: 14 },
      { header: 'Status', value: (r) => getAccessStatus(r), width: 14 },
      { header: 'Assigned Event', value: (r) => value(r.assignedEventName, '-'), width: 26 },
      { header: 'Access Granted On', value: (r) => formatDateTime(r.accessGrantedOn, '-'), width: 24 },
      { header: 'Access Start', value: (r) => formatDateTime(r.accessStartDate, '-'), width: 24 },
      { header: 'Access Expiry', value: (r) => formatDateTime(r.accessExpiryDate, '-'), width: 24 },
    ],
  },
  contact: {
    key: 'contact',
    label: 'Contact Report',
    icon: Users,
    fileName: 'ContactReport',
    endpoint: '/contacts',
    options: [
      { key: 'Name', label: 'Name', type: 'text' },
      { key: 'Status', label: 'Status', type: 'text' },
      { key: 'Date', label: 'Date', type: 'date' },
    ],
    text: (row) => `${value(row.fullName)} ${value(row.phoneNumber)} ${value(row.email)}`,
    status: (row) => value(row.status, '-'),
    date: (row) => row.createdAt,
    columns: [
      { header: 'Full Name', value: (r) => value(r.fullName, '-'), width: 26 },
      {
        header: 'Phone',
        // phoneNumber is already stored in E.164 (+919876543210), so prefixing
        // the country code produced "IN+919876543210" in every export.
        value: (r) => value(r.phoneNumber, '-'),
        width: 18,
      },
      { header: 'Email', value: (r) => value(r.email, '-'), width: 30 },
      { header: 'Event', value: (r) => value(r.eventName, '-'), width: 26 },
      { header: 'Source', value: (r) => value(r.source, '-'), width: 16 },
      { header: 'Status', value: (r) => value(r.status, '-'), width: 14 },
      { header: 'Added On', value: (r) => formatDateTime(r.createdAt, '-'), width: 24 },
    ],
  },
};

const Reports = () => {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [activeReport, setActiveReport] = useState<ReportKey>('event');
  /**
   * Whether a report type has been chosen. A Super Admin picks the report
   * type from the REPORTS submenu in the sidebar, which sets `?type=` on this
   * page; with no type there are no filters yet. Other roles keep the original
   * page, which opens straight on the Event Report.
   */
  const [reportChosen, setReportChosen] = useState<boolean>(() => user?.role !== 'SuperAdmin');
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [loadingCampaign, setLoadingCampaign] = useState(false);

  // The generated report for the tab on screen: nothing, loading, loaded or
  // failed, plus the filters it was generated with. See utils/reportSearch.ts.
  const [run, dispatch] = useReducer(reportRunReducer, 'event', initialReportRun);
  // Every request gets a fresh id; a response whose id is no longer current
  // (another search, a tab switch or Clear since) is ignored by the reducer.
  const requestSeq = useRef(0);
  const nextRequestId = () => ++requestSeq.current;

  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  const [mode, setMode] = useState<string>('EventName');
  const [searchValue, setSearchValue] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  /** Why the chosen dates cannot produce a report; '' once they can. */
  const [dateError, setDateError] = useState('');

  // Authorization check
  const hasReportAccess = user?.role === 'SuperAdmin' || (user?.accessExpiryDate && new Date(user.accessExpiryDate) > new Date() && !user?.isAccessCancelled);

  // The access records endpoint is Super Admin / Admin only, so the tab is only
  // offered to those roles. The server enforces this regardless.
  const canViewAccessReport = user?.role === 'SuperAdmin' || user?.role === 'Admin';

  /**
   * Super Admins generate reports explicitly: a tab opens on its filters only,
   * and report data is fetched when Search is pressed, not when the page or a
   * tab opens. Other roles keep the original behaviour - the tab loads and the
   * filters apply as they type.
   */
  const searchFirst = user?.role === 'SuperAdmin';
  // The report-type step exists only in the Super Admin flow.
  const showReport = !searchFirst || reportChosen;
  const [searchParams] = useSearchParams();
  const requestedType = parseReportType(searchParams.get('type'), canViewAccessReport);

  const visibleReports = useMemo(
    () =>
      (Object.keys(REPORTS) as ReportKey[])
        .filter((key) => key !== 'access' || canViewAccessReport)
        .map((key) => REPORTS[key]),
    [canViewAccessReport]
  );

  const definition = REPORTS[activeReport];

  useEffect(() => {
    if (!hasReportAccess) {
      showToast('error', 'You do not have permission to view reports. Please request access from the Super Admin.');
      navigate('/dashboard');
      return;
    }

    // Super Admins make no report-data request on opening Reports. The events
    // list is loaded on demand instead — see loadEventsForSelectors below.
    if (searchFirst) return;

    // Needed by the "Select Event Name" picker and to name each contact's
    // event in the Contact Report.
    api.get('/events')
      .then(res => setEvents(res.data))
      .catch(err => console.error('Failed to fetch events', err));
  }, [hasReportAccess, searchFirst, navigate, showToast]);

  const liveFilters: ReportFilters = useMemo(
    () => ({ mode, searchValue, startDate, endDate }),
    [mode, searchValue, startDate, endDate]
  );
  // Read by the auto-load effect below without making it a dependency: for
  // roles that filter live, editing a filter must not trigger a reload.
  const liveFiltersRef = useRef(liveFilters);
  liveFiltersRef.current = liveFilters;

  /**
   * The complete authorized event list, for the "Select Event Name" picker,
   * the campaign drill-down, and naming each contact's event in the Contact
   * Report.
   *
   * Deliberately sent WITHOUT the report's date range, and deliberately not
   * filled from the Event Report's response. The Event Report asks the server
   * for the events inside the chosen period; using that answer as this cache
   * would leave a contact whose event falls outside the period with no name to
   * show, and would empty the picker of everything the report excluded.
   */
  const eventsRequested = useRef(false);
  const loadEventsForSelectors = useCallback(() => {
    if (eventsRequested.current) return;
    eventsRequested.current = true;
    api.get('/events')
      .then((res) => setEvents(res.data))
      .catch((err) => {
        eventsRequested.current = false; // allow a retry on the next open
        console.error('Failed to fetch events', err);
      });
  }, []);

  /** Fetches a report's rows as one run. */
  const loadReport = useCallback(async (key: ReportKey, filters: ReportFilters) => {
    const requestId = nextRequestId();
    dispatch({ type: 'start', reportKey: key, requestId, filters });
    try {
      /**
       * Every report states the period it covers, so every report request
       * carries it. The server applies the field that report is filtered on —
       * eventDate, createdAt or accessGrantedOn — and refuses a range it
       * cannot use.
       */
      const res = await api.get(REPORTS[key].endpoint, {
        params: { startDate: filters.startDate, endDate: filters.endDate },
      });
      const rows = Array.isArray(res.data) ? res.data : [];
      dispatch({ type: 'success', requestId, rows });
    } catch (err: any) {
      console.error(`Failed to fetch ${REPORTS[key].label}`, err);
      dispatch({
        type: 'failure',
        requestId,
        error: err?.response?.data?.error || 'Could not load this report. Please try again.',
      });
    }
  }, []);

  /**
   * Roles other than Super Admin filter live: the tab loads its own rows rather
   * than waiting for a Search press. The date range is required of them all the
   * same, so this path runs the identical check before it fetches anything.
   *
   * A tab opened before any date is chosen shows its filters and the message
   * saying what is still needed — it does not call the API and is not reported
   * as a failed load. Half a range behaves the same way, which is what stops
   * "?startDate=2026-10-01&endDate=" ever being sent and coming back 400.
   *
   * The Event Report no longer reads the events cache here: every report,
   * whatever the role, is generated from its own dated request.
   */
  useEffect(() => {
    if (!hasReportAccess || searchFirst) return;

    const problem = validateReportDateRange(startDate, endDate);
    if (problem) {
      setDateError(problem);
      // No rows rather than stale or undated ones.
      dispatch({ type: 'reset', reportKey: activeReport, requestId: nextRequestId() });
      return;
    }

    setDateError('');
    void loadReport(activeReport, liveFiltersRef.current);
  }, [hasReportAccess, searchFirst, activeReport, loadReport, startDate, endDate]);

  /** Super Admin: generate the report for the current filters. */
  const runSearch = () => {
    // Both dates are required, and the request is not made until they are
    // usable: a report generated without them states its period as "-".
    const problem = validateReportDateRange(startDate, endDate);
    if (problem) {
      setDateError(problem);
      return;
    }
    setDateError('');
    setCurrentPage(1);
    setSelectedEventId('');
    // Contacts carry only an eventId; the event names come from the events list.
    // The cache is what names a contact's event and backs the drill-down, and
    // it is no longer a by-product of the Event Report's own response.
    loadEventsForSelectors();
    void loadReport(activeReport, liveFilters);
  };

  useEffect(() => {
    if (!selectedEventId) {
      setCampaignId(null);
      return;
    }

    setLoadingCampaign(true);
    api.get(`/campaigns/event/${selectedEventId}`)
      .then(res => {
        // Returns campaign or empty draft.
        // We only show report if it actually exists and has an _id (meaning it was saved/sent)
        if (res.data && res.data._id && res.data.status !== 'Draft') {
          setCampaignId(res.data._id);
        } else {
          setCampaignId(null);
        }
      })
      .catch(err => {
        console.error('Failed to fetch campaign for event', err);
        setCampaignId(null);
      })
      .finally(() => {
        setLoadingCampaign(false);
      });
  }, [selectedEventId]);

  const eventNameById = useMemo(() => {
    const map = new Map<string, string>();
    events.forEach((evt: any) => map.set(String(evt._id), evt.eventName));
    return map;
  }, [events]);

  /**
   * Contacts come back with only `eventId`, so the event name is resolved from
   * the events already loaded for this user rather than adding a populate to
   * the shared /contacts endpoint.
   */
  const hasResults = hasResultsFor(run, activeReport);

  const decoratedRows = useMemo(() => {
    if (!hasResults) return [];
    if (activeReport !== 'contact') return run.rows;
    return run.rows.map((row: any) => ({
      ...row,
      eventName: eventNameById.get(String(row.eventId)) ?? '',
    }));
  }, [hasResults, run.rows, activeReport, eventNameById]);

  const switchReport = (key: ReportKey) => {
    // Choosing a type never fetches. Re-choosing the selected type is a no-op
    // for Super Admins, so a stray click cannot discard a generated report.
    if (searchFirst) {
      const resets = selectingResetsReport({ chosen: reportChosen, reportKey: activeReport }, key);
      setReportChosen(true);
      if (!resets) return;
    }
    setActiveReport(key);
    // Each report has its own filter fields, so reset rather than carry over a
    // mode that does not exist on the new tab.
    setMode(REPORTS[key].options[0].key);
    setSearchValue('');
    /**
     * The period is deliberately NOT reset.
     *
     * It is the one filter every report shares and the one every report is
     * required to state, so clearing it on each tab made the reader re-enter
     * the same two dates to look at the same month from another angle. The
     * tab-specific fields above still start fresh.
     */
    setSelectedEventId('');
    setCurrentPage(1);
    // A fresh tab starts with no report. Resetting with a new request id also
    // discards any response still on its way for the previous tab.
    dispatch({ type: 'reset', reportKey: key, requestId: nextRequestId() });
  };

  const clearFilters = () => {
    setSearchValue('');
    setStartDate('');
    setEndDate('');
    if (searchFirst) {
      // Back to the initial state: no report, and nothing fetched.
      setCurrentPage(1);
      dispatch({ type: 'reset', reportKey: activeReport, requestId: nextRequestId() });
    }
  };

  /**
   * Super Admin: the sidebar's REPORTS submenu is the report-type selector. It
   * links here with `?type=event|access|contact`, so the chosen type follows
   * the URL — the sidebar highlight, Back/Forward and a refresh all agree with
   * the page. Choosing a type still never fetches anything; without a type the
   * page returns to "no report type chosen".
   */
  const switchReportRef = useRef(switchReport);
  switchReportRef.current = switchReport;
  useEffect(() => {
    if (!searchFirst) return;
    if (requestedType) {
      switchReportRef.current(requestedType);
      return;
    }
    setReportChosen(false);
    setSearchValue('');
    setStartDate('');
    setEndDate('');
    setSelectedEventId('');
    setCurrentPage(1);
    dispatch({ type: 'reset', reportKey: 'event', requestId: nextRequestId() });
  }, [searchFirst, requestedType]);

  const activeOption =
    definition.options.find((option) => option.key === mode) ?? definition.options[0];

  // Super Admins see the report for the filters it was generated with, so the
  // table and the downloads keep matching what was searched even if the inputs
  // are edited afterwards. Other roles filter live, as before.
  const reportFilters: ReportFilters | null = searchFirst ? (hasResults ? run.applied : null) : liveFilters;
  const reportOption =
    definition.options.find((option) => option.key === reportFilters?.mode) ?? activeOption;

  const filteredRows = useMemo(
    () =>
      reportFilters
        ? filterReportRows(decoratedRows, definition, reportFilters, reportOption.type === 'date')
        : [],
    [decoratedRows, definition, reportFilters, reportOption]
  );

  const pagedRows = useMemo(
    () => getPaginatedData(filteredRows, currentPage, rowsPerPage),
    [filteredRows, currentPage, rowsPerPage]
  );

  // With live filtering the row set changes as the inputs change, so start
  // again from the first page.
  useEffect(() => {
    if (!searchFirst) setCurrentPage(1);
  }, [searchFirst, searchValue, startDate, endDate, mode]);

  useEffect(() => {
    setCurrentPage(1);
  }, [rowsPerPage]);

  useEffect(() => {
    const totalPages = Math.ceil(filteredRows.length / rowsPerPage);
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages);
  }, [filteredRows.length, currentPage, rowsPerPage]);

  const fileNamePreview = useMemo(
    () => buildReportFileName(definition.fileName, reportOption.key),
    [definition.fileName, reportOption.key]
  );

  // filteredRows is built from reportFilters; the export must use the same
  // object, never the live inputs, or a download could claim filters the table
  // never used.
  const exportFilters = reportFilters ?? liveFilters;

  const filtersChanged = searchFirst && hasResults && filtersDiffer(run.applied, liveFilters);

  const runExport = useCallback(
    async (kind: 'excel' | 'pdf') => {
      // Guarded here as well as on the button: the file carries the dates in
      // its own header, so it must never be written without them.
      const problem = validateReportDateRange(exportFilters.startDate, exportFilters.endDate);
      if (problem) {
        setDateError(problem);
        showToast('warning', problem);
        return;
      }
      if (filteredRows.length === 0) {
        showToast('warning', 'There is nothing to download for this filter.');
        return;
      }

      setIsExporting(true);
      try {
        const name = buildReportFileName(definition.fileName, reportOption.key);
        // The very filters the visible table was built from, so the download
        // states its own scope and can never describe a different dataset.
        const meta = {
          searchValue: exportFilters.searchValue,
          startDate: exportFilters.startDate,
          endDate: exportFilters.endDate,
        };
        if (kind === 'excel') {
          await exportToExcel(name, definition.label, definition.columns, filteredRows, meta);
        } else {
          await exportToPdf(name, definition.label, definition.columns, filteredRows, meta);
        }
        showToast('success', `${name}.${kind === 'excel' ? 'xlsx' : 'pdf'} downloaded`);
      } catch (error) {
        console.error('Report export failed', error);
        showToast('error', 'Could not generate the file. Please try again.');
      } finally {
        setIsExporting(false);
      }
    },
    [filteredRows, definition, reportOption.key, exportFilters, showToast]
  );

  /**
   * The event the Delivery Log belongs to.
   *
   * A Delivery Log is one event's recipients, so it needs exactly one event:
   * the report must have been generated and have narrowed to a single row. With
   * several events in the result there is no single log to show - the section
   * says so instead of choosing one, and an event can still be opened in full
   * from Select Event Name.
   *
   * Derived from the rows the table is already showing, so it adds no request
   * of its own: the log fetches only once this has a value.
   */
  const deliveryLogEventId: string | null =
    activeReport === 'event' && hasResults && filteredRows.length === 1
      ? String((filteredRows[0] as any)?._id ?? '') || null
      : null;

  const statusVariant = (status: string) => {
    switch (status) {
      case 'Active':
      case 'Completed':
      case 'Valid':
        return 'success';
      case 'Scheduled':
      case 'Upcoming':
      case 'Duplicate':
        return 'warning';
      case 'Rejected':
      case 'Expired':
      case 'Cancelled':
      case 'Invalid':
        return 'error';
      default:
        return 'default';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-sans font-bold text-foreground animate-slide-in uppercase">Reports</h2>
          <p className="text-xs text-foreground/50 mt-1">
            {showReport
              ? `Filter and download ${definition.label.toLowerCase()}s as Excel or PDF`
              : 'Choose a report type under Reports in the sidebar, then set its filters and search'}
          </p>
        </div>

        {showReport && activeReport === 'event' && (
          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 relative z-50">
            {/* Event Search dropdown — drills into a campaign report */}
            <div className='flex flex-col w-[260px]'>
              <label className='text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1'>Select Event Name</label>
              <EventSearch
                events={events}
                value={selectedEventId}
                onChange={(id) => setSelectedEventId(id)}
                placeholder='Search events...'
                allowClear={true}
                onOpen={searchFirst ? loadEventsForSelectors : undefined}
              />
            </div>
          </div>
        )}
      </div>

      {/* Report type tabs — roles other than Super Admin, whose report types
          are in the sidebar under REPORTS. */}
      {!searchFirst && (
      <div className="flex flex-wrap gap-2 border-b border-border">
        {visibleReports.map((report) => {
          const Icon = report.icon;
          const isActive = report.key === activeReport;
          return (
            <button
              key={report.key}
              type="button"
              onClick={() => switchReport(report.key)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-bold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-accent text-accent'
                  : 'border-transparent text-foreground/50 hover:text-foreground'
              }`}
            >
              <Icon className="w-4 h-4" />
              {report.label}
            </button>
          );
        })}
      </div>
      )}

      {!showReport ? (
        <div className="glass-panel p-12 flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-border/50 animate-fade-in">
          <FileText className="w-12 h-12 text-foreground/20 mb-3" />
          <p className="text-foreground/60 font-medium">
            Select a report type under <span className="text-accent font-bold">REPORTS</span> in the sidebar to see its filters.
          </p>
        </div>
      ) : (
      <>
      <ReportFilterBar
        options={definition.options}
        mode={mode}
        onModeChange={setMode}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        startDate={startDate}
        onStartDateChange={(value) => {
          setStartDate(value);
          setDateError('');
        }}
        endDate={endDate}
        onEndDateChange={(value) => {
          setEndDate(value);
          setDateError('');
        }}
        dateError={dateError}
        onClear={clearFilters}
        onDownloadExcel={() => runExport('excel')}
        onDownloadPdf={() => runExport('pdf')}
        resultCount={filteredRows.length}
        isExporting={isExporting}
        fileNamePreview={fileNamePreview}
        {...(searchFirst
          ? {
              onSearch: runSearch,
              isSearching: run.status === 'loading',
              hasGenerated: hasResults,
              filtersChanged,
            }
          : {})}
      />

      {/* Event Report keeps its original campaign drill-down. */}
      {activeReport === 'event' && selectedEventId ? (
        loadingCampaign ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : campaignId ? (
          <div className="animate-fade-up">
            <CampaignReportContent
              campaignIdProp={campaignId}
              hideHeader={false}
              hideBackButton={false}
              showPrintButton={true}
              onBack={() => setSelectedEventId('')}
            />
          </div>
        ) : (
          <div className="glass-panel p-16 flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-border/50 animate-fade-in">
            <FileText className="w-16 h-16 text-foreground/20 mb-4" />
            <h3 className="text-xl font-bold text-foreground/70 mb-2">No Reports Available</h3>
            <p className="text-foreground/50">There are no sent or completed campaigns for this event yet.</p>
            <button
              onClick={() => setSelectedEventId('')}
              className="mt-6 text-accent hover:text-accent/80 font-medium text-sm transition-colors"
            >
              ← Back to All Events
            </button>
          </div>
        )
      ) : (
        <div className="glass-panel rounded-2xl p-6 animate-spring-up">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">
              {definition.label}
            </h3>
          </div>

          {run.status === 'loading' ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : run.status === 'error' && run.reportKey === activeReport ? (
            <p className="text-destructive text-center py-8 text-sm font-medium">{run.error}</p>
          ) : searchFirst && !hasResults ? (
            <div className="flex flex-col items-center justify-center text-center py-14">
              <FileText className="w-12 h-12 text-foreground/20 mb-3" />
              <p className="text-foreground/60 font-medium">
                Select your filters and search to generate a report.
              </p>
            </div>
          ) : filteredRows.length === 0 ? (
            <p className="text-foreground/40 text-center py-8">
              {searchFirst
                ? 'No reports found for the selected filters.'
                : run.rows.length === 0
                  ? `No ${definition.label.toLowerCase()} data found.`
                  : 'No records match this filter.'}
            </p>
          ) : (
            <>
            <div className="table-scroll">
              <table className="w-full min-w-[870px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    {/* On screen only. The column definitions also drive the Excel
                        and PDF exports and are untouched, so exports are unchanged. */}
                    <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs whitespace-nowrap pr-4 w-20">Sr No</th>
                    {definition.columns.map((column) => (
                      <th
                        key={column.header}
                        className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs whitespace-nowrap pr-4"
                      >
                        {column.header}
                      </th>
                    ))}
                    {activeReport === 'event' && (
                      <th className="pb-3 font-semibold text-foreground/60"></th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pagedRows.map((row: any, index: number) => (
                    <tr key={row._id} className="hover:bg-surfaceHover transition-colors group">
                      <td className="py-4 pr-4 text-foreground/50 tabular-nums whitespace-nowrap">{getSerialNumber(currentPage, rowsPerPage, index)}</td>
                      {definition.columns.map((column) => {
                        const cell = String(column.value(row));
                        return (
                          <td
                            key={column.header}
                            className="py-4 pr-4 text-foreground/70 whitespace-nowrap"
                          >
                            {column.header === 'Status' ? (
                              <Badge variant={statusVariant(cell) as any}>{cell}</Badge>
                            ) : (
                              cell
                            )}
                          </td>
                        );
                      })}
                      {activeReport === 'event' && (
                        <td className="py-4 text-right">
                          {/* Same View button as the Events list and Audit Logs. */}
                          <Button variant="secondary" className="text-xs py-1.5 px-3" onClick={() => setSelectedEventId(row._id)}>
                            View
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationControls
              currentPage={currentPage}
              rowsPerPage={rowsPerPage}
              totalItems={filteredRows.length}
              onPageChange={setCurrentPage}
              onRowsChange={setRowsPerPage}
            />
            </>
          )}
        </div>
      )}

      {/*
        Delivery Log: the WhatsApp recipients of the event being reported.
        Below the event table rather than as columns of it, so the Event Report
        keeps its nine columns. Mounted only after a report exists, and only for
        the Event Report, so nothing is fetched on opening Reports, on switching
        tabs, or after Clear.
      */}
      {activeReport === 'event' && !selectedEventId && hasResults && filteredRows.length > 0 && (
        deliveryLogEventId ? (
          <div className="mt-6 animate-fade-up">
            <EventDeliveryLog key={deliveryLogEventId} eventId={deliveryLogEventId} />
          </div>
        ) : (
          <p className="mt-6 text-sm text-foreground/50 text-center">
            The Delivery Log shows one event at a time. Narrow the report to a single event,
            or choose one under Select Event Name.
          </p>
        )
      )}
      </>
      )}
    </div>
  );
};

export default Reports;
