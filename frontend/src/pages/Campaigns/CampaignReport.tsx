import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle, XCircle, Clock, Send, Users, TrendingUp, AlertTriangle, Printer, Download } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import api from '../../services/api';
import { Badge } from '../../components/ui/Badge';
import { getSerialNumber } from '../../utils/pagination';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { exportToExcel, buildReportFileName } from '../../utils/reportExport';
import {
  DELIVERY_LOG_COLUMNS,
  describeDeliveryLog,
  deliveryStamp,
  deliveryLogDate,
} from '../../utils/deliveryLogReport';
import { validateReportDateRange, withinRange } from '../../utils/reportSearch';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../store/authStore';
import { useSocket } from '../../contexts/SocketContext';

interface CampaignStats {
  campaignId: string;
  campaignStatus: string;
  eventName: string;
  messageContent?: string;
  total: number;
  breakdown: {
    Pending: number;
    Sent: number;
    Delivered: number;
    Failed: number;
  };
  /**
   * Milestone counts. `accepted` means WhatsApp took the message — not that
   * any handset received it. Delivery and read are only known once the
   * webhook reports them, which is why they are counted separately rather
   * than folded into one "sent" number.
   */
  summary: {
    total: number;
    pending: number;
    accepted: number;
    delivered: number;
    read: number;
    failed: number;
    awaitingConfirmation: number;
  };
  successRate: number;
  deliveryRate: number;
  hasDeliveryData: boolean;
}

interface LogEntry {
  _id: string;
  contactId: { fullName: string; phoneNumber: string } | null;
  contactName?: string;
  /** Present only on a proactive template send, which has no campaign. */
  templateName?: string;
  phoneNumber: string;
  status: string;
  errorCode?: number;
  errorReason?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  failedAt?: string;
  createdAt: string;
}

/**
 * What to actually show for one recipient.
 *
 * The stored `status` alone would be misleading: 'Sent' means "WhatsApp
 * accepted it", and a read message is stored as Delivered plus a readAt
 * timestamp. This resolves the milestones, newest first, into the single
 * honest label for that row.
 */
const describeLog = describeDeliveryLog;

/** Local time, or an em dash when the milestone has not happened. */
const stamp = deliveryStamp;

const STATUS_COLORS: Record<string, string> = {
  Sent: '#22c55e',
  Delivered: '#3b82f6',
  Failed: '#ef4444',
  Pending: '#f59e0b'
};

