import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Calendar, MapPin, Edit3, UserCircle, Phone, ShieldAlert } from 'lucide-react';
import api from '../../services/api';
import type { Event } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { formatEventType } from '../../utils/eventType';

const EventDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  // contactCount is still returned by GET /events/:id, but this page no longer
  // renders it — the guest-list card that used it lives on the Contacts page.
  const [event, setEvent] = useState<Event | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    const fetchEvent = async () => {
      try {
        const eventRes = await api.get(`/events/${id}`);
        setEvent(eventRes.data);
      } catch (error: any) {
        console.error('Failed to fetch event', error);
        if (error.response?.status === 403) {
          setAccessDenied(true);
        }
      } finally {
        setIsLoading(false);
      }
    };
    fetchEvent();
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="max-w-md mx-auto my-16 p-8 text-center bg-surface border border-border rounded-xl shadow-2xl space-y-4 animate-scale-in">
        <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">Access Denied</h2>
        <p className="text-sm text-foreground/60 leading-relaxed">
          You do not have access to this event. You can only view events assigned to your account.
        </p>
        <div className="pt-2">
          <Button onClick={() => navigate('/events')}>Back to My Events</Button>
        </div>
      </div>
    );
  }

  if (!event) return <div className="p-8 text-center text-destructive">Event not found</div>;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center space-x-4 mb-2 animate-fade-in">
        <button 
          onClick={() => navigate('/events')}
          className="p-2 text-foreground/50 hover:text-foreground hover:bg-surfaceHover rounded-full transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Event Details</h2>
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up stagger-1">
        {/* The `border-b` here divided these details from the guest-list and
            campaign cards that used to sit below. With those gone it would
            draw a line along the bottom edge of the card, so it is dropped. */}
        <div className="p-6 md:p-8">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-4xl font-sans font-bold text-foreground">{event.eventName}</h1>
                <Badge variant={event.eventStatus === 'Completed' ? 'success' : 'info'}>{event.eventStatus}</Badge>
              </div>
              {/* The `uppercase` class rendered this as "FAREWELL", which is
                  neither the stored value nor the capitalisation used for the
                  event type everywhere else. The letter-spacing is kept. */}
              <p className="text-foreground/50 text-lg tracking-wider">{formatEventType(event.eventType)}</p>
              {event.eventId && (
                <p className="text-foreground/40 text-sm font-mono mt-1 whitespace-nowrap select-all">{event.eventId}</p>
              )}
            </div>
            {event.eventStatus !== 'Completed' && (
              <Button
                variant="secondary"
                onClick={() => navigate(`/events/${event._id}/edit`)}
              >
                <Edit3 className="w-4 h-4 mr-2" />
                Edit Event
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
            <div className="flex items-start">
              <Calendar className="w-5 h-5 text-foreground/40 mr-3 mt-0.5" />
              <div>
                <p className="text-sm font-sans font-medium text-foreground/80 uppercase">Event Date & Time</p>
                <p className="text-foreground">{event.eventDate} at {event.eventTime}</p>
              </div>
            </div>
            <div className="flex items-start">
              <MapPin className="w-5 h-5 text-foreground/40 mr-3 mt-0.5" />
              <div>
                <p className="text-sm font-sans font-medium text-foreground/80 uppercase">Event Venue</p>
                <p className="text-foreground">{event.eventVenue}</p>
              </div>
            </div>
            <div className="flex items-start">
              <UserCircle className="w-5 h-5 text-foreground/40 mr-3 mt-0.5" />
              <div>
                <p className="text-sm font-sans font-medium text-foreground/80 uppercase">Event Organizer</p>
                <p className="text-foreground">{event.organizerName || 'Not Provided'}</p>
              </div>
            </div>
            <div className="flex items-start">
              <Phone className="w-5 h-5 text-foreground/40 mr-3 mt-0.5" />
              <div>
                <p className="text-sm font-sans font-medium text-foreground/80 uppercase">Mobile No</p>
                <p className="text-foreground">{event.organizerMobile || 'Not Provided'}</p>
              </div>
            </div>
          </div>

          {event.eventDescription && (
            <div className="mt-8 pt-6 border-t border-border">
              <h3 className="text-sm font-sans font-medium text-foreground/80 mb-2 uppercase">Event Description</h3>
              <p className="text-foreground/70 whitespace-pre-wrap">{event.eventDescription}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EventDetail;
