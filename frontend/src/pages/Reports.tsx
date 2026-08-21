import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { useAuth } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { useNavigate } from 'react-router-dom';
import { CampaignReportContent } from './Campaigns/CampaignReport';
import { FileText, ArrowRight } from 'lucide-react';
import { Badge } from '../components/ui/Badge';

const Reports = () => {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('all');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [loadingCampaign, setLoadingCampaign] = useState(false);
  const [allCampaigns, setAllCampaigns] = useState<any[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);

  // Authorization check
  const hasReportAccess = user?.role === 'SuperAdmin' || (user?.accessExpiryDate && new Date(user.accessExpiryDate) > new Date() && !user?.isAccessCancelled);

  useEffect(() => {
    if (!hasReportAccess) {
      showToast('error', 'You do not have permission to view reports. Please request access from the Super Admin.');
      navigate('/dashboard');
      return;
    }

    // Fetch events for the dropdown
    api.get('/events')
      .then(res => setEvents(res.data))
      .catch(err => console.error('Failed to fetch events', err));
  }, [hasReportAccess, navigate, showToast]);

  useEffect(() => {
    if (!selectedEventId) {
      setCampaignId(null);
      setAllCampaigns([]);
      return;
    }

    if (selectedEventId === 'all') {
      setCampaignId(null);
      setLoadingAll(true);
      api.get('/campaigns/all')
        .then(res => setAllCampaigns(res.data))
        .catch(err => console.error('Failed to fetch all campaigns', err))
        .finally(() => setLoadingAll(false));
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
                {evt.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="pt-4">
        {selectedEventId === 'all' ? (
          loadingAll ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : (
            <div className="glass-panel rounded-2xl p-6 animate-spring-up">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">All Campaign Reports</h3>
              </div>
              {allCampaigns.length > 0 ? (
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
                      {allCampaigns.map((camp: any) => (
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
                                onClick={() => setSelectedEventId(camp.eventId?._id)}
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
          )
        ) : loadingCampaign ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : campaignId ? (
          <div className="animate-fade-up">
            <CampaignReportContent 
              campaignIdProp={campaignId} 
              hideHeader={false} 
              hideBackButton={true}
              showPrintButton={true}
            />
          </div>
        ) : (
          <div className="glass-panel p-16 flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-border/50 animate-fade-in">
            <FileText className="w-16 h-16 text-foreground/20 mb-4" />
            <h3 className="text-xl font-bold text-foreground/70 mb-2">No Reports Available</h3>
            <p className="text-foreground/50">There are no sent or completed campaigns for this event yet.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Reports;
