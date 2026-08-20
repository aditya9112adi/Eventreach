import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle, XCircle, Clock, Send, Users, TrendingUp, AlertTriangle } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import api from '../../services/api';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../store/authStore';

interface CampaignStats {
  campaignId: string;
  campaignStatus: string;
  eventName: string;
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

const CampaignReport = () => {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user } = useAuth();
  
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState('All');
  const [isLoading, setIsLoading] = useState(true);

  // Authorization check
  const hasReportAccess = user?.role === 'SuperAdmin' || (user?.reportAccessExpiry && new Date(user.reportAccessExpiry) > new Date());

  useEffect(() => {
    if (!hasReportAccess) {
      showToast('error', 'You do not have permission to view reports. Please request access from the Super Admin.');
      navigate('/dashboard');
      return;
    }

    const fetchReport = async () => {
      if (!campaignId) return;
      setIsLoading(true);
      try {
        const [statsRes, logsRes] = await Promise.all([
          api.get(`/reports/campaign/${campaignId}/stats`),
          api.get(`/reports/campaign/${campaignId}/logs`)
        ]);
        setStats(statsRes.data);
        setLogs(logsRes.data.logs);
      } catch (error) {
        console.error('Failed to fetch report', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchReport();
  }, [campaignId]);

  useEffect(() => {
    const fetchFilteredLogs = async () => {
      if (!campaignId) return;
      try {
        const logsRes = await api.get(`/reports/campaign/${campaignId}/logs`, {
          params: { status: statusFilter }
        });
        setLogs(logsRes.data.logs);
      } catch (error) {
        console.error('Failed to fetch filtered logs', error);
      }
    };
    if (!isLoading) {
      fetchFilteredLogs();
    }
  }, [statusFilter, campaignId, isLoading]);

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

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-2 animate-fade-in">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate(-1)}
            className="p-2 text-foreground/50 hover:text-foreground hover:bg-surfaceHover rounded-full transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <button 
            onClick={() => window.print()}
            className="inline-flex items-center px-4 py-2 bg-accent/10 text-accent hover:bg-accent/20 rounded-md font-medium text-sm transition-colors"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print Report
          </button>
          <div>
            <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Campaign Report</h2>
            <p className="text-foreground/50 text-sm">{stats.eventName}</p>
          </div>
        </div>
        <Badge variant={stats.campaignStatus === 'Completed' ? 'success' : 'warning'}>
          {stats.campaignStatus}
        </Badge>
      </div>

      {/* KPI Cards */}
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

export default CampaignReport;
