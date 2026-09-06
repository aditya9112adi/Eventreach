import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store/authStore';
import { useSocket } from '../contexts/SocketContext';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
  LineChart, Line,
} from 'recharts';
import {
  CalendarDays, Users, Megaphone, Send,
  CheckCircle2, XCircle, Clock, LineChart as LineChartIcon, Inbox,
} from 'lucide-react';
import api from '../services/api';
import type { Event, Campaign, EventStatus } from '@eventreach/shared';
import { EventSearch } from '../components/ui/EventSearch';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { StatCard, type StatTone } from '../components/ui/StatCard';
import { SkeletonStats, SkeletonCard } from '../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Select } from '../components/ui/Select';
import { PageHeader } from '../components/ui/PageHeader';
import { useTheme } from '../store/themeStore';
import { formatDateTime } from '../utils/datetime';

interface DashboardStats {
  totalEvents: number;
  totalContacts: number;
  totalCampaigns: number;
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  messagesPending: number;
}

/** Entrance delays for the stat row, written out so Tailwind keeps them. */
const STAGGER = ['stagger-1', 'stagger-2', 'stagger-3', 'stagger-4', 'stagger-5'];

const STATUS_OPTIONS: { label: string; value: '' | EventStatus }[] = [
  { label: 'All', value: '' },
  { label: 'Upcoming', value: 'Upcoming' },
  { label: 'Completed', value: 'Completed' },
  { label: 'Cancelled', value: 'Cancelled' },
];

