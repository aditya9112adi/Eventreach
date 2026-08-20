import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Users, Calendar, MapPin, Edit3, Megaphone } from 'lucide-react';
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
      } catch (error) {
        console.error('Failed to fetch event', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchEvent();
  }, [id]);

  if (isLoading) return <div className="p-8 text-center text-foreground/50 animate-pulse">Loading event details...</div>;
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
                <h1 className="text-4xl font-sans font-bold text-foreground">{event.name}</h1>
                <Badge variant={event.status === 'Completed' ? 'success' : 'info'}>{event.status}</Badge>
              </div>
              <p className="text-foreground/50 text-lg uppercase tracking-wider">{event.type}</p>
            </div>
            <Button variant="secondary" disabled={campaign?.status === 'Sending' || campaign?.status === 'Completed'}>
              <Edit3 className="w-4 h-4 mr-2" />
              Edit Event
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
            <div className="flex items-start">
              <Calendar className="w-5 h-5 text-foreground/40 mr-3 mt-0.5" />
              <div>
                <p className="text-sm font-sans font-medium text-foreground/80 uppercase">Date and Time</p>
                <p className="text-foreground">{event.date} at {event.time}</p>
              </div>
            </div>
            <div className="flex items-start">
              <MapPin className="w-5 h-5 text-foreground/40 mr-3 mt-0.5" />
              <div>
                <p className="text-sm font-sans font-medium text-foreground/80 uppercase">Venue</p>
                <p className="text-foreground">{event.venue}</p>
              </div>
            </div>
          </div>
          
          {event.description && (
            <div className="mt-8 pt-6 border-t border-border">
              <h3 className="text-sm font-sans font-medium text-foreground/80 mb-2 uppercase">Description</h3>
              <p className="text-foreground/70 whitespace-pre-wrap">{event.description}</p>
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
