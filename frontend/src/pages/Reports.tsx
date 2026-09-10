import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { useNavigate } from 'react-router-dom';
import { CampaignReportContent } from './Campaigns/CampaignReport';
import { FileText, CalendarDays, ShieldCheck, Users } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { EventSearch } from '../components/ui/EventSearch';
import { ReportFilterBar, type ReportFilterOption } from '../components/ui/ReportFilterBar';
import { formatDate, formatDateTime } from '../utils/datetime';
import { getAccessStatus } from '../utils/accessStatus';
import {
  buildReportFileName,
  exportToExcel,
  exportToPdf,
  type ReportColumn,
} from '../utils/reportExport';

type ReportKey = 'event' | 'access' | 'contact';

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
      { header: 'Event Type', value: (r) => value(r.eventType, '-'), width: 18 },
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
        value: (r) => `${value(r.countryCode)}${value(r.phoneNumber, '-')}`,
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

/** Start of day / end of day so a range is inclusive of both endpoints. */
const withinRange = (raw: string | undefined, start: string, end: string): boolean => {
  if (!start && !end) return true;
  if (!raw) return false;
  const when = new Date(raw).getTime();
  if (Number.isNaN(when)) return false;
  if (start && when < new Date(`${start}T00:00:00`).getTime()) return false;
  if (end && when > new Date(`${end}T23:59:59.999`).getTime()) return false;
  return true;
};

const Reports = () => {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [activeReport, setActiveReport] = useState<ReportKey>('event');
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [loadingCampaign, setLoadingCampaign] = useState(false);

  // Rows for the currently selected report, plus its own filter state.
  const [rows, setRows] = useState<any[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [mode, setMode] = useState<string>('EventName');
  const [searchValue, setSearchValue] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  // Authorization check
  const hasReportAccess = user?.role === 'SuperAdmin' || (user?.accessExpiryDate && new Date(user.accessExpiryDate) > new Date() && !user?.isAccessCancelled);

  // The access records endpoint is Super Admin / Admin only, so the tab is only
  // offered to those roles. The server enforces this regardless.
  const canViewAccessReport = user?.role === 'SuperAdmin' || user?.role === 'Admin';

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

    // Fetch events for the dropdown and table
    api.get('/events')
      .then(res => setEvents(res.data))
      .catch(err => console.error('Failed to fetch events', err));
  }, [hasReportAccess, navigate, showToast]);

  // Load the rows for whichever report tab is active.
  useEffect(() => {
    if (!hasReportAccess) return;

    // The events list is already fetched above for the drill-down picker, so
    // the Event Report reuses it instead of asking for the same data twice.
    if (activeReport === 'event') {
      setRows(events);
      setRowsError(null);
      setLoadingRows(false);
      return;
    }

    let cancelled = false;
    setLoadingRows(true);
    setRowsError(null);

    api
      .get(definition.endpoint)
      .then((res) => {
        if (cancelled) return;
        setRows(Array.isArray(res.data) ? res.data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(`Failed to fetch ${definition.label}`, err);
        setRows([]);
        setRowsError(
          err.response?.data?.error || 'Could not load this report. Please try again.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingRows(false);
      });

    return () => {
      cancelled = true;
    };
  }, [definition.endpoint, definition.label, hasReportAccess, activeReport, events]);

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
  const decoratedRows = useMemo(() => {
    if (activeReport !== 'contact') return rows;
    return rows.map((row: any) => ({
      ...row,
      eventName: eventNameById.get(String(row.eventId)) ?? '',
    }));
  }, [rows, activeReport, eventNameById]);

  const switchReport = (key: ReportKey) => {
    setActiveReport(key);
    // Each report has its own filter fields, so reset rather than carry over a
    // mode that does not exist on the new tab.
    setMode(REPORTS[key].options[0].key);
    setSearchValue('');
    setStartDate('');
    setEndDate('');
    setSelectedEventId('');
  };

  const clearFilters = () => {
    setSearchValue('');
    setStartDate('');
    setEndDate('');
  };

  const activeOption =
    definition.options.find((option) => option.key === mode) ?? definition.options[0];

  const filteredRows = useMemo(() => {
    const needle = searchValue.trim().toLowerCase();

    return decoratedRows.filter((row) => {
      if (activeOption.type === 'date') {
        return withinRange(definition.date(row), startDate, endDate);
      }
      if (!needle) return true;
      const haystack =
        mode === 'Status' ? definition.status(row) : definition.text(row);
      return haystack.toLowerCase().includes(needle);
    });
  }, [decoratedRows, mode, activeOption, searchValue, startDate, endDate, definition]);

  const fileNamePreview = useMemo(
    () => buildReportFileName(definition.fileName, activeOption.key),
    [definition.fileName, activeOption.key]
  );

  const subtitle = useMemo(() => {
    if (activeOption.type === 'date') {
      if (!startDate && !endDate) return 'All dates';
      return `Date: ${startDate || 'any'} to ${endDate || 'any'}`;
    }
    return searchValue ? `${activeOption.label}: ${searchValue}` : 'No filter applied';
  }, [activeOption, searchValue, startDate, endDate]);

  const runExport = useCallback(
    async (kind: 'excel' | 'pdf') => {
      if (filteredRows.length === 0) {
        showToast('warning', 'There is nothing to download for this filter.');
        return;
      }

      setIsExporting(true);
      try {
        const name = buildReportFileName(definition.fileName, activeOption.key);
        if (kind === 'excel') {
          await exportToExcel(name, definition.label, definition.columns, filteredRows);
        } else {
          await exportToPdf(name, definition.label, definition.columns, filteredRows, subtitle);
        }
        showToast('success', `${name}.${kind === 'excel' ? 'xlsx' : 'pdf'} downloaded`);
      } catch (error) {
        console.error('Report export failed', error);
        showToast('error', 'Could not generate the file. Please try again.');
      } finally {
        setIsExporting(false);
      }
    },
    [filteredRows, definition, activeOption.key, subtitle, showToast]
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
            Filter and download {definition.label.toLowerCase()}s as Excel or PDF
          </p>
        </div>

        {activeReport === 'event' && (
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
              />
            </div>
          </div>
        )}
      </div>

      {/* Report type tabs */}
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

      <ReportFilterBar
        options={definition.options}
        mode={mode}
        onModeChange={setMode}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        startDate={startDate}
        onStartDateChange={setStartDate}
        endDate={endDate}
        onEndDateChange={setEndDate}
        onClear={clearFilters}
        onDownloadExcel={() => runExport('excel')}
        onDownloadPdf={() => runExport('pdf')}
        resultCount={filteredRows.length}
        isExporting={isExporting}
        fileNamePreview={fileNamePreview}
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

          {loadingRows ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : rowsError ? (
            <p className="text-destructive text-center py-8 text-sm font-medium">{rowsError}</p>
          ) : filteredRows.length === 0 ? (
            <p className="text-foreground/40 text-center py-8">
              {rows.length === 0
                ? `No ${definition.label.toLowerCase()} data found.`
                : 'No records match this filter.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
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
                  {filteredRows.map((row: any) => (
                    <tr key={row._id} className="hover:bg-surfaceHover transition-colors group">
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
                          <button
                            onClick={() => setSelectedEventId(row._id)}
                            className="bg-accent/10 text-accent hover:bg-accent/20 font-medium text-xs px-4 py-2 rounded transition-colors uppercase tracking-wider"
                          >
                            View
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Reports;
