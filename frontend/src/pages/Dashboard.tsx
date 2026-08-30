import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store/authStore';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer,
  LineChart, Line,
} from 'recharts';
import {
  CalendarDays, Users, Megaphone, Send,
  CheckCircle2, XCircle, Clock,
} from 'lucide-react';
import api from '../services/api';
import type { Event, Campaign, EventStatus } from '@eventreach/shared';
import { EventSearch } from '../components/ui/EventSearch';
import { Button } from '../components/ui/Button';

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

  // FILTER 1 — Status dropdown (re-fetches stats from API)
  const [statusFilter, setStatusFilter] = useState<'' | EventStatus>('');

  // FILTER 2 — Event search via EventSearch dropdown
  const [selectedEventId, setSelectedEventId] = useState<string>('');

  const { user } = useAuth();

  const selectedEvent = events.find(e => e._id === selectedEventId) || null;

  // Fetch when status filter OR selected event changes
  useEffect(() => {
    const fetchAll = async () => {
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
      } catch (error) {
        console.error('Failed to fetch dashboard data', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchAll();
  }, [statusFilter, selectedEventId]);

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
    ...(selectedEventId ? [] : [{ label: 'Total Events',     value: stats.totalEvents,       icon: CalendarDays,  color: 'text-blue-500 dark:text-blue-400',      bg: 'bg-blue-500/10' }]),
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

      {/* Header row with both independent filters */}
      <div className='flex flex-col sm:flex-row sm:items-end justify-between gap-4'>
        <div>
          <h2 className='text-3xl font-sans font-bold text-foreground animate-slide-in uppercase'>Dashboard Overview</h2>
          {/* Active filter indicator */}
          {isSuperAdmin && (selectedEvent || statusFilter) && (
            <p className='text-xs text-foreground/50 mt-1 flex items-center gap-1'>
              Showing:
              {selectedEvent && <span className='text-accent font-semibold'>{selectedEvent.eventName}</span>}
              {!selectedEvent && statusFilter && <span className='text-accent font-semibold'>{statusFilter} events</span>}
            </p>
          )}
        </div>

        {isSuperAdmin && (
          <div className='flex flex-col sm:flex-row items-start sm:items-end gap-3 relative z-50'>

            {/* FILTER 1: Status Dropdown — independent, re-fetches stats */}
            <div className='flex flex-col'>
              <label className='text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1'>Select Event Status</label>
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value as ('' | EventStatus)); setSelectedEventId(''); }}
                className='bg-surface border border-border text-foreground px-4 py-2 rounded-md focus:outline-none focus:border-accent transition-colors font-medium text-sm min-w-[160px] cursor-pointer'
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* FILTER 2: Event Search dropdown — selects a specific event */}
            <div className='flex flex-col w-[260px]'>
              <label className='text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1'>Select Event Name</label>
              <EventSearch
                events={events}
                value={selectedEventId}
                onChange={(id) => { setSelectedEventId(id); setStatusFilter(''); }}
                placeholder='Search events...'
                allowClear={true}
              />
            </div>

          </div>
        )}
      </div>

      {/* Stat Cards */}
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

      {/* Charts */}
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
              <div className='h-full relative overflow-hidden rounded-xl border border-border/30 bg-surface/10 flex items-center justify-center group'>
                {/* Skeleton Background */}
                <div className='absolute inset-0 flex items-end justify-around p-4 opacity-10 pointer-events-none'>
                  <div className='w-8 h-[30%] bg-blue-500 rounded-t-sm'></div>
                  <div className='w-8 h-[70%] bg-blue-500 rounded-t-sm'></div>
                  <div className='w-8 h-[40%] bg-blue-500 rounded-t-sm'></div>
                  <div className='w-8 h-[90%] bg-blue-500 rounded-t-sm'></div>
                  <div className='w-8 h-[60%] bg-blue-500 rounded-t-sm'></div>
                </div>
                
                {/* Glass Overlay Content */}
                <div className='relative z-10 flex flex-col items-center text-center p-6 bg-surface/60 backdrop-blur-md rounded-2xl border border-white/5 shadow-xl max-w-sm mx-4 transition-transform duration-300 group-hover:scale-[1.02]'>
                  <div className='w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center mb-4 text-blue-400'>
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
                  </div>
                  <h4 className='text-foreground font-medium mb-2'>No message activity yet</h4>
                  <p className='text-sm text-foreground/60 mb-6'>Your messaging journey starts here. Send your first campaign to see delivery metrics.</p>
                  <Link to="/events">
                    <Button variant="primary" className="shadow-lg shadow-blue-500/20">
                      Create Campaign
                    </Button>
                  </Link>
                </div>
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
                <div className='h-full relative overflow-hidden rounded-xl border border-border/30 bg-surface/10 flex items-center justify-center group'>
                  {/* Skeleton Background */}
                  <div className='absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none'>
                    <svg viewBox="0 0 100 50" className="w-full h-full preserve-3d" preserveAspectRatio="none">
                      <path d="M0,40 Q25,35 50,20 T100,5" fill="none" stroke="#22C55E" strokeWidth="2" />
                    </svg>
                  </div>
                  
                  {/* Glass Overlay Content */}
                  <div className='relative z-10 flex flex-col items-center text-center p-6 bg-surface/60 backdrop-blur-md rounded-2xl border border-white/5 shadow-xl max-w-sm mx-4 transition-transform duration-300 group-hover:scale-[1.02]'>
                    <div className='w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mb-4 text-green-400'>
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
                    </div>
                    <h4 className='text-foreground font-medium mb-2'>Track your success</h4>
                    <p className='text-sm text-foreground/60 mb-6'>Trend data will populate right here once your campaigns go live and start delivering.</p>
                  </div>
                </div>
              )}
          </div>
        </div>
      </div>

    </div>
  );
};

export default Dashboard;

