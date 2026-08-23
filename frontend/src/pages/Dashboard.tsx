import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../store/authStore';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer,
  LineChart, Line,
} from 'recharts';
import {
  CalendarDays, Users, Megaphone, Send,
  CheckCircle2, XCircle, Clock, Search, X,
} from 'lucide-react';
import api from '../services/api';
import type { Event, Campaign, EventStatus } from '@eventreach/shared';

interface DashboardStats {
  totalEvents: number;
  totalContacts: number;
  totalCampaigns: number;
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  messagesPending: number;
}

const STATUS_OPTIONS: { label: string; value: '' | EventStatus }[] = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'Draft' },
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
  // FILTER 1 - independent dropdown
  const [statusFilter, setStatusFilter] = useState<'' | EventStatus>('');
  // FILTER 2 - independent search
  const [searchQuery, setSearchQuery] = useState('');
  const { user } = useAuth();

  useEffect(() => {
    const fetchAll = async () => {
      setIsLoading(true);
      try {
        const query = statusFilter ? ('?status=' + statusFilter) : '';
        const [statsRes, activityRes, eventsRes] = await Promise.all([
          api.get('/dashboard/stats' + query),
          api.get('/dashboard/activity' + query),
          api.get('/events'),
        ]);
        setStats(statsRes.data);
        setChartData(activityRes.data.chartData || []);
        setRecentCampaigns(activityRes.data.recentCampaigns || []);
        setEvents(eventsRes.data);
      } catch (error) {
        console.error('Failed to fetch dashboard data', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchAll();
  }, [statusFilter]);

  const searchedEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.type?.toLowerCase().includes(q) ||
        e.organizerName?.toLowerCase().includes(q) ||
        e.venue?.toLowerCase().includes(q)
    );
  }, [events, searchQuery]);

  if (isLoading) {
    return (
      <div className='space-y-6'>
        <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6'>
          {[...Array(7)].map((_, i) => (
            <div key={i} className='glass-panel rounded-2xl p-6 animate-pulse'>
              <div className='flex items-center'>
                <div className='w-12 h-12 rounded-full bg-white/10 dark:bg-black/10 mr-4' />
                <div className='space-y-2 flex-1'>
                  <div className='h-3 bg-white/10 dark:bg-black/10 rounded w-24' />
                  <div className='h-6 bg-white/10 dark:bg-black/10 rounded w-16' />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className='grid grid-cols-1 lg:grid-cols-2 gap-6'>
          {[0, 1].map((i) => (
            <div key={i} className='glass-panel rounded-2xl p-6 h-80 animate-pulse'>
              <div className='h-4 bg-white/10 dark:bg-black/10 rounded w-48 mb-4' />
              <div className='h-64 bg-white/10 dark:bg-black/10 rounded' />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const statCards = [
    { label: 'Total Events',     value: stats.totalEvents,       icon: CalendarDays,  color: 'text-blue-500 dark:text-blue-400',      bg: 'bg-blue-500/10' },
    { label: 'Total Contacts',   value: stats.totalContacts,     icon: Users,         color: 'text-indigo-500 dark:text-indigo-400',   bg: 'bg-indigo-500/10' },
    { label: 'Active Campaigns', value: stats.totalCampaigns,    icon: Megaphone,     color: 'text-purple-500 dark:text-purple-400',   bg: 'bg-purple-500/10' },
    { label: 'Messages Sent',    value: stats.messagesSent,      icon: Send,          color: 'text-sky-500 dark:text-sky-400',         bg: 'bg-sky-500/10' },
    { label: 'Delivered',        value: stats.messagesDelivered, icon: CheckCircle2,  color: 'text-emerald-500 dark:text-emerald-400', bg: 'bg-emerald-500/10' },
    { label: 'Failed',           value: stats.messagesFailed,    icon: XCircle,       color: 'text-rose-500 dark:text-rose-400',       bg: 'bg-rose-500/10' },
    { label: 'Pending',          value: stats.messagesPending,   icon: Clock,         color: 'text-amber-500 dark:text-amber-400',     bg: 'bg-amber-500/10' },
  ];

  const isSuperAdmin = user?.role === 'SuperAdmin';

  return (
    <div className='space-y-6'>
      <div className='flex flex-col sm:flex-row sm:items-end justify-between gap-4'>
        <h2 className='text-3xl font-sans font-bold text-foreground animate-slide-in uppercase shrink-0'>Dashboard Overview</h2>
        {isSuperAdmin && (
          <div className='flex flex-col sm:flex-row items-start sm:items-end gap-3'>
            <div className='flex flex-col'>
              <label className='text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1'>Filter by Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as ('' | EventStatus))}
                className='bg-surface border border-border text-foreground px-4 py-2 rounded-md focus:outline-none focus:border-accent transition-colors font-medium text-sm min-w-[160px] cursor-pointer'
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className='flex flex-col'>
              <label className='text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1'>Search Events</label>
              <div className='relative'>
                <Search className='absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40 pointer-events-none' />
                <input
                  type='text'
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder='Name, type, venue...'
                  className='bg-surface border border-border text-foreground pl-9 pr-8 py-2 rounded-md focus:outline-none focus:border-accent transition-colors text-sm w-[220px] placeholder:text-foreground/30'
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className='absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground transition-colors'>
                    <X className='w-3.5 h-3.5' />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6'>
        {statCards.map((stat, idx) => (
          <div key={idx} className={'glass-panel rounded-2xl p-6 flex items-center hover:-translate-y-1 hover:shadow-glass-lg hover:border-accent/30 transition-all duration-300 animate-spring-up stagger-' + ((idx % 5) + 1)}>
            <div className={'w-12 h-12 rounded-full flex items-center justify-center ' + stat.bg + ' ' + stat.color + ' mr-4 backdrop-blur-md'}>
              <stat.icon className='w-6 h-6' />
            </div>
            <div>
              <p className='text-sm font-medium text-foreground/60'>{stat.label}</p>
              <h3 className='text-2xl font-bold text-foreground mt-1'>{stat.value}</h3>
            </div>
          </div>
        ))}
      </div>

      <div className='grid grid-cols-1 lg:grid-cols-2 gap-6'>
        <div className='glass-panel rounded-2xl p-6 animate-spring-up stagger-4'>
          <h3 className='text-lg font-sans font-bold text-foreground mb-4 uppercase tracking-wider'>Messages Sent vs Delivered</h3>
          <div className='h-72'>
            {chartData.length > 0 ? (
              <ResponsiveContainer width='100%' height='100%'>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray='3 3' vertical={false} stroke='rgba(148,163,184,0.2)' />
                  <XAxis dataKey='name' axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <RechartsTooltip cursor={{ fill: 'rgba(148,163,184,0.1)' }} contentStyle={{ borderRadius: '1rem', border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(15,23,42,0.8)', backdropFilter: 'blur(12px)', color: '#F8FAFC' }} />
                  <Bar dataKey='sent' fill='#3B82F6' radius={[4, 4, 0, 0]} name='Sent' />
                  <Bar dataKey='delivered' fill='#22C55E' radius={[4, 4, 0, 0]} name='Delivered' />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className='h-full flex items-center justify-center text-foreground/40 font-medium'>
                <p>No message activity yet. Send your first campaign!</p>
              </div>
            )}
          </div>
        </div>
        <div className='glass-panel rounded-2xl p-6 animate-spring-up stagger-5'>
          <h3 className='text-lg font-sans font-bold text-foreground mb-4 uppercase tracking-wider'>Delivery Rate Trend</h3>
          <div className='h-72'>
            {chartData.length > 0 ? (
              <ResponsiveContainer width='100%' height='100%'>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray='3 3' vertical={false} stroke='rgba(148,163,184,0.2)' />
                  <XAxis dataKey='name' axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <RechartsTooltip contentStyle={{ borderRadius: '1rem', border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(15,23,42,0.8)', backdropFilter: 'blur(12px)', color: '#F8FAFC' }} />
                  <Line type='monotone' dataKey='delivered' stroke='#22C55E' strokeWidth={3} dot={{ strokeWidth: 2, r: 4 }} activeDot={{ r: 6 }} name='Delivered' />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className='h-full flex items-center justify-center text-foreground/40 font-medium'>
                <p>Trend data will appear after campaigns are sent.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {isSuperAdmin && (
        <div className='glass-panel rounded-2xl overflow-hidden animate-spring-up stagger-5'>
          <div className='px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-2'>
            <h3 className='text-sm font-sans font-bold text-foreground uppercase tracking-wider'>
              Events
              {searchQuery && (
                <span className='ml-2 text-accent font-normal text-sm normal-case'>
                  {'— ' + searchedEvents.length + ' result' + (searchedEvents.length !== 1 ? 's' : '') + ' for ' + JSON.stringify(searchQuery)}
                </span>
              )}
            </h3>
            {searchQuery && (<span className='text-xs text-foreground/40 italic'>Independent of Status filter</span>)}
          </div>
          {searchedEvents.length === 0 ? (
            <div className='p-10 text-center text-foreground/40'>
              <Search className='w-8 h-8 mx-auto mb-3 opacity-30' />
              <p className='font-medium'>{'No events match ' + JSON.stringify(searchQuery)}</p>
            </div>
          ) : (
            <div className='overflow-x-auto'>
              <table className='w-full text-left border-collapse'>
                <thead>
                  <tr className='bg-surfaceHover text-foreground/60 font-medium border-b border-border uppercase tracking-wide text-xs'>
                    <th className='py-3 px-4'>Event Name</th>
                    <th className='py-3 px-4'>Type</th>
                    <th className='py-3 px-4'>Organizer</th>
                    <th className='py-3 px-4'>Date</th>
                    <th className='py-3 px-4'>Venue</th>
                    <th className='py-3 px-4'>Status</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-border'>
                  {searchedEvents.map((event, idx) => (
                    <tr key={event._id} className={'hover:bg-surfaceHover transition-colors animate-fade-up stagger-' + ((idx % 5) + 1)}>
                      <td className='py-3 px-4 font-medium text-foreground'>{event.name}</td>
                      <td className='py-3 px-4 text-sm text-foreground/70'>{event.type}</td>
                      <td className='py-3 px-4 text-sm text-foreground/70'>{event.organizerName}</td>
                      <td className='py-3 px-4 text-sm text-foreground/70 whitespace-nowrap'>{event.date}</td>
                      <td className='py-3 px-4 text-sm text-foreground/70'>{event.venue}</td>
                      <td className='py-3 px-4'>
                        <span className={'text-xs font-semibold px-2 py-0.5 rounded-full ' + (event.status === 'Upcoming' ? 'bg-blue-500/10 text-blue-500' : event.status === 'Completed' ? 'bg-emerald-500/10 text-emerald-500' : event.status === 'Cancelled' ? 'bg-rose-500/10 text-rose-500' : 'bg-foreground/10 text-foreground/50')}>
                          {event.status}
                        </span>
                      </td>
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

export default Dashboard;