export const CampaignReportContent = ({ 
  campaignIdProp, 
  hideHeader = false,
  hideBackButton = false,
  showPrintButton = false,
  onBack
}: { 
  campaignIdProp?: string, 
  hideHeader?: boolean,
  hideBackButton?: boolean,
  showPrintButton?: boolean,
  onBack?: () => void
}) => {
  const { campaignId: paramCampaignId } = useParams<{ campaignId: string }>();
  const campaignId = campaignIdProp || paramCampaignId;
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user } = useAuth();
  
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState('All');
  // The Delivery Log is a report too, so it states the period it covers.
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateError, setDateError] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  /**
   * The rows inside the chosen period. withinRange is true when no range is
   * set, so the table reads exactly as before until dates are picked; the
   * downloads are what require them.
   */
  const visibleLogs = useMemo(
    () => logs.filter((log) => withinRange(deliveryLogDate(log), startDate, endDate)),
    [logs, startDate, endDate]
  );
  const [isLoading, setIsLoading] = useState(true);
  // The failure used to be swallowed into console.error, leaving only a bare
  // "Report data not available." on screen with no way to tell a permission
  // problem from a missing campaign.
  const [loadError, setLoadError] = useState<string | null>(null);

  // Authorization check
  const hasReportAccess = user?.role === 'SuperAdmin' || (user?.accessExpiryDate && new Date(user.accessExpiryDate) > new Date() && !user?.isAccessCancelled);

  const fetchReport = useCallback(async (isSilent = false) => {
    if (!campaignId) {
      setLoadError('No campaign has been sent for this event yet.');
      setIsLoading(false);
      return;
    }
    if (!isSilent) setIsLoading(true);
    try {
      const [statsRes, logsRes] = await Promise.all([
        api.get(`/reports/campaign/${campaignId}/stats`),
        api.get(`/reports/campaign/${campaignId}/logs`, { params: { status: statusFilter === 'All' ? undefined : statusFilter } })
      ]);
      setStats(statsRes.data);

      /**
       * Proactive template sends belong to the event rather than to this
       * campaign, so they come from their own endpoint and are shown in the
       * same table. Fetched after the campaign's own rows and merged by time —
       * if it fails, the campaign report still renders exactly as before.
       */
      const eventId = statsRes.data?.eventDetails?._id;
      let templateLogs: LogEntry[] = [];
      if (eventId) {
        try {
          const templateRes = await api.get(`/reports/event/${eventId}/template-logs`, {
            params: { status: statusFilter === 'All' ? undefined : statusFilter },
          });
          templateLogs = templateRes.data?.logs ?? [];
        } catch (templateError) {
          console.error('Failed to fetch template delivery rows', templateError);
        }
      }

      setLogs(
        [...logsRes.data.logs, ...templateLogs].sort(
          (a: LogEntry, b: LogEntry) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
      );
      setLoadError(null);
    } catch (error: any) {
      console.error('Failed to fetch report', error);
      const status = error?.response?.status;
      setLoadError(
        status === 403 ? 'You do not have access to this event\'s report.'
        : status === 404 ? 'This campaign no longer exists.'
        : error?.response?.data?.error || 'The report could not be loaded. Please try again.'
      );
    } finally {
      if (!isSilent) setIsLoading(false);
    }
  }, [campaignId, statusFilter]);

  useEffect(() => {
    if (!hasReportAccess) {
      showToast('error', 'You do not have permission to view reports. Please request access from the Super Admin.');
      navigate('/dashboard');
      return;
    }
    fetchReport();
  }, [fetchReport, hasReportAccess, navigate, showToast]);

  const { socket } = useSocket();
  useEffect(() => {
    if (!socket || !campaignId) return;

    const handleUpdate = (data: any) => {
      if (data.campaignId === campaignId) {
        fetchReport(true);
      }
    };

    socket.on('message-log-updated', handleUpdate);
    socket.on('campaign-status-changed', handleUpdate);

    return () => {
      socket.off('message-log-updated', handleUpdate);
      socket.off('campaign-status-changed', handleUpdate);
    };
  }, [socket, campaignId, fetchReport]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-8 text-center space-y-3">
        <AlertTriangle className="w-10 h-10 text-destructive/60 mx-auto" />
        <p className="text-destructive font-medium">{loadError || 'Report data not available.'}</p>
        <button
          onClick={() => fetchReport()}
          className="text-accent hover:text-accent/80 font-medium text-sm transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  const chartData = Object.entries(stats.breakdown)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({
      name: status,
      value: count,
      color: STATUS_COLORS[status]
    }));

  /**
   * The Delivery Log as an .xlsx, through the same writer the other reports
   * use — so it carries the period in its header, a filter on every column and
   * the standing notes, exactly as an Event or Contact Report does.
   */
  const handleDownloadExcel = async () => {
    const problem = validateReportDateRange(startDate, endDate);
    if (problem) {
      setDateError(problem);
      return;
    }
    setDateError('');
    if (visibleLogs.length === 0) return;

    setIsExporting(true);
    try {
      const name = buildReportFileName('DeliveryLog', 'Date');
      await exportToExcel(name, 'Delivery Log', DELIVERY_LOG_COLUMNS, visibleLogs, {
        searchValue: statusFilter === 'All' ? '' : statusFilter,
        startDate,
        endDate,
      });
    } catch (error) {
      console.error('Delivery Log export failed', error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadPDF = () => {
    // The PDF states the same period as the spreadsheet, so it is held to the
    // same rule rather than printing a report with no scope.
    const problem = validateReportDateRange(startDate, endDate);
    if (problem) {
      setDateError(problem);
      return;
    }
    setDateError('');
    if (!stats) return;

    const doc = new jsPDF();
    const eventName = stats.eventName || 'Unknown Event';
    
    // Add title
    doc.setFontSize(20);
    doc.text('Campaign Delivery Report', 14, 22);
    
    // Add Event Info
    doc.setFontSize(11);
    doc.setTextColor(100);
    doc.text(`Event Name: ${eventName}`, 14, 32);
    doc.text(`Status: ${stats.campaignStatus || 'Unknown'}`, 14, 38);
    // The period the log covers, so the document states its own scope.
    doc.text(`Start Date: ${startDate}`, 14, 44);
    doc.text(`End Date: ${endDate}`, 14, 50);

    // Add Message Content
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text('Message Content:', 14, 62);

    doc.setFontSize(10);
    doc.setTextColor(80);
    const messageLines = doc.splitTextToSize(stats.messageContent || 'N/A', 180);
    doc.text(messageLines, 14, 70);
    
    // Calculate Y position for the table based on message length
    const nextY = 70 + (messageLines.length * 5) + 10;
    
    // Create Table Data. Status is the resolved milestone, not the raw stored
    // value — "Sent" in the database means WhatsApp accepted the message, and
    // printing that as "Delivered" (as this once did) overstates what is known.
    const tableColumn = ["Contact Name", "Mobile Number", "Status", "Accepted", "Delivered", "Read", "Failure"];
    const tableRows = visibleLogs.map(log => [
      log.contactId?.fullName || log.contactName || 'Unknown',
      log.contactId?.phoneNumber || log.phoneNumber || 'Unknown',
      describeLog(log).label,
      stamp(log.sentAt),
      stamp(log.deliveredAt),
      stamp(log.readAt),
      log.status === 'Failed'
        ? `${log.errorCode ? `[${log.errorCode}] ` : ''}${log.errorReason || 'Unknown error'}`
        : '—',
    ]);

    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: nextY,
      theme: 'grid',
      styles: { fontSize: 9 },
      headStyles: { fillColor: [79, 70, 229] } // primary color
    });

    doc.save(`Campaign_Report_${eventName.replace(/\s+/g, '_')}.pdf`);
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
        {!hideHeader && (
          <div className="flex items-center justify-between mb-8 animate-fade-in">
            {/* Left: Buttons */}
            <div className="flex flex-col items-start space-y-3 w-1/3">
              {!hideBackButton && (
                <button
                  onClick={() => onBack ? onBack() : navigate(-1)}
                  className="text-foreground/50 hover:text-foreground text-sm font-medium flex items-center transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 mr-1" />
                  Back
                </button>
              )}
              
              <div className="flex flex-wrap items-end gap-3">
                {/* The period this log covers. Required before either download. */}
                <div className="flex flex-col">
                  <label htmlFor="log-start" className="text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1">
                    Start Date <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="log-start"
                    type="date"
                    value={startDate}
                    max={endDate || undefined}
                    required
                    aria-required="true"
                    onChange={(e) => {
                      setStartDate(e.target.value);
                      setDateError('');
                    }}
                    className="bg-surface border border-border text-foreground px-3 py-2 rounded-md text-sm focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div className="flex flex-col">
                  <label htmlFor="log-end" className="text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1">
                    End Date <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="log-end"
                    type="date"
                    value={endDate}
                    min={startDate || undefined}
                    required
                    aria-required="true"
                    onChange={(e) => {
                      setEndDate(e.target.value);
                      setDateError('');
                    }}
                    className="bg-surface border border-border text-foreground px-3 py-2 rounded-md text-sm focus:outline-none focus:border-accent transition-colors"
                  />
                </div>

                <button
                  onClick={handleDownloadExcel}
                  disabled={isExporting || Boolean(dateError) || !startDate || !endDate || visibleLogs.length === 0}
                  title={dateError || undefined}
                  className="inline-flex items-center px-4 py-2 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed rounded-md font-medium text-sm transition-colors border border-accent/20"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Excel
                </button>

                <button 
                  onClick={handleDownloadPDF}
                  disabled={Boolean(dateError) || !startDate || !endDate}
                  title={dateError || undefined}
                  className="inline-flex items-center px-4 py-2 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed rounded-md font-medium text-sm transition-colors border border-primary/20"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download Report
                </button>

                {dateError && (
                  <p role="alert" className="w-full text-xs font-semibold text-destructive">
                    {dateError}
                  </p>
                )}

                {showPrintButton && (
                  <button 
                    onClick={() => window.print()}
                    className="inline-flex items-center px-4 py-2 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 rounded-md font-medium text-sm transition-colors border border-emerald-500/20"
                  >
                    <Printer className="w-4 h-4 mr-2" />
                    Print Report
                  </button>
                )}
              </div>
            </div>
            
            {/* Center: Titles */}
            <div className="text-center w-1/3">
              <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Campaign Report</h2>
              <div className="mt-2 flex items-center justify-center space-x-3">
                <span className="text-primary font-medium tracking-wide">{stats.eventName}</span>
                <span className="text-foreground/30">•</span>
                <Badge variant={stats.campaignStatus === 'Completed' ? 'success' : 'warning'}>
                  {stats.campaignStatus}
                </Badge>
              </div>
            </div>

            {/* Right: Empty for balance */}
            <div className="w-1/3"></div>
          </div>
        )}

        {/* Message Content Card */}
        {stats.messageContent && (
          <div className="bg-surface rounded-xl border border-border p-6 animate-fade-up">
            <h3 className="text-sm font-sans font-medium text-foreground/50 uppercase tracking-wide mb-3 flex items-center">
              <Send className="w-4 h-4 mr-2" />
              Campaign Message
            </h3>
            <div className="bg-surfaceHover/50 rounded-lg p-4 border border-border/50 text-foreground/80 whitespace-pre-wrap font-sans text-sm">
              {stats.messageContent}
            </div>
          </div>
        )}

        {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up stagger-1">
        <div className="bg-surface rounded-xl border border-border p-5 group hover:border-accent/50 transition-colors">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-sans font-medium text-foreground/50 uppercase tracking-wide">Total Recipients</span>
            <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Users className="w-5 h-5 text-accent" />
            </div>
          </div>
          <p className="text-3xl font-sans font-bold text-foreground">{stats.total}</p>
        </div>

        <div className="bg-surface rounded-xl border border-border p-5 group hover:border-success/50 transition-colors">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-sans font-medium text-foreground/50 uppercase tracking-wide">Accepted by WhatsApp</span>
            <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <TrendingUp className="w-5 h-5 text-success" />
            </div>
          </div>
          <p className="text-3xl font-sans font-bold text-success">{stats.summary.accepted}</p>
          <div className="mt-2 w-full bg-surfaceHover rounded-full h-2">
            <div
              className="bg-success h-2 rounded-full transition-all duration-500"
              style={{ width: `${stats.successRate}%` }}
            ></div>
          </div>
          <p className="mt-2 text-xs text-foreground/40">{stats.successRate}% handed to WhatsApp</p>
        </div>

        <div className="bg-surface rounded-xl border border-border p-5 group hover:border-info/50 transition-colors">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-sans font-medium text-foreground/50 uppercase tracking-wide">Delivered / Read</span>
            <div className="w-10 h-10 rounded-full bg-info/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <CheckCircle className="w-5 h-5 text-info" />
            </div>
          </div>
          <p className="text-3xl font-sans font-bold text-info">
            {stats.summary.delivered}
            <span className="text-base text-foreground/40 font-medium"> / {stats.summary.read} read</span>
          </p>
          {!stats.hasDeliveryData && stats.summary.accepted > 0 && (
            <p className="mt-2 text-xs text-foreground/40">
              No delivery confirmations received yet — these arrive on the WhatsApp webhook.
            </p>
          )}
        </div>

        <div className="bg-surface rounded-xl border border-border p-5 group hover:border-destructive/50 transition-colors">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-sans font-medium text-foreground/50 uppercase tracking-wide">Failed</span>
            <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <XCircle className="w-5 h-5 text-destructive" />
            </div>
          </div>
          <p className="text-3xl font-sans font-bold text-destructive">{stats.breakdown.Failed}</p>
        </div>
      </div>

      {/* Chart + Filter */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-up stagger-2">
        {/* Pie Chart */}
        <div className="bg-surface rounded-xl border border-border p-6">
          <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider mb-4">Status Breakdown</h3>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={4}
                  dataKey="value"
                  stroke="none"
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    borderRadius: '8px',
                    border: '1px solid #ffffff20',
                    backgroundColor: '#111',
                    color: '#fff',
                    boxShadow: '0 4px 6px -1px rgba(0,0,0,.1)'
                  }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-64 flex items-center justify-center text-foreground/40">
              <p>No data yet</p>
            </div>
          )}
        </div>

        {/* Message Log Table */}
        <div className="lg:col-span-2 bg-surface rounded-xl border border-border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">Delivery Log</h3>
            <select
              className="rounded-md border border-border bg-surface/50 text-foreground px-3 py-1.5 text-sm focus:ring-2 focus:ring-white/20 outline-none transition-colors"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="All">All Statuses</option>
              <option value="Sent">Accepted by WhatsApp</option>
              <option value="Delivered">Delivered</option>
              <option value="Read">Read</option>
              <option value="Failed">Failed</option>
              <option value="Pending">Pending</option>
            </select>
          </div>

          <div className="table-scroll">
            <table className="w-full min-w-[1150px] text-sm">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-wide text-xs text-foreground/60">
                  <th className="pb-3 pr-4 font-semibold w-20 whitespace-nowrap">Sr No</th>
                  <th className="pb-3 font-semibold">Contact</th>
                  <th className="pb-3 font-semibold">Phone</th>
                  <th className="pb-3 font-semibold">Status</th>
                  <th className="pb-3 font-semibold whitespace-nowrap">Accepted</th>
                  <th className="pb-3 font-semibold whitespace-nowrap">Delivered</th>
                  <th className="pb-3 font-semibold whitespace-nowrap">Read</th>
                  <th className="pb-3 font-semibold whitespace-nowrap">Failed</th>
                  <th className="pb-3 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleLogs.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-foreground/40">
                      No message logs found.
                    </td>
                  </tr>
                ) : (
                  visibleLogs.map((log, index) => {
                    const state = describeLog(log);
                    return (
                      <tr key={log._id} className="hover:bg-surfaceHover transition-colors">
                        {/* The report loads only the first page of logs, so this is page 1. */}
                        <td className="py-3 pr-4 text-foreground/50 tabular-nums whitespace-nowrap">{getSerialNumber(1, visibleLogs.length, index)}</td>
                        <td className="py-3 font-medium text-foreground whitespace-nowrap">
                          {log.contactId?.fullName || log.contactName || 'Unknown'}
                          {log.templateName && (
                            <span className="ml-2 text-[10px] uppercase tracking-wider text-foreground/40">
                              {log.templateName}
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-foreground/80 font-mono text-xs whitespace-nowrap">
                          {log.contactId?.phoneNumber || log.phoneNumber}
                        </td>
                        <td className="py-3 whitespace-nowrap">
                          <Badge variant={state.variant}>{state.label}</Badge>
                        </td>
                        <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{stamp(log.sentAt)}</td>
                        <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{stamp(log.deliveredAt)}</td>
                        <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{stamp(log.readAt)}</td>
                        <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{stamp(log.failedAt)}</td>
                        <td className="py-3 text-foreground/50 text-xs max-w-[220px] truncate" title={log.errorReason}>
                          {log.status === 'Failed' ? (
                            <span className="flex items-center text-destructive">
                              <AlertTriangle className="w-3 h-3 mr-1 flex-shrink-0" />
                              {log.errorCode ? `[${log.errorCode}] ` : ''}{log.errorReason || 'Unknown error'}
                            </span>
                          ) : log.readAt ? (
                            <span className="flex items-center text-success">
                              <CheckCircle className="w-3 h-3 mr-1" /> Opened by recipient
                            </span>
                          ) : log.deliveredAt ? (
                            <span className="flex items-center text-info">
                              <CheckCircle className="w-3 h-3 mr-1" /> Delivered to device
                            </span>
                          ) : log.status === 'Sent' ? (
                            <span className="flex items-center text-info">
                              <Send className="w-3 h-3 mr-1" /> Accepted by WhatsApp
                            </span>
                          ) : (
                            <span className="flex items-center text-amber-500">
                              <Clock className="w-3 h-3 mr-1" /> Waiting to be processed
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

const CampaignReport = () => {
  return <CampaignReportContent />;
};

export default CampaignReport;
