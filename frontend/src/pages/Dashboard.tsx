import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  LineChart, Line
} from 'recharts';
import { CalendarDays, Users, Megaphone, Send, CheckCircle2, XCircle, Clock, ArrowRight } from 'lucide-react';
import api from '../services/api';
import { Badge } from '../components/ui/Badge';
import { useAuth } from '../store/authStore';

const Dashboard = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalEvents: 0,
    totalContacts: 0,
    totalCampaigns: 0,
    messagesSent: 0,
    messagesDelivered: 0,
    messagesFailed: 0,
    messagesPending: 0,
  });
  const [chartData, setChartData] = useState<any[]>([]);
  const [recentCampaigns, setRecentCampaigns] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const { user } = useAuth(); // Assume we need to check if user is SuperAdmin to show filter

  useEffect(() => {
    const fetchAll = async () => {
      setIsLoading(true);
      try {
        const query = selectedEventId ? `?eventId=${selectedEventId}` : '';
        const [statsRes, activityRes, eventsRes] = await Promise.all([
          api.get(`/dashboard/stats${query}`),
          api.get(`/dashboard/recent-activity${query}`),
          api.get('/events') // Fetch events for the filter dropdown
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
  }, [selectedEventId]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(7)].map((_, i) => (
            <div key={i} className="glass-panel rounded-2xl p-6 animate-pulse">
              <div className="flex items-center">
                <div className="w-12 h-12 rounded-full bg-white/10 dark:bg-black/10 mr-4"></div>
                <div className="space-y-2 flex-1">
                  <div className="h-3 bg-white/10 dark:bg-black/10 rounded w-24"></div>
                  <div className="h-6 bg-white/10 dark:bg-black/10 rounded w-16"></div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="glass-panel rounded-2xl p-6 h-80 animate-pulse">
            <div className="h-4 bg-white/10 dark:bg-black/10 rounded w-48 mb-4"></div>
            <div className="h-64 bg-white/10 dark:bg-black/10 rounded"></div>
          </div>
          <div className="glass-panel rounded-2xl p-6 h-80 animate-pulse">
            <div className="h-4 bg-white/10 dark:bg-black/10 rounded w-48 mb-4"></div>
            <div className="h-64 bg-white/10 dark:bg-black/10 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  const statCards = [
    { label: 'Total Events', value: stats.totalEvents, icon: CalendarDays, color: 'text-blue-500 dark:text-blue-400', bg: 'bg-blue-500/10' },
    { label: 'Total Contacts', value: stats.totalContacts, icon: Users, color: 'text-indigo-500 dark:text-indigo-400', bg: 'bg-indigo-500/10' },
    { label: 'Active Campaigns', value: stats.totalCampaigns, icon: Megaphone, color: 'text-purple-500 dark:text-purple-400', bg: 'bg-purple-500/10' },
    { label: 'Messages Sent', value: stats.messagesSent, icon: Send, color: 'text-sky-500 dark:text-sky-400', bg: 'bg-sky-500/10' },
    { label: 'Delivered', value: stats.messagesDelivered, icon: CheckCircle2, color: 'text-emerald-500 dark:text-emerald-400', bg: 'bg-emerald-500/10' },
    { label: 'Failed', value: stats.messagesFailed, icon: XCircle, color: 'text-rose-500 dark:text-rose-400', bg: 'bg-rose-500/10' },
    { label: 'Pending', value: stats.messagesPending, icon: Clock, color: 'text-amber-500 dark:text-amber-400', bg: 'bg-amber-500/10' },
  ];

  const campaignStatusVariant = (status: string): 'success' | 'warning' | 'info' | 'default' => {
    switch (status) {
      case 'Completed': return 'success';
      case 'Sending': return 'warning';
      case 'Draft': return 'info';
      default: return 'default';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-sans font-bold text-foreground animate-slide-in uppercase">Dashboard Overview</h2>
        
        {user?.role === 'SuperAdmin' && (
          <div className="flex flex-col">
            <label className="text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1">Event</label>
            <select
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
              className="bg-surface border border-border text-foreground px-4 py-2 rounded-md focus:outline-none focus:border-accent transition-colors font-medium text-sm min-w-[180px]"
            >
              <option value="">All Events</option>
              {events.map((evt) => (
                <option key={evt._id} value={evt._id}>
                  {evt.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat, idx) => (
          <div key={idx} className={`glass-panel rounded-2xl p-6 flex items-center hover:-translate-y-1 hover:shadow-glass-lg hover:border-accent/30 transition-all duration-300 animate-spring-up stagger-${(idx % 5) + 1}`}>
            <div className={`w-12 h-12 rounded-full flex items-center justify-center ${stat.bg} ${stat.color} mr-4 backdrop-blur-md`}>
              <stat.icon className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground/60">{stat.label}</p>
              <h3 className="text-2xl font-bold text-foreground mt-1">{stat.value}</h3>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Chart 1 */}
        <div className="glass-panel rounded-2xl p-6 animate-spring-up stagger-4">
          <h3 className="text-lg font-sans font-bold text-foreground mb-4 uppercase tracking-wider">Messages Sent vs Delivered</h3>
          <div className="h-72">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.2)" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <RechartsTooltip cursor={{ fill: 'rgba(148, 163, 184, 0.1)' }} contentStyle={{ borderRadius: '1rem', border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(12px)', color: '#F8FAFC' }} />
                  <Bar dataKey="sent" fill="#3B82F6" radius={[4, 4, 0, 0]} name="Sent" />
                  <Bar dataKey="delivered" fill="#22C55E" radius={[4, 4, 0, 0]} name="Delivered" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-foreground/40 font-medium">
                <p>No message activity yet. Send your first campaign!</p>
              </div>
            )}
          </div>
        </div>

        {/* Chart 2 */}
        <div className="glass-panel rounded-2xl p-6 animate-spring-up stagger-5">
          <h3 className="text-lg font-sans font-bold text-foreground mb-4 uppercase tracking-wider">Delivery Rate Trend</h3>
          <div className="h-72">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.2)" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94A3B8' }} />
                  <RechartsTooltip contentStyle={{ borderRadius: '1rem', border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(12px)', color: '#F8FAFC' }} />
                  <Line type="monotone" dataKey="delivered" stroke="#22C55E" strokeWidth={3} dot={{ strokeWidth: 2, r: 4 }} activeDot={{ r: 6 }} name="Delivered" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-foreground/40 font-medium">
                <p>Trend data will appear after campaigns are sent.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Campaigns */}
      <div className="glass-panel rounded-2xl p-6 animate-spring-up stagger-5">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">Recent Campaigns</h3>
          <button
            onClick={() => navigate('/campaigns')}
            className="text-sm text-accent hover:text-accent/80 font-medium flex items-center transition-colors"
          >
            View All <ArrowRight className="w-4 h-4 ml-1" />
          </button>
        </div>
        {recentCampaigns.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs">Event</th>
                  <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs">Status</th>
                  <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs">Updated</th>
                  <th className="pb-3 font-semibold text-foreground/60"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recentCampaigns.map((camp: any) => (
                  <tr key={camp._id} className="hover:bg-surfaceHover transition-colors group">
                    <td className="py-4 font-medium text-foreground">
                      {camp.eventId?.name || 'Unknown Event'}
                    </td>
                    <td className="py-4">
                      <Badge variant={campaignStatusVariant(camp.status)}>{camp.status}</Badge>
                    </td>
                    <td className="py-4 text-foreground/60">
                      {new Date(camp.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="py-4 text-right">
                      {(camp.status === 'Sending' || camp.status === 'Completed') && (
                        <button
                          onClick={() => navigate(`/campaigns/${camp._id}/report`)}
                          className="text-accent hover:text-accent/80 font-medium text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          View Report →
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-foreground/40 text-center py-8">No campaigns created yet.</p>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
