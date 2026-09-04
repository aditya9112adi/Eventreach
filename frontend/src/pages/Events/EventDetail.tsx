import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Users, Calendar, MapPin, Edit3, Megaphone, UserCircle, Phone, ShieldAlert } from 'lucide-react';
import api from '../../services/api';
import type { Event, Campaign } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';

const EventDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState<(Event & { contactCount: number }) | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    const fetchEvent = async () => {
      try {
        const eventRes = await api.get(`/events/${id}`);
        setEvent(eventRes.data);
        
        try {
          const campRes = await api.get(`/campaigns/event/${id}`);
          if (campRes.data && campRes.data._id) {
            setCampaign(campRes.data);
          }
        } catch (e) {
          // Campaign might not exist yet, ignore
        }
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
        <div className="p-6 md:p-8 border-b border-border">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-4xl font-sans font-bold text-foreground">{event.eventName}</h1>
                <Badge variant={event.eventStatus === 'Completed' ? 'success' : 'info'}>{event.eventStatus}</Badge>
              </div>
              <p className="text-foreground/50 text-lg uppercase tracking-wider">{event.eventType}</p>
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
        
        <div className="bg-surface/50 p-6 md:p-8 grid grid-cols-1 md:grid-cols-2 gap-6 animate-fade-up stagger-2">
          <div className="bg-surface p-6 rounded-lg border border-border flex flex-col items-center text-center group hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 bg-accent/10 text-accent rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <Users className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">Guest List</h3>
            <p className="text-foreground/50 mb-4">{event.contactCount} contacts loaded</p>
            <Link to={`/contacts?eventId=${event._id}`} className="mt-auto">
              <Button variant="primary">Manage Contacts</Button>
            </Link>
          </div>
          
          <div className="bg-surface p-6 rounded-lg border border-border flex flex-col items-center text-center group hover:border-accent/50 transition-colors">
            <div className="w-12 h-12 bg-purple-500/10 text-purple-400 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <Megaphone className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-sans font-bold text-foreground mb-2 uppercase tracking-wider">Campaigns</h3>
            <p className="text-sm text-foreground/50 mb-4">
              {campaign ? `Status: ${campaign.status}` : 'Create a WhatsApp campaign to send to this event.'}
            </p>
            
            {campaign && (campaign.status === 'Sending' || campaign.status === 'Completed') ? (
              <Link to={`/campaigns/${campaign._id}/report`} className="mt-auto w-full">
                <Button className="w-full" variant="primary">
                  <Megaphone className="w-4 h-4 mr-2" />
                  View Report
                </Button>
              </Link>
            ) : (
              <Link to={`/campaigns?eventId=${event._id}`} className="mt-auto w-full">
                <Button className="w-full">
                  <Megaphone className="w-4 h-4 mr-2" />
                  {campaign && campaign._id ? 'Edit Campaign' : 'Create Campaign'}
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EventDetail;
