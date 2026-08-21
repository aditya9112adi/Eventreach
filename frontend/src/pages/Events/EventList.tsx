import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Calendar, MapPin } from 'lucide-react';
import api from '../../services/api';
import type { Event } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';

const EventList = () => {
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const response = await api.get('/events');
        setEvents(response.data);
      } catch (error) {
        console.error('Failed to fetch events', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchEvents();
  }, []);

  const filteredEvents = events.filter(e => 
    e.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'Draft': return <Badge variant="default">Draft</Badge>;
      case 'Upcoming': return <Badge variant="info">Upcoming</Badge>;
      case 'Completed': return <Badge variant="success">Completed</Badge>;
      case 'Cancelled': return <Badge variant="error">Cancelled</Badge>;
      default: return <Badge>{status}</Badge>;
    }
  };

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
        <div className="p-4 border-b border-border">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
            <Input 
              placeholder="Search events..." 
              className="pl-9 bg-background"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-foreground/50">No events found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-surfaceHover text-foreground/60 font-medium border-b border-border uppercase tracking-wide text-xs">
                  <th className="py-3 px-4">Organizer</th>
                  <th className="py-3 px-4">Mobile</th>
                  <th className="py-3 px-4">Event Name</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4">Date & Time</th>
                  <th className="py-3 px-4">Venue</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredEvents.map((event, idx) => (
                  <tr key={event._id} className={`hover:bg-surfaceHover transition-colors group animate-fade-up stagger-${(idx % 5) + 1}`}>
                    <td className="py-3 px-4 text-sm font-medium text-foreground">
                      {event.organizerName || '-'}
                    </td>
                    <td className="py-3 px-4 text-sm text-foreground/80">
                      {event.organizerMobile || '-'}
                    </td>
                    <td className="py-3 px-4 font-medium text-foreground">
                      {event.name}
                    </td>
                    <td className="py-3 px-4 text-sm text-foreground/80">
                      {event.type}
                    </td>
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
                    <td className="py-3 px-4">
                      {getStatusBadge(event.status)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Link to={`/events/${event._id}`}>
                        <Button variant="secondary" className="text-xs py-1.5 px-3">
                          View
                        </Button>
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