const Dashboard = () => {
  const [stats, setStats] = useState<DashboardStats>({
    totalEvents: 0, totalContacts: 0, totalCampaigns: 0,
    messagesSent: 0, messagesDelivered: 0, messagesFailed: 0, messagesPending: 0,
  });
  const [chartData, setChartData] = useState<any[]>([]);
  const [recentCampaigns, setRecentCampaigns] = useState<Campaign[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // FILTER 1 — Status dropdown (re-fetches stats from API)
  const [statusFilter, setStatusFilter] = useState<'' | EventStatus>('');

  // FILTER 2 — Event search via EventSearch dropdown
  const [selectedEventId, setSelectedEventId] = useState<string>('');

  const { user } = useAuth();
  const { theme } = useTheme();

  const selectedEvent = events.find(e => e._id === selectedEventId) || null;

  const { socket } = useSocket();

  // Fetch when status filter OR selected event changes
  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    try {
      let query = '';
      if (selectedEventId) {
        query = '?eventId=' + selectedEventId;
      } else if (statusFilter) {
        query = '?status=' + statusFilter;
      }
      const [statsRes, activityRes, eventsRes] = await Promise.all([
        api.get('/dashboard/stats' + query),
        api.get('/dashboard/activity' + query),
        api.get('/events'),
      ]);
      setStats(statsRes.data);
      setChartData(activityRes.data.chartData || []);
      setRecentCampaigns(activityRes.data.recentCampaigns || []);
      setEvents(eventsRes.data);
      setLoadError(false);
    } catch (error) {
      console.error('Failed to fetch dashboard data', error);
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, selectedEventId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Real-time socket listener to re-fetch on assignment or status changes
  useEffect(() => {
    if (!socket) return;
    const handleUpdate = () => {
      fetchAll();
    };
    socket.on('dashboard-updated', handleUpdate);
    socket.on('EVENT_ASSIGNMENT_CHANGED', handleUpdate);
    socket.on('event-status-changed', handleUpdate);

    return () => {
      socket.off('dashboard-updated', handleUpdate);
      socket.off('EVENT_ASSIGNMENT_CHANGED', handleUpdate);
      socket.off('event-status-changed', handleUpdate);
    };
  }, [socket, fetchAll]);

  const isSuperAdminOrAdmin = user?.role === 'SuperAdmin' || user?.role === 'Admin';

  // Charts read their colours from the active theme rather than hard-coded
  // slate values, which were unreadable on the light background.
  const isDark = theme === 'dark';
  const chartColors = {
    axis: isDark ? '#94A3B8' : '#6B7280',
    grid: isDark ? 'rgba(148,163,184,0.16)' : 'rgba(17,24,39,0.08)',
    sent: isDark ? '#818CF8' : '#4F46E5',
    delivered: isDark ? '#34D399' : '#059669',
    tooltipBg: isDark ? '#131926' : '#FFFFFF',
    tooltipBorder: isDark ? '#232B3B' : '#E5E7EB',
    tooltipText: isDark ? '#E9EDF5' : '#111827',
  };

  const tooltipStyle = {
    borderRadius: '0.5rem',
    border: `1px solid ${chartColors.tooltipBorder}`,
    backgroundColor: chartColors.tooltipBg,
    color: chartColors.tooltipText,
    fontSize: '0.8125rem',
    boxShadow: '0 4px 8px -2px rgba(0,0,0,0.08), 0 12px 20px -4px rgba(0,0,0,0.08)',
  };

  const filterControls = isSuperAdminOrAdmin ? (
    <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-end">
      <div className="sm:w-44">
        <Select
          label="Event status"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as '' | EventStatus);
            setSelectedEventId('');
          }}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
      </div>

      <div className="sm:w-64">
        <label className="mb-1.5 block text-sm font-medium text-foreground">Event</label>
        <EventSearch
          events={events}
          value={selectedEventId}
          onChange={(id) => { setSelectedEventId(id); setStatusFilter(''); }}
          placeholder="Search events…"
          allowClear={true}
        />
      </div>
    </div>
  ) : null;

  const subtitle = isSuperAdminOrAdmin
    ? selectedEvent
      ? `Showing ${selectedEvent.eventName}`
      : statusFilter
        ? `Showing ${statusFilter.toLowerCase()} events`
        : 'Across all of your events'
    : `Assigned event: ${events[0]?.eventName || user?.assignedEventName || 'none yet'}`;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" description={subtitle} />
        <SkeletonStats count={4} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={6} />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" />
        <Card flush>
          <ErrorState
            message="We couldn't load your dashboard data. Check your connection and try again."
            onRetry={fetchAll}
          />
        </Card>
      </div>
    );
  }

  const statCards: Array<{ label: string; value: number; icon: any; tone: StatTone }> = [
    ...(selectedEventId
      ? []
      : [{ label: 'Total events', value: stats.totalEvents, icon: CalendarDays, tone: 'info' as StatTone }]),
    { label: 'Total contacts', value: stats.totalContacts, icon: Users, tone: 'primary' },
    { label: 'Active campaigns', value: stats.totalCampaigns, icon: Megaphone, tone: 'primary' },
    { label: 'Messages sent', value: stats.messagesSent, icon: Send, tone: 'info' },
    { label: 'Delivered', value: stats.messagesDelivered, icon: CheckCircle2, tone: 'success' },
    { label: 'Failed', value: stats.messagesFailed, icon: XCircle, tone: 'error' },
    { label: 'Pending', value: stats.messagesPending, icon: Clock, tone: 'warning' },
  ];

  const hasActivity = chartData.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description={subtitle} actions={filterControls} />

      {/* Stat tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((stat, index) => (
          <div
            key={stat.label}
            // Literal classes: Tailwind cannot see dynamically built names.
            className={`animate-fade-up ${STAGGER[Math.min(index, STAGGER.length - 1)]}`}
          >
            <StatCard label={stat.label} value={stat.value} icon={stat.icon} tone={stat.tone} />
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card flush>
          <CardHeader title="Sent vs delivered" description="Message volume over recent activity" />
          <div className="h-72 p-5 pt-4">
            {hasActivity ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartColors.grid} />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: chartColors.axis, fontSize: 12 }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: chartColors.axis, fontSize: 12 }} allowDecimals={false} />
                  <RechartsTooltip cursor={{ fill: chartColors.grid }} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '0.75rem', color: chartColors.axis }} />
                  <Bar dataKey="sent" fill={chartColors.sent} radius={[4, 4, 0, 0]} name="Sent" maxBarSize={36} />
                  <Bar dataKey="delivered" fill={chartColors.delivered} radius={[4, 4, 0, 0]} name="Delivered" maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                icon={Send}
                title="No message activity yet"
                description="Send your first campaign and delivery metrics will appear here."
                className="h-full"
              />
            )}
          </div>
        </Card>

        <Card flush>
          <CardHeader title="Delivery trend" description="Delivered messages over time" />
          <div className="h-72 p-5 pt-4">
            {hasActivity ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartColors.grid} />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: chartColors.axis, fontSize: 12 }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: chartColors.axis, fontSize: 12 }} allowDecimals={false} />
                  <RechartsTooltip contentStyle={tooltipStyle} />
                  <Line
                    type="monotone"
                    dataKey="delivered"
                    stroke={chartColors.delivered}
                    strokeWidth={2.5}
                    dot={{ strokeWidth: 2, r: 3 }}
                    activeDot={{ r: 5 }}
                    name="Delivered"
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                icon={LineChartIcon}
                title="Nothing to trend yet"
                description="Trend data appears once your campaigns go live and start delivering."
                className="h-full"
              />
            )}
          </div>
        </Card>
      </div>

      {/* Recent campaigns — this data was already fetched but never shown. */}
      <Card flush>
        <CardHeader
          title="Recent campaigns"
          description="Your most recently created message campaigns"
          actions={
            <Link to="/campaigns">
              <Button variant="secondary" size="sm">New campaign</Button>
            </Link>
          }
        />
        {recentCampaigns.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No campaigns yet"
            description="Compose a message for one of your events to get started."
          />
        ) : (
          <ul className="divide-y divide-border">
            {recentCampaigns.slice(0, 5).map((campaign) => {
              const eventName =
                typeof campaign.eventId === 'object' && campaign.eventId
                  ? campaign.eventId.eventName
                  : 'Event';
              return (
                <li key={campaign._id}>
                  <Link
                    to={`/campaigns/${campaign._id}/report`}
                    className="flex items-center gap-4 px-5 py-3.5 transition-colors duration-micro hover:bg-surfaceHover"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{eventName}</p>
                      <p className="truncate text-xs text-muted">{campaign.messageText}</p>
                    </div>
                    <span className="hidden shrink-0 text-xs text-muted sm:block">
                      {formatDateTime(campaign.createdAt)}
                    </span>
                    <StatusBadge status={campaign.status} size="sm" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
};

export default Dashboard;
