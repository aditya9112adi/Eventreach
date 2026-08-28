import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { useAuth } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { useNavigate } from 'react-router-dom';
import { CampaignReportContent } from './Campaigns/CampaignReport';
import { FileText } from 'lucide-react';
import { Badge } from '../components/ui/Badge';

const Reports = () => {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('all');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [loadingCampaign, setLoadingCampaign] = useState(false);

  // Authorization check
  const hasReportAccess = user?.role === 'SuperAdmin' || (user?.accessExpiryDate && new Date(user.accessExpiryDate) > new Date() && !user?.isAccessCancelled);

  useEffect(() => {
    if (!hasReportAccess) {
      showToast('error', 'You do not have permission to view reports. Please request access from the Super Admin.');
      navigate('/dashboard');
      return;
    }

    // Fetch events for the dropdown and table
    api.get('/events')
      .then(res => setEvents(res.data))
      .catch(err => console.error('Failed to fetch events', err));
  }, [hasReportAccess, navigate, showToast]);

  useEffect(() => {
    if (!selectedEventId || selectedEventId === 'all') {
      setCampaignId(null);
      return;
    }

    setLoadingCampaign(true);
    api.get(`/campaigns/event/${selectedEventId}`)
      .then(res => {
        // Returns campaign or empty draft. 
        // We only show report if it actually exists and has an _id (meaning it was saved/sent)
        if (res.data && res.data._id && res.data.status !== 'Draft') {
          setCampaignId(res.data._id);
        } else {
          setCampaignId(null);
        }
      })
      .catch(err => {
        console.error('Failed to fetch campaign for event', err);
        setCampaignId(null);
      })
      .finally(() => {
        setLoadingCampaign(false);
      });
  }, [selectedEventId]);

  const eventStatusVariant = (status: string) => {
    switch (status) {
      case 'Completed': return 'success';
      case 'Upcoming': return 'warning';
      default: return 'default';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-sans font-bold text-foreground animate-slide-in uppercase">Event Reports</h2>
        
        <div className="flex flex-col">
          <label className="text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1">Event Filter</label>
          <select
            value={selectedEventId}
            onChange={(e) => setSelectedEventId(e.target.value)}
            className="bg-surface border border-border text-foreground px-4 py-2 rounded-md focus:outline-none focus:border-accent transition-colors font-medium text-sm min-w-[220px]"
          >
            <option value="all">All Events</option>
            {events.map((evt) => (
              <option key={evt._id} value={evt._id}>
                {evt.eventName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="pt-4">
        {selectedEventId === 'all' ? (
          <div className="glass-panel rounded-2xl p-6 animate-spring-up">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">All Events</h3>
            </div>
            {events.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs">Event Name</th>
                      <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs">Date</th>
                      <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs">Status</th>
                      <th className="pb-3 font-semibold text-foreground/60"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {events.map((evt: any) => (
                      <tr key={evt._id} className="hover:bg-surfaceHover transition-colors group">
                        <td className="py-4 font-medium text-foreground">
                          {evt.eventName}
                        </td>
                        <td className="py-4 text-foreground/60">
                          {evt.eventDate ? new Date(evt.eventDate).toLocaleDateString() : 'N/A'}
                        </td>
                        <td className="py-4">
                          <Badge variant={eventStatusVariant(evt.eventStatus) as any}>{evt.eventStatus || 'Upcoming'}</Badge>
                        </td>
                        <td className="py-4 text-right">
                          <button
                            onClick={() => setSelectedEventId(evt._id)}
                            className="bg-accent/10 text-accent hover:bg-accent/20 font-medium text-xs px-4 py-2 rounded transition-colors uppercase tracking-wider"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-foreground/40 text-center py-8">No events created yet.</p>
            )}
          </div>
        ) : loadingCampaign ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : campaignId ? (
          <div className="animate-fade-up">
            <CampaignReportContent 
              campaignIdProp={campaignId} 
              hideHeader={false} 
              hideBackButton={false}
              showPrintButton={true}
              onBack={() => setSelectedEventId('all')}
            />
          </div>
        ) : (
          <div className="glass-panel p-16 flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-border/50 animate-fade-in">
            <FileText className="w-16 h-16 text-foreground/20 mb-4" />
            <h3 className="text-xl font-bold text-foreground/70 mb-2">No Reports Available</h3>
            <p className="text-foreground/50">There are no sent or completed campaigns for this event yet.</p>
            <button
              onClick={() => setSelectedEventId('all')}
              className="mt-6 text-accent hover:text-accent/80 font-medium text-sm transition-colors"
            >
              ← Back to All Events
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Reports;
