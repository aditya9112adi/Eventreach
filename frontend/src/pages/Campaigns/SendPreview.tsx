import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Send, CheckCircle2, Users, Eye, MessageSquare } from 'lucide-react';
import api from '../../services/api';
import type { Contact, Event, MediaAttachment } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { useLoader } from '../../components/ui/FullScreenLoader';

const SendPreview = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const eventId = searchParams.get('eventId') || '';
  const { showToast } = useToast();
  const { showLoader, showSuccess, showError, hideLoader } = useLoader();

  const [event, setEvent] = useState<Event | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [campaign, setCampaign] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [previewContact, setPreviewContact] = useState<Contact | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      if (!eventId) return;
      try {
        const [eventRes, contactsRes, campaignRes] = await Promise.all([
          api.get(`/events/${eventId}`),
          api.get(`/contacts/event/${eventId}`),
          api.get(`/campaigns/event/${eventId}`)
        ]);
        setEvent(eventRes.data);
        // Only show Valid contacts
        const validContacts = contactsRes.data.filter((c: Contact) => c.status === 'Valid');
        setContacts(validContacts);
        // Select all by default
        setSelectedIds(new Set(validContacts.map((c: Contact) => c._id)));
        setCampaign(campaignRes.data);
      } catch (error) {
        console.error('Failed to fetch data', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [eventId]);

  const toggleContact = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === contacts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(contacts.map(c => c._id)));
    }
  };

  const getPreviewText = (contact: Contact) => {
    if (!campaign?.messageText) return '';
    let text = campaign.messageText;
    text = text.replace(/{{fullName}}/g, contact.fullName);
    text = text.replace(/{{eventName}}/g, event?.name || '');
    text = text.replace(/{{venue}}/g, event?.venue || '');
    return text;
  };

  const handleSend = async () => {
    if (selectedIds.size === 0) {
      showToast('warning', 'Please select at least one recipient');
      return;
    }

    const confirmSend = window.confirm(
      `Send this campaign to ${selectedIds.size} recipient${selectedIds.size !== 1 ? 's' : ''}?`
    );
    if (!confirmSend) return;

    setIsSending(true);
    showLoader(`Sending to ${selectedIds.size} recipients...`);
    try {
      await api.post(`/campaigns/event/${eventId}/send`, {
        recipientIds: Array.from(selectedIds)
      });
      await showSuccess(`Campaign queued for ${selectedIds.size} recipients!`);
      navigate(`/events/${eventId}`);
    } catch (err) {
      console.error('Failed to send', err);
      await showError('Failed to send campaign');
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
      </div>
    );
  }

  if (!event || !campaign) {
    return <div className="p-8 text-center text-red-600">Campaign or event not found.</div>;
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-2 animate-fade-in">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate(`/campaigns?eventId=${eventId}`)}
            className="p-2 text-foreground/50 hover:text-foreground hover:bg-surfaceHover rounded-full transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Review & Send</h2>
            <p className="text-sm text-foreground/50">{event.name}</p>
          </div>
        </div>
        <Button onClick={handleSend} isLoading={isSending} disabled={selectedIds.size === 0}>
          <Send className="w-4 h-4 mr-2" />
          Send to {selectedIds.size} Recipient{selectedIds.size !== 1 ? 's' : ''}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recipient Selection */}
        <div className="lg:col-span-2 animate-fade-up stagger-1">
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between bg-surface/50">
              <div className="flex items-center space-x-3">
                <Users className="w-5 h-5 text-accent" />
                <h3 className="font-sans font-bold text-foreground uppercase tracking-wider text-sm">Select Recipients</h3>
                <Badge variant="info">{selectedIds.size} / {contacts.length} selected</Badge>
              </div>
              <button
                onClick={toggleAll}
                className="text-sm text-accent hover:text-accent/80 font-medium transition-colors"
              >
                {selectedIds.size === contacts.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            {contacts.length === 0 ? (
              <div className="p-8 text-center text-foreground/40">
                No valid contacts in this event. Import contacts first.
              </div>
            ) : (
              <div className="max-h-[500px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-surfaceHover text-foreground/60 font-medium border-b border-border sticky top-0 uppercase tracking-wide text-xs">
                      <th className="py-3 px-4 w-12">
                        <input
                          type="checkbox"
                          checked={selectedIds.size === contacts.length && contacts.length > 0}
                          onChange={toggleAll}
                          className="rounded border-border bg-background text-accent focus:ring-accent/20"
                        />
                      </th>
                      <th className="py-3 px-4 text-left">Name</th>
                      <th className="py-3 px-4 text-left">Phone</th>
                      <th className="py-3 px-4 w-20">Preview</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {contacts.map((contact, idx) => (
                      <tr
                        key={contact._id}
                        className={`transition-colors cursor-pointer group animate-fade-up stagger-${(idx % 5) + 1} ${selectedIds.has(contact._id) ? 'bg-accent/5' : 'hover:bg-surfaceHover'}`}
                        onClick={() => toggleContact(contact._id)}
                      >
                        <td className="py-3 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(contact._id)}
                            onChange={() => toggleContact(contact._id)}
                            className="rounded border-border bg-background text-accent focus:ring-accent/20"
                          />
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-foreground">{contact.fullName}</div>
                          {contact.email && <div className="text-xs text-foreground/50">{contact.email}</div>}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-foreground/80">{contact.phoneNumber}</td>
                        <td className="py-3 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setPreviewContact(contact)}
                            className="p-1.5 text-foreground/40 hover:text-accent hover:bg-accent/10 rounded transition-colors"
                            title="Preview message for this contact"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Message Preview Panel */}
        <div className="lg:col-span-1 animate-fade-up stagger-2">
          <div className="bg-surface rounded-xl border border-border p-6 sticky top-6">
            <div className="flex items-center space-x-2 mb-4">
              <MessageSquare className="w-5 h-5 text-accent" />
              <h3 className="font-sans font-bold text-foreground uppercase tracking-wider text-sm">Message Preview</h3>
            </div>

            {previewContact ? (
              <div className="space-y-4 animate-fade-in">
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium text-foreground">{previewContact.fullName}</span>
                  <span className="text-xs text-foreground/50">{previewContact.phoneNumber}</span>
                </div>

                <div className="bg-background rounded-lg p-4 min-h-[200px] border border-border relative overflow-hidden">
                  <div className="absolute inset-0 bg-[#075E54]/5 z-0" style={{ backgroundImage: "url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')", backgroundSize: '200px' }}></div>
                  <div className="bg-surface p-3 rounded-lg border border-border shadow-sm text-sm text-foreground whitespace-pre-wrap relative pb-6 z-10 w-[85%] float-left rounded-tl-none">
                    {getPreviewText(previewContact)}
                    <span className="absolute bottom-1 right-2 text-[10px] text-foreground/40">12:00 PM</span>
                  </div>

                  {campaign.mediaAttachments?.length > 0 && (
                    <div className="mt-2 space-y-1 z-10 relative float-left w-full">
                      {campaign.mediaAttachments.map((att: MediaAttachment, idx: number) => (
                        <div key={idx} className="bg-surface p-2 rounded-lg border border-border shadow-sm text-xs text-foreground/50 truncate w-[85%] rounded-tl-none">
                          📎 {att.filename}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="clear-both"></div>
                </div>

                <p className="text-xs text-foreground/40">
                  Click the <Eye className="w-3 h-3 inline" /> icon on any contact row to preview their personalized message.
                </p>
              </div>
            ) : (
              <div className="text-center py-12 text-foreground/30">
                <Eye className="w-8 h-8 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Click the eye icon on any contact to preview their personalized message.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SendPreview;
