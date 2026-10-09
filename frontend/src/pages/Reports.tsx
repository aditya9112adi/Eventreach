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
import { EventDeliveryExport } from '../components/ui/EventDeliveryExport';
import { ReportEventView } from '../components/ui/ReportEventView';
import { formatDate, formatDateTime } from '../utils/datetime';
import { accessStatusOf, ACCESS_STATUSES } from '../utils/accessStatus';
import { formatEventType } from '../utils/eventType';
import { getPaginatedData, getSerialNumber } from '../utils/pagination';
import {
  filterReportRows,
  matchesStatusWord,
  validateReportDateRange,
  filtersDiffer,
  hasResultsFor,
  selectingResetsReport,
  parseReportType,
  reportEventParam,
  reportAccessParams,
  EVENT_SCOPED_REPORTS,
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
import {
  groupRecordsByEvent,
  countUnlinkedRecords,
  accessRecordEventIds,
  contactRecordEventIds,
} from '../utils/reportEventGroups';
import {
  exportEventReportExcel,
  exportEventReportPdf,
  fetchReportDeliveryRows,
} from '../utils/eventReportExport';

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
  /** How that status is matched, where plain "contains" is ambiguous. */
  statusMatches?: (status: string, needle: string) => boolean;
  /** Date the "Date" range filters on. */
  date: (row: any) => string | undefined;
  columns: ReportColumn<any>[];
  /**
   * Access and Contact Reports: the events a record belongs to, so the report
   * is shown one row per event, and what the row's count and View call them.
   */
  eventIds?: (row: any) => string[];
  countLabel?: string;
  /**
   * The Access Report: a Status dropdown applied together with the search box,
   * the dates and the event - instead of choosing one filter at a time.
   */
  statusChoices?: ReadonlyArray<string>;
  detailsTitle?: string;
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
    // UserName, Status and the dates all apply together: the search box is the
    // username, Status has its own dropdown, and the period is always required.
    // Choosing one of them at a time made combining them impossible, and the
    // "Date" choice switched the username search off while still showing it.
    options: [{ key: 'UserName', label: 'UserName', type: 'text' }],
    statusChoices: ACCESS_STATUSES,
    text: (row) => `${value(row.name)} ${value(row.email)}`,
    status: (row) => accessStatusOf(row),
    date: (row) => row.accessGrantedOn || row.createdAt,
    eventIds: accessRecordEventIds,
    countLabel: 'Access Records',
    detailsTitle: 'Access Details',
    columns: [
      { header: 'Name', value: (r) => value(r.name, '-'), width: 24 },
      { header: 'Email', value: (r) => value(r.email, '-'), width: 30 },
      { header: 'Role', value: (r) => value(r.role || r.type, '-'), width: 14 },
      { header: 'Status', value: (r) => accessStatusOf(r), width: 14 },
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
    // "Valid" is part of "Invalid": the status is matched from the start of a
    // word, so a search for Valid contacts does not return the invalid ones.
    statusMatches: matchesStatusWord,
    date: (row) => row.createdAt,
    eventIds: contactRecordEventIds,
    countLabel: 'Contacts',
    detailsTitle: 'Contact Details',
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
  /**
   * The Access and Contact Reports' "Select Event Name" filter: the event the
   * next report is generated for. Separate from selectedEventId, which is the
   * Event Report's View drill-down, so neither can steer the other.
   */
  const [reportEventId, setReportEventId] = useState<string>('');
  /**
   * The event an Access or Contact Report row was opened for with View - the
   * same in-page View the Event Report has, on its own state so neither
   * report's View can open the other's.
   */
  const [scopedViewEventId, setScopedViewEventId] = useState<string>('');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [loadingCampaign, setLoadingCampaign] = useState(false);
  /**
   * The event the campaign lookup last finished for. View's two branches - the
   * campaign view, or the event's own Delivery Log - can only be chosen once
   * the lookup for the opened event has answered; before that the page shows
   * its spinner. Without this, the first render after View had no campaign yet
   * and briefly mounted the event log, firing a request it then threw away.
   */
  const [campaignCheckedFor, setCampaignCheckedFor] = useState<string>('');
  /** How many messages the opened event has in all; null until its log loads. */
  const [viewedEventMessages, setViewedEventMessages] = useState<number | null>(null);

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
  /** The Access Report's Status dropdown; '' is all statuses. */
  const [accessStatusFilter, setAccessStatusFilter] = useState('');
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
  /**
   * ?eventId= with an Access or Contact type: the event to open the report
   * on - the "Access Report" link of an event uses it. Only a well-formed id
   * is taken; the server still decides whether this user may see the event.
   */
  const rawRequestedEventId = searchParams.get('eventId') || '';
  const requestedEventId = /^[a-f0-9]{24}$/i.test(rawRequestedEventId) ? rawRequestedEventId : '';

  const visibleReports = useMemo(
    () =>
      (Object.keys(REPORTS) as ReportKey[])
        .filter((key) => key !== 'access' || canViewAccessReport)
        .map((key) => REPORTS[key]),
    [canViewAccessReport]
  );

  const definition = REPORTS[activeReport];
  const eventScoped = EVENT_SCOPED_REPORTS.includes(activeReport);

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
    () => ({
      mode,
      searchValue,
      startDate,
      endDate,
      eventId: eventScoped ? reportEventId : '',
      status: definition.statusChoices ? accessStatusFilter : '',
    }),
    [mode, searchValue, startDate, endDate, eventScoped, reportEventId, definition, accessStatusFilter]
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
  /** The picker's list is on its way, or the last attempt to load it failed. */
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsLoadFailed, setEventsLoadFailed] = useState(false);
  const loadEventsForSelectors = useCallback(() => {
    if (eventsRequested.current) return;
    eventsRequested.current = true;
    setEventsLoading(true);
    setEventsLoadFailed(false);
    api.get('/events')
      .then((res) => setEvents(res.data))
      .catch((err) => {
        eventsRequested.current = false; // allow a retry on the next open
        setEventsLoadFailed(true);
        console.error('Failed to fetch events', err);
      })
      .finally(() => setEventsLoading(false));
  }, []);

  /**
   * The Access and Contact Reports' "Select Event Name" filter is part of the
   * report's filters, so its list is fetched as soon as one of those tabs is
   * shown rather than when the picker is first opened. Opening it then lists
   * the events straight away instead of an empty dropdown while the request
   * is still on its way. This is the events list only, never report data.
   */
  useEffect(() => {
    if (searchFirst && showReport && eventScoped) loadEventsForSelectors();
  }, [searchFirst, showReport, eventScoped, loadEventsForSelectors]);

  /**
   * Roles that filter live (an Admin) have no Search button, and the Access
   * Report's username and status are applied by the server. So the report is
   * reloaded when the username has rested for a moment, or the status changes
   * - not on every keystroke. Super Admins search explicitly, as before.
   */
  const [debouncedUsername, setDebouncedUsername] = useState('');
  useEffect(() => {
    if (searchFirst || activeReport !== 'access') return;
    const timer = setTimeout(() => setDebouncedUsername(searchValue.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchFirst, activeReport, searchValue]);
  const liveAccessQuery =
    !searchFirst && activeReport === 'access' ? `${debouncedUsername}\u0000${accessStatusFilter}` : '';

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
        params: {
          startDate: filters.startDate,
          endDate: filters.endDate,
          ...reportEventParam(key, filters),
          // The Access Report's username and status are applied by the server,
          // for every role and within each role's own scope.
          ...reportAccessParams(key, filters),
        },
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
  }, [hasReportAccess, searchFirst, activeReport, loadReport, startDate, endDate, reportEventId, liveAccessQuery]);

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
    setScopedViewEventId('');
    // Contacts carry only an eventId; the event names come from the events list.
    // The cache is what names a contact's event and backs the drill-down, and
    // it is no longer a by-product of the Event Report's own response.
    loadEventsForSelectors();
    void loadReport(activeReport, liveFilters);
  };

  useEffect(() => {
    if (!selectedEventId) {
      setCampaignId(null);
      setCampaignCheckedFor('');
      return;
    }

    // Opening another event before this answers must not let this answer
    // decide which view - and so whose Delivery Log - the new event shows.
    let cancelled = false;
    setViewedEventMessages(null);
    setLoadingCampaign(true);
    api.get(`/campaigns/event/${selectedEventId}`)
      .then(res => {
        if (cancelled) return;
        // Returns campaign or empty draft.
        // We only show report if it actually exists and has an _id (meaning it was saved/sent)
        if (res.data && res.data._id && res.data.status !== 'Draft') {
          setCampaignId(res.data._id);
        } else {
          setCampaignId(null);
        }
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to fetch campaign for event', err);
        setCampaignId(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingCampaign(false);
        setCampaignCheckedFor(selectedEventId);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEventId]);

  const eventNameById = useMemo(() => {
    const map = new Map<string, string>();
    events.forEach((evt: any) => map.set(String(evt._id), evt.eventName));
    return map;
  }, [events]);

  /** "EVT-000006 | Valentines", as a download names the event it was scoped to. */
  const eventLabelById = useCallback(
    (id: string) => {
      const evt: any = events.find((e: any) => String(e._id) === String(id));
      return evt ? [evt.eventId, evt.eventName].filter(Boolean).join(' | ') : String(id);
    },
    [events]
  );

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
    setAccessStatusFilter('');
    setReportEventId('');
    /**
     * The period is deliberately NOT reset.
     *
     * It is the one filter every report shares and the one every report is
     * required to state, so clearing it on each tab made the reader re-enter
     * the same two dates to look at the same month from another angle. The
     * tab-specific fields above still start fresh.
     */
    setSelectedEventId('');
    setScopedViewEventId('');
    setCurrentPage(1);
    // A fresh tab starts with no report. Resetting with a new request id also
    // discards any response still on its way for the previous tab.
    dispatch({ type: 'reset', reportKey: key, requestId: nextRequestId() });
  };

  const clearFilters = () => {
    setSearchValue('');
    setAccessStatusFilter('');
    setReportEventId('');
    setScopedViewEventId('');
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
  /**
   * An event link: pick the event in "Select Event Name" and open its View -
   * the event's details and its records, scoped and authorized by the server.
   * The View needs no dates, so it opens straight away; Search then generates
   * the dated report for the same event.
   */
  const openRequestedEvent = (key: ReportKey) => {
    if (!requestedEventId || !EVENT_SCOPED_REPORTS.includes(key)) return;
    setReportEventId(requestedEventId);
    setScopedViewEventId(requestedEventId);
  };

  useEffect(() => {
    if (!searchFirst) return;
    if (requestedType) {
      switchReportRef.current(requestedType);
      openRequestedEvent(requestedType);
      return;
    }
    setReportChosen(false);
    setSearchValue('');
    setAccessStatusFilter('');
    setReportEventId('');
    setStartDate('');
    setEndDate('');
    setSelectedEventId('');
    setScopedViewEventId('');
    setCurrentPage(1);
    dispatch({ type: 'reset', reportKey: 'event', requestId: nextRequestId() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFirst, requestedType, requestedEventId]);

  /**
   * Roles that filter live open on the Event Report; a link naming a report
   * type (an event's "Access Report" link) opens that report instead. Without
   * ?type= nothing changes.
   */
  useEffect(() => {
    if (searchFirst || !requestedType) return;
    switchReportRef.current(requestedType);
    openRequestedEvent(requestedType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFirst, requestedType, requestedEventId]);

  const activeOption =
    definition.options.find((option) => option.key === mode) ?? definition.options[0];

  // Super Admins see the report for the filters it was generated with, so the
  // table and the downloads keep matching what was searched even if the inputs
  // are edited afterwards. Other roles filter live, as before.
  // The Access Report, whichever the role, shows the server's answer to its
  // last request and the filters that request was made with - so a username
  // still being typed cannot leave the table, or a download, out of step.
  const reportFilters: ReportFilters | null =
    searchFirst || activeReport === 'access' ? (hasResults ? run.applied : null) : liveFilters;
  const reportOption =
    definition.options.find((option) => option.key === reportFilters?.mode) ?? activeOption;

  const filteredRows = useMemo(
    () =>
      reportFilters
        ? filterReportRows(decoratedRows, definition, reportFilters, reportOption.type === 'date')
        : [],
    [decoratedRows, definition, reportFilters, reportOption]
  );

  /**
   * Access and Contact Reports: one row per event that holds at least one of
   * the matched records, shown with the Event Report's own columns, a count
   * and View. The Event Report keeps its rows as they are. The downloads are
   * unchanged either way: they are written from filteredRows, record by record.
   */
  const eventIdsOf = eventScoped ? definition.eventIds : undefined;
  const eventRows = useMemo(
    () => (eventIdsOf ? groupRecordsByEvent(filteredRows, eventIdsOf, events) : []),
    [eventIdsOf, filteredRows, events]
  );
  const unlinkedRecords = eventIdsOf ? countUnlinkedRecords(filteredRows, eventIdsOf) : 0;
  const tableRows: any[] = eventIdsOf ? eventRows : filteredRows;
  const tableColumns: ReportColumn<any>[] = eventIdsOf
    ? [
        ...REPORTS.event.columns,
        { header: definition.countLabel || 'Records', value: (r) => value(r.recordCount, '0'), width: 14 },
      ]
    : definition.columns;

  const pagedRows = useMemo(
    () => getPaginatedData(tableRows, currentPage, rowsPerPage),
    [tableRows, currentPage, rowsPerPage]
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
    const totalPages = Math.ceil(tableRows.length / rowsPerPage);
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages);
  }, [tableRows.length, currentPage, rowsPerPage]);

  /**
   * The Access Report's downloads are named for the event they cover -
   * AccessReport_EVT000006_09102026, or AccessReport_AllEvents_09102026 -
   * from the generated filters. The other reports keep their names.
   */
  const downloadLabel = useCallback(
    (filters: ReportFilters | null): string => {
      if (activeReport !== 'access') return reportOption.key;
      const evt: any = filters?.eventId ? events.find((e: any) => String(e._id) === String(filters.eventId)) : null;
      return filters?.eventId ? evt?.eventId || 'Event' : 'AllEvents';
    },
    [activeReport, reportOption.key, events]
  );
  const fileNamePreview = buildReportFileName(definition.fileName, downloadLabel(reportFilters ?? liveFilters));

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
        const name = buildReportFileName(definition.fileName, downloadLabel(exportFilters));
        // The very filters the visible table was built from, so the download
        // states its own scope and can never describe a different dataset.
        const meta = {
          searchValue: exportFilters.searchValue,
          startDate: exportFilters.startDate,
          endDate: exportFilters.endDate,
          // The generated report's event, never the picker's current value.
          ...(definition.statusChoices ? { status: exportFilters.status || 'All Statuses' } : {}),
          ...(EVENT_SCOPED_REPORTS.includes(activeReport)
            ? { event: exportFilters.eventId ? eventLabelById(exportFilters.eventId) : 'All Events' }
            : {}),
        };
        if (activeReport === 'event') {
          /**
           * The Event Report carries the WhatsApp Delivery Log of every event
           * it lists. The events are filteredRows - the very rows the table
           * shows after the search and dates - so the log covers those and
           * nothing else, and all their ids go in one batch request rather
           * than one per event. A failure here fails the download: a report
           * missing part of its log must not look complete.
           */
          const deliveryRows = await fetchReportDeliveryRows(
            filteredRows.map((row: any) => String(row._id)),
            async (eventIds, page, limit) => {
              const res = await api.post('/reports/events/delivery-log', { eventIds, page, limit });
              return { logs: res.data?.logs ?? [], total: res.data?.pagination?.total ?? 0 };
            }
          );
          const write = kind === 'excel' ? exportEventReportExcel : exportEventReportPdf;
          await write(name, definition.label, definition.columns, filteredRows, deliveryRows, meta);
        } else if (kind === 'excel') {
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
    [filteredRows, definition, activeReport, exportFilters, eventLabelById, downloadLabel, showToast]
  );

  /**
   * The event View has opened, for its downloads: found in this report's own
   * rows first and the complete events cache second, and described by the same
   * columns the Event Report table uses - so the document words the event
   * exactly as the table does.
   */
  const viewedEvent: any = selectedEventId
    ? [...(activeReport === 'event' ? run.rows : []), ...events].find(
        (evt: any) => String(evt?._id) === String(selectedEventId)
      ) ?? null
    : null;
  const viewedEventDetails: Array<[string, string]> = viewedEvent
    ? REPORTS.event.columns.map((column) => [column.header, String(column.value(viewedEvent))] as [string, string])
    : [['Event', eventNameById.get(String(selectedEventId)) || String(selectedEventId)]];

  /** The Access/Contact event opened with View, worded as the Event Report words it. */
  const scopedViewEvent: any = scopedViewEventId
    ? events.find((evt: any) => String(evt?._id) === String(scopedViewEventId)) ?? null
    : null;
  const scopedViewDetails: Array<[string, string]> = scopedViewEvent
    ? REPORTS.event.columns.map((column) => [column.header, String(column.value(scopedViewEvent))] as [string, string])
    : [['Event', String(scopedViewEventId)]];
  const decorateContact = useCallback(
    (row: any) => ({ ...row, eventName: eventNameById.get(String(row.eventId)) ?? '' }),
    [eventNameById]
  );

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

        {/* Access and Contact Reports: the same picker, as the report's event
            filter. It takes effect when the report is generated. */}
        {showReport && eventScoped && (
          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 relative z-50">
            <div className='flex flex-col w-[260px]'>
              <label className='text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1'>Select Event Name</label>
              <EventSearch
                events={events}
                value={reportEventId}
                onChange={(id) => setReportEventId(id)}
                placeholder='All events'
                allowClear={true}
                // Retried on open while the list is still empty - for every
                // role, so a failed load never leaves the filter unusable.
                onOpen={events.length === 0 ? loadEventsForSelectors : undefined}
                emptyText={
                  eventsLoading
                    ? 'Loading events...'
                    : eventsLoadFailed
                      ? 'Could not load events. Close and reopen to try again.'
                      : 'No events found'
                }
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
        statusOptions={definition.statusChoices}
        statusValue={accessStatusFilter}
        onStatusChange={setAccessStatusFilter}
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
      {/* The event's Access Report, from its Event Report View. The View itself is unchanged. */}
      {activeReport === 'event' && selectedEventId && canViewAccessReport && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            className="text-xs py-1.5 px-3"
            onClick={() => navigate(`/reports?type=access&eventId=${selectedEventId}`)}
          >
            <ShieldCheck className="w-4 h-4 mr-1.5" />
            Access Report
          </Button>
        </div>
      )}

      {activeReport === 'event' && selectedEventId ? (
        loadingCampaign || campaignCheckedFor !== selectedEventId ? (
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
          /*
            No sent campaign: the campaign view above has nothing to show, but the
            event can still have recipients - proactive template sends belong to
            the event, not to a campaign. View shows their Delivery Log here so
            every event's messages are reachable from View. The campaign view's
            own Delivery Log already includes these rows, so an event only ever
            gets one log.
          */
          <div className="space-y-4 animate-fade-up">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider truncate">
                {eventNameById.get(String(selectedEventId)) || 'Event'}
              </h3>
              <div className="flex flex-wrap items-center gap-3 shrink-0">
                {/* Beside the heading, not inside the log, so the log is unchanged. */}
                <EventDeliveryExport
                  key={selectedEventId}
                  eventId={String(selectedEventId)}
                  eventCode={String(viewedEvent?.eventId || '')}
                  eventDetails={viewedEventDetails}
                  hasMessages={viewedEventMessages === null ? null : viewedEventMessages > 0}
                />
                <button
                  onClick={() => setSelectedEventId('')}
                  className="text-accent hover:text-accent/80 font-medium text-sm transition-colors"
                >
                  ← Back to All Events
                </button>
              </div>
            </div>
            <EventDeliveryLog
              key={selectedEventId}
              eventId={String(selectedEventId)}
              onAllTotal={setViewedEventMessages}
            />
          </div>
        )
      ) : eventScoped && scopedViewEventId ? (
        /*
          Access/Contact View: the generated report decided which event rows
          exist; the View is that event alone - its details and every one of
          its records, scoped and authorized by the server.
        */
        <ReportEventView
          key={`${activeReport}:${scopedViewEventId}`}
          eventId={scopedViewEventId}
          eventName={scopedViewEvent?.eventName || ''}
          eventDetails={scopedViewDetails}
          title={definition.detailsTitle || 'Details'}
          endpoint={definition.endpoint}
          columns={definition.columns}
          decorate={activeReport === 'contact' ? decorateContact : undefined}
          statusVariant={statusVariant}
          onBack={() => setScopedViewEventId('')}
        />
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
          ) : tableRows.length === 0 ? (
            <p className="text-foreground/40 text-center py-8">
              {filteredRows.length > 0
                ? 'None of the matching records belong to an event. They are included in the downloads.'
                : searchFirst
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
                    {tableColumns.map((column) => (
                      <th
                        key={column.header}
                        className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs whitespace-nowrap pr-4"
                      >
                        {column.header}
                      </th>
                    ))}
                    {(activeReport === 'event' || eventScoped) && (
                      <th className="pb-3 font-semibold text-foreground/60"></th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pagedRows.map((row: any, index: number) => (
                    <tr key={row._id} className="hover:bg-surfaceHover transition-colors group">
                      <td className="py-4 pr-4 text-foreground/50 tabular-nums whitespace-nowrap">{getSerialNumber(currentPage, rowsPerPage, index)}</td>
                      {tableColumns.map((column) => {
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
                      {eventScoped && (
                        <td className="py-4 text-right">
                          {/* The Event Report's View, for this event's access/contact records. */}
                          <Button variant="secondary" className="text-xs py-1.5 px-3" onClick={() => setScopedViewEventId(row._id)}>
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
              totalItems={tableRows.length}
              onPageChange={setCurrentPage}
              onRowsChange={setRowsPerPage}
            />
            {unlinkedRecords > 0 && (
              <p className="text-xs text-foreground/50 mt-3">
                {unlinkedRecords} matching {unlinkedRecords === 1 ? 'record is' : 'records are'} not linked to any event; included in the downloads.
              </p>
            )}
            </>
          )}
        </div>
      )}

      </>
      )}
    </div>
  );
};

export default Reports;
