import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle, XCircle, Clock, Send, Users, TrendingUp, AlertTriangle, Printer, Download } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import api from '../../services/api';
import { Badge } from '../../components/ui/Badge';
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
  successRate: number;
}

interface LogEntry {
  _id: string;
  contactId: { fullName: string; phoneNumber: string } | null;
  phoneNumber: string;
  status: string;
  errorReason?: string;
  createdAt: string;
}

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
  const [isLoading, setIsLoading] = useState(true);

  // Authorization check
  const hasReportAccess = user?.role === 'SuperAdmin' || (user?.accessExpiryDate && new Date(user.accessExpiryDate) > new Date() && !user?.isAccessCancelled);

  const fetchReport = useCallback(async (isSilent = false) => {
    if (!campaignId) return;
    if (!isSilent) setIsLoading(true);
    try {
      const [statsRes, logsRes] = await Promise.all([
        api.get(`/reports/campaign/${campaignId}/stats`),
        api.get(`/reports/campaign/${campaignId}/logs`, { params: { status: statusFilter === 'All' ? undefined : statusFilter } })
      ]);
      setStats(statsRes.data);
      setLogs(logsRes.data.logs);
    } catch (error) {
      console.error('Failed to fetch report', error);
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
    return <div className="p-8 text-center text-destructive">Report data not available.</div>;
  }

  const chartData = Object.entries(stats.breakdown)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({
      name: status,
      value: count,
      color: STATUS_COLORS[status]
    }));

  const statusBadgeVariant = (status: string): 'success' | 'error' | 'warning' | 'info' => {
    switch (status) {
      case 'Sent': return 'success';
      case 'Delivered': return 'info';
      case 'Failed': return 'error';
      case 'Pending': return 'warning';
      default: return 'info';
    }
  };

  const handleDownloadCSV = () => {
    if (!stats) return;

    const escapeCsv = (str: string) => {
      if (!str) return '""';
      const clean = String(str).replace(/"/g, '""');
      return `"${clean}"`;
    };

    let csvContent = `Event Name,${escapeCsv(stats.eventName || 'Unknown')}\n`;
    csvContent += `Event Status,${escapeCsv(stats.campaignStatus || 'Unknown')}\n`;
    csvContent += `Message Content,${escapeCsv(stats.messageContent || 'N/A')}\n`;
    csvContent += `\n--- LEADERBOARD / DELIVERY LOG ---\n`;
    csvContent += `Contact Name,Mobile Number,Status,Details\n`;

    logs.forEach(log => {
      const name = log.contactId?.fullName || 'Unknown';
      const phone = log.contactId?.phoneNumber || log.phoneNumber || 'Unknown';
      const status = log.status;
      const details = log.errorReason || (status === 'Pending' ? 'Queued' : 'Delivered');
      csvContent += `${escapeCsv(name)},${escapeCsv(phone)},${escapeCsv(status)},${escapeCsv(details)}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `Campaign_Report_${stats.eventName?.replace(/\s+/g, '_') || 'Export'}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
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
              
              <div className="flex items-center space-x-3">
                <button 
                  onClick={handleDownloadCSV}
                  className="inline-flex items-center px-4 py-2 bg-primary/10 text-primary hover:bg-primary/20 rounded-md font-medium text-sm transition-colors border border-primary/20"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download Report
                </button>

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
            <span className="text-sm font-sans font-medium text-foreground/50 uppercase tracking-wide">Success Rate</span>
            <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <TrendingUp className="w-5 h-5 text-success" />
            </div>
          </div>
          <p className="text-3xl font-sans font-bold text-success">{stats.successRate}%</p>
          <div className="mt-2 w-full bg-surfaceHover rounded-full h-2">
            <div
              className="bg-success h-2 rounded-full transition-all duration-500"
              style={{ width: `${stats.successRate}%` }}
            ></div>
          </div>
        </div>

        <div className="bg-surface rounded-xl border border-border p-5 group hover:border-info/50 transition-colors">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-sans font-medium text-foreground/50 uppercase tracking-wide">Sent / Delivered</span>
            <div className="w-10 h-10 rounded-full bg-info/10 flex items-center justify-center group-hover:scale-110 transition-transform">
              <CheckCircle className="w-5 h-5 text-info" />
            </div>
          </div>
          <p className="text-3xl font-sans font-bold text-info">{stats.breakdown.Sent + stats.breakdown.Delivered}</p>
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
              <option value="Sent">Sent</option>
              <option value="Delivered">Delivered</option>
              <option value="Failed">Failed</option>
              <option value="Pending">Pending</option>
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-wide text-xs text-foreground/60">
                  <th className="pb-3 font-semibold">Contact</th>
                  <th className="pb-3 font-semibold">Phone</th>
                  <th className="pb-3 font-semibold">Status</th>
                  <th className="pb-3 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-foreground/40">
                      No message logs found.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log._id} className="hover:bg-surfaceHover transition-colors">
                      <td className="py-3 font-medium text-foreground">
                        {log.contactId?.fullName || 'Unknown'}
                      </td>
                      <td className="py-3 text-foreground/80 font-mono text-xs">
                        {log.contactId?.phoneNumber || log.phoneNumber}
                      </td>
                      <td className="py-3">
                        <Badge variant={statusBadgeVariant(log.status)}>{log.status}</Badge>
                      </td>
                      <td className="py-3 text-foreground/50 text-xs max-w-[200px] truncate" title={log.errorReason}>
                        {log.status === 'Failed' ? (
                          <span className="flex items-center text-destructive">
                            <AlertTriangle className="w-3 h-3 mr-1 flex-shrink-0" />
                            {log.errorReason || 'Unknown error'}
                          </span>
                        ) : log.status === 'Pending' ? (
                          <span className="flex items-center text-amber-500">
                            <Clock className="w-3 h-3 mr-1" /> Queued
                          </span>
                        ) : (
                          <span className="flex items-center text-success">
                            <Send className="w-3 h-3 mr-1" /> Delivered
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
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
