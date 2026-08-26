import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSocket } from '../../contexts/SocketContext';
import { Link } from 'react-router-dom';
import { Plus, Search, Calendar, MapPin, ChevronUp, ChevronDown, ChevronsUpDown, X } from 'lucide-react';
import api from '../../services/api';
import type { Event } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';

type SortField = 'name' | 'type' | 'date' | 'venue' | 'status' | 'organizerName' | 'organizerMobile';
type SortDir = 'asc' | 'desc';

const EventList = () => {
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Search & filter state
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Sort state
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const fetchEvents = useCallback(async () => {
    try {
      const response = await api.get('/events');
      setEvents(response.data);
    } catch (error) {
      console.error('Failed to fetch events', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // Real-time socket updates
  const { socket } = useSocket();
  useEffect(() => {
    if (!socket) return;
    const handler = () => fetchEvents();
    socket.on('event-status-changed', handler);
    return () => { socket.off('event-status-changed', handler); };
  }, [socket, fetchEvents]);

  // Derived unique lists for filter dropdowns
  const eventTypes = useMemo(() => Array.from(new Set(events.map(e => e.type).filter(Boolean))).sort(), [events]);
  const eventStatuses = useMemo(() => Array.from(new Set(events.map(e => e.status).filter(Boolean))).sort(), [events]);

  // Handle column header sort click
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown className="w-3 h-3 ml-1 opacity-40 inline-block" />;
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 ml-1 text-accent inline-block" />
      : <ChevronDown className="w-3 h-3 ml-1 text-accent inline-block" />;
  };

  // Filter + sort pipeline
  const processedEvents = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();

    const filtered = events.filter(e => {
      const matchesSearch = !q || [
        e.organizerName, e.organizerMobile, e.name,
        e.type, e.date, e.time, e.venue, e.status,
      ].some(v => (v || '').toLowerCase().includes(q));

      const matchesType = !filterType || e.type === filterType;
      const matchesStatus = !filterStatus || e.status === filterStatus;

      return matchesSearch && matchesType && matchesStatus;
    });

    filtered.sort((a, b) => {
      let aVal = '';
      let bVal = '';
      switch (sortField) {
        case 'name':           aVal = a.name || ''; bVal = b.name || ''; break;
        case 'type':           aVal = a.type || ''; bVal = b.type || ''; break;
        case 'date':           aVal = `${a.date || ''}${a.time || ''}`; bVal = `${b.date || ''}${b.time || ''}`; break;
        case 'venue':          aVal = a.venue || ''; bVal = b.venue || ''; break;
        case 'status':         aVal = a.status || ''; bVal = b.status || ''; break;
        case 'organizerName':  aVal = a.organizerName || ''; bVal = b.organizerName || ''; break;
        case 'organizerMobile':aVal = a.organizerMobile || ''; bVal = b.organizerMobile || ''; break;
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return filtered;
  }, [events, searchTerm, filterType, filterStatus, sortField, sortDir]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Upcoming':  return <Badge variant="info">Upcoming</Badge>;
      case 'Completed': return <Badge variant="success">Completed</Badge>;
      case 'Cancelled': return <Badge variant="error">Cancelled</Badge>;
      default:          return <Badge>{status}</Badge>;
    }
  };

  const hasActiveFilters = searchTerm || filterType || filterStatus;

  const clearAll = () => {
    setSearchTerm('');
    setFilterType('');
    setFilterStatus('');
  };

  // Th helper for sortable columns
  const SortTh = ({ field, label, className = '' }: { field: SortField; label: string; className?: string }) => (
    <th
      className={`py-3 px-4 cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${className}`}
      onClick={() => handleSort(field)}
    >
      {label}<SortIcon field={field} />
    </th>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 animate-fade-in">
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Events</h2>
        <Link to="/events/create">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Create Event
          </Button>
        </Link>
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up stagger-1">

        {/* ── Search & Filter Bar ── */}
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">

            {/* Global search */}
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40 pointer-events-none" />
              <input
                type="text"
                placeholder="Search by organizer, mobile, name, type, venue, status..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full rounded-md border border-border bg-surface/50 pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/40 hover:border-border/80 transition-all duration-200"
              />
            </div>

            {/* Event Type filter */}
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="rounded-md border border-border bg-surface/50 px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-white/20 transition-all min-w-[160px]"
            >
              <option value="">All Event Types</option>
              {eventTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            {/* Event Status filter */}
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="rounded-md border border-border bg-surface/50 px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-white/20 transition-all min-w-[160px]"
            >
              <option value="">All Statuses</option>
              {eventStatuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Active filters indicator + clear */}
          {hasActiveFilters && (
            <div className="flex items-center gap-2 flex-wrap text-xs text-foreground/60">
              <span>Showing {processedEvents.length} of {events.length} events</span>
              {searchTerm && (
                <span className="bg-accent/10 text-accent border border-accent/20 rounded px-2 py-0.5">
                  Search: "{searchTerm}"
                </span>
              )}
              {filterType && (
                <span className="bg-accent/10 text-accent border border-accent/20 rounded px-2 py-0.5">
                  Type: {filterType}
                </span>
              )}
              {filterStatus && (
                <span className="bg-accent/10 text-accent border border-accent/20 rounded px-2 py-0.5">
                  Status: {filterStatus}
                </span>
              )}
              <button
                onClick={clearAll}
                className="flex items-center gap-1 text-foreground/40 hover:text-destructive transition-colors"
              >
                <X className="w-3 h-3" /> Clear all
              </button>
            </div>
          )}
        </div>

        {/* ── Table ── */}
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : processedEvents.length === 0 ? (
          <div className="p-8 text-center text-foreground/50">
            {hasActiveFilters ? 'No events match your search or filters.' : 'No events found.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-surfaceHover text-foreground/60 font-medium border-b border-border uppercase tracking-wide text-xs">
                  <SortTh field="organizerName"   label="Event Organizer" />
                  <SortTh field="organizerMobile" label="Mobile No" />
                  <SortTh field="name"            label="Event Name" />
                  <SortTh field="type"            label="Event Type" />
                  <SortTh field="date"            label="Event Date & Time" />
                  <SortTh field="venue"           label="Event Venue" />
                  <SortTh field="status"          label="Event Status" />
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {processedEvents.map((event, idx) => (
                  <tr
                    key={event._id}
                    className={`hover:bg-surfaceHover transition-colors group animate-fade-up stagger-${(idx % 5) + 1}`}
                  >
                    <td className="py-3 px-4 text-sm font-medium text-foreground">{event.organizerName || '—'}</td>
                    <td className="py-3 px-4 text-sm text-foreground/80">{event.organizerMobile || '—'}</td>
                    <td className="py-3 px-4 font-medium text-foreground">{event.name}</td>
                    <td className="py-3 px-4 text-sm text-foreground/80">{event.type}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center text-sm text-foreground/80 whitespace-nowrap">
                        <Calendar className="w-3.5 h-3.5 mr-1.5 text-foreground/40" />
                        {event.date} at {event.time}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center text-sm text-foreground/80">
                        <MapPin className="w-3.5 h-3.5 mr-1.5 text-foreground/40" />
                        {event.venue}
                      </div>
                    </td>
                    <td className="py-3 px-4">{getStatusBadge(event.status)}</td>
                    <td className="py-3 px-4 text-right">
                      <Link to={`/events/${event._id}`}>
                        <Button variant="secondary" className="text-xs py-1.5 px-3">View</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default EventList;
