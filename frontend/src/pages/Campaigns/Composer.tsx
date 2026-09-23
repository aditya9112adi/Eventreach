import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Save, Send, Image, FileText, Plus, X, AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import api from '../../services/api';
import type { Contact, Event, MediaAttachment } from '@eventreach/shared';
import {
  WHATSAPP_MAX_ANY_BYTES,
  WHATSAPP_MEDIA_RULES,
  whatsAppMediaLimitSummary,
} from '@eventreach/shared';

/** MIME -> byte ceiling, derived from the shared rules the backend enforces. */
const WHATSAPP_MEDIA_MAX_BYTES: Record<string, number> = Object.fromEntries(
  Object.entries(WHATSAPP_MEDIA_RULES).map(([mime, rule]) => [mime, rule.maxBytes])
);
import { Button } from '../../components/ui/Button';
import { EventSearch } from '../../components/ui/EventSearch';
import { FileUpload } from '../../components/ui/FileUpload';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { GuestMultiSelect } from '../../components/ui/GuestMultiSelect';
import {
  canSendTemplate,
  describeSendError,
  renderTemplateBody,
  selectionKey,
  sendBlockedReason,
  summarizeSendResult,
  variableLabel,
  type SendSummary,
  type TemplatePreview,
} from '../../utils/templateTest';

/**
 * The approved WhatsApp templates this page can send. One entry for now. The
 * backend keeps the same allowlist and is what actually decides — this is only
 * what the user sees.
 */
const TEMPLATES = [
  {
    name: 'event_reminder',
    label: 'Event reminder',
    description: 'Approved utility template. Fills guest name, event, date, time and venue.',
  },
];

const Composer = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultEventId = searchParams.get('eventId') || '';
  const { showToast } = useToast();

  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>(defaultEventId);
  const [messageText, setMessageText] = useState('');
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  
  // WhatsApp template mode: one approved template, the selected guests, real
  // messages — each rendered by Meta from that guest's own values.
  const [messageMode, setMessageMode] = useState<'custom' | 'template'>('custom');
  const [templateName, setTemplateName] = useState(TEMPLATES[0].name);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [isContactsLoading, setIsContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState('');
  const [templatePreview, setTemplatePreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isSendingTemplate, setIsSendingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [sendSummary, setSendSummary] = useState<SendSummary | null>(null);
  // The selection already sent. Holding it here is what stops the same guest
  // being messaged twice by a double click or an impatient second click.
  const [lastSentKey, setLastSentKey] = useState<string | null>(null);

  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  // Derive if the currently selected event is completed
  const selectedEvent = events.find(e => e._id === selectedEventId) || null;
  const isEventCompleted = selectedEvent?.eventStatus === 'Completed';
  const isEventSendable = selectedEvent ? selectedEvent.eventStatus === 'Upcoming' : false;

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const response = await api.get('/events');
        setEvents(response.data);
        if (!selectedEventId && response.data.length > 0) {
          setSelectedEventId(response.data[0]._id);
        }
      } catch (err) {
        console.error('Failed to fetch events', err);
      }
    };
    fetchEvents();
  }, [selectedEventId]);

  useEffect(() => {
    const fetchCampaign = async () => {
      if (!selectedEventId) return;
      try {
        const response = await api.get(`/campaigns/event/${selectedEventId}`);
        if (response.data) {
          setMessageText(response.data.messageText || '');
          setAttachments(response.data.mediaAttachments || []);
          setHistory(response.data.history || []);
        }
      } catch (err) {
        console.error('Failed to fetch campaign', err);
        setMessageText('');
        setAttachments([]);
        setHistory([]);
      }
    };
    fetchCampaign();
  }, [selectedEventId]);


  /**
   * Guests of the selected event, for the template send. Loaded only in
   * template mode — the custom flow picks its recipients on the next page and
   * nothing about it changes here.
   *
   * Changing the event clears the selection outright: a guest of the previous
   * event must never stay selected, and the server would refuse them anyway.
   */
  useEffect(() => {
    setSelectedContactIds([]);
    setContacts([]);
    setContactsError('');

    if (messageMode !== 'template' || !selectedEventId) {
      setIsContactsLoading(false);
      return;
    }

    let cancelled = false;
    setIsContactsLoading(true);

    const fetchContacts = async () => {
      try {
        const response = await api.get(`/contacts/event/${selectedEventId}`);
        if (cancelled) return;
        // Same rule as the send preview: a number WhatsApp cannot accept is
        // not offered as a recipient.
        const valid = (response.data as Contact[]).filter((c) => c.status === 'Valid');
        setContacts(valid);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to fetch guests', err);
        setContacts([]);
        setContactsError(describeSendError(err));
      } finally {
        if (!cancelled) setIsContactsLoading(false);
      }
    };

    fetchContacts();
    return () => {
      cancelled = true;
    };
  }, [messageMode, selectedEventId]);

  /**
   * What the guests would receive. The text comes from the backend, which
   * reads the approved body from Meta and resolves the variables from the
   * stored event and guest — the browser never composes a template message and
   * never holds a WhatsApp credential.
   *
   * A batch previews its first selected guest; the rest receive the same
   * template with their own name filled in.
   */
  const previewContactId = selectedContactIds[0] ?? '';
  const previewRequestRef = useRef(0);
  useEffect(() => {
    setSendSummary(null);
    setTemplateError('');

    if (messageMode !== 'template' || !selectedEventId || !previewContactId) {
      setTemplatePreview(null);
      setPreviewError('');
      setIsPreviewLoading(false);
      return;
    }

    const requestId = ++previewRequestRef.current;
    setIsPreviewLoading(true);
    setPreviewError('');

    api
      .get('/whatsapp/event-template-preview', {
        params: { eventId: selectedEventId, contactId: previewContactId, templateName },
      })
      .then((response) => {
        if (previewRequestRef.current !== requestId) return; // a later selection won
        setTemplatePreview(response.data);
      })
      .catch((err) => {
        if (previewRequestRef.current !== requestId) return;
        setTemplatePreview(null);
        setPreviewError(describeSendError(err));
      })
      .finally(() => {
        if (previewRequestRef.current === requestId) setIsPreviewLoading(false);
      });
  }, [messageMode, selectedEventId, previewContactId, templateName]);

  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    setUploadProgress(0);
    const controller = new AbortController();
    setAbortController(controller);
    
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await api.post('/campaigns/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        signal: controller.signal,
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            setUploadProgress(percentCompleted);
          }
        }
      });
      setAttachments(prev => [...prev, response.data]);
      setUploadFile(null);
    } catch (error: any) {
      if (error.name === 'CanceledError' || error.message === 'canceled') {
        showToast('info', 'Upload cancelled');
      } else {
        console.error('Upload failed', error);
        // The backend explains exactly why (wrong type, too large for this
        // media type, contents not matching the extension); a generic
        // "Failed to upload file" hid all of it.
        showToast('error', error?.response?.data?.error || 'Failed to upload file');
      }
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      setAbortController(null);
    }
  };

  const cancelUpload = () => {
    if (abortController) {
      abortController.abort();
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!selectedEventId) return;
    setIsSaving(true);
    try {
      await api.post(`/campaigns/event/${selectedEventId}`, {
        messageText,
        mediaAttachments: attachments,
        status: 'Draft'
      });
      showToast('success', 'Draft saved successfully');
    } catch (err) {
      console.error('Failed to save', err);
      showToast('error', 'Failed to save draft');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSend = async () => {
    if (!selectedEventId) return;

    setIsSending(true);
    try {
      // Save the current draft state first
      await api.post(`/campaigns/event/${selectedEventId}`, {
        messageText,
        mediaAttachments: attachments,
        status: 'Draft'
      });
      
      // Navigate to the preview/recipient selection page
      navigate(`/campaigns/send-preview?eventId=${selectedEventId}`);
    } catch (err) {
      console.error('Failed to save before preview', err);
      showToast('error', 'Failed to proceed to preview');
    } finally {
      setIsSending(false);
    }
  };

  const sendGate = {
    eventId: selectedEventId,
    contactIds: selectedContactIds,
    templateName,
    preview: templatePreview,
    isSending: isSendingTemplate,
    lastSentKey,
    eventSendable: isEventSendable,
  };

  /**
   * Sends the approved template to every selected guest.
   *
   * Three things stop a duplicate: the ref lock below (a second click landing
   * before React re-renders), lastSentKey (the same selection twice), and the
   * backend's own 60-second window per guest.
   *
   * A partial failure is not an error: the request resolves with 207 and the
   * per-recipient results say who was sent to and who was not. When every
   * recipient failed the request rejects, but the body still carries the same
   * per-recipient list, so it is reported the same way.
   */
  const sendingTemplateRef = useRef(false);
  const handleSendTemplate = async () => {
    if (sendingTemplateRef.current || !canSendTemplate(sendGate)) return;
    sendingTemplateRef.current = true;

    setIsSendingTemplate(true);
    setTemplateError('');
    try {
      const response = await api.post('/whatsapp/event-template', {
        eventId: selectedEventId,
        contactIds: selectedContactIds,
        templateName,
      });
      const summary = summarizeSendResult(response.data);
      setSendSummary(summary);
      // Only a send that actually reached someone locks the selection; a batch
      // where nothing went out stays retryable without an extra click.
      if (summary.sent.length > 0) {
        setLastSentKey(selectionKey(selectedEventId, selectedContactIds, templateName));
      }
      showToast(summary.tone === 'success' ? 'success' : 'error', summary.headline);
    } catch (err: any) {
      const data = err?.response?.data;
      if (Array.isArray(data?.failed)) {
        // Every recipient failed: same per-recipient reporting, no success.
        const summary = summarizeSendResult(data);
        setSendSummary(summary);
        showToast('error', summary.headline);
      } else {
        const message = describeSendError(err);
        setTemplateError(message);
        showToast('error', message);
      }
    } finally {
      sendingTemplateRef.current = false;
      setIsSendingTemplate(false);
    }
  };

  const getPreviewText = () => {
    let preview = messageText;
    preview = preview.replace(/{{fullName}}/g, 'John Doe');
    preview = preview.replace(/{{eventName}}/g, events.find(e => e._id === selectedEventId)?.eventName || 'The Event');
    preview = preview.replace(/{{venue}}/g, events.find(e => e._id === selectedEventId)?.eventVenue || 'The Venue');
    return preview;
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2 animate-fade-in">
        <div className="flex items-center space-x-4">
          <button 
            onClick={() => navigate('/events')}
            className="p-2 text-foreground/50 hover:text-foreground hover:bg-surfaceHover rounded-full transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Campaign Composer</h2>
        </div>
        <div className="flex items-center space-x-3">
          {messageMode === 'custom' ? (
            <>
              <Button variant="secondary" onClick={handleSave} isLoading={isSaving} disabled={isSending || isEventCompleted}>
                <Save className="w-4 h-4 mr-2" /> Save Draft
              </Button>
              <Button onClick={handleSend} isLoading={isSending} disabled={!selectedEventId || !messageText || isSaving || isEventCompleted}>
                <Send className="w-4 h-4 mr-2" /> Proceed to Send
              </Button>
            </>
          ) : (
            <Button
              onClick={handleSendTemplate}
              isLoading={isSendingTemplate}
              disabled={!canSendTemplate(sendGate)}
              title={sendBlockedReason(sendGate) || undefined}
            >
              <Send className="w-4 h-4 mr-2" />
              {selectedContactIds.length > 1
                ? `Send to ${selectedContactIds.length} Guests`
                : 'Send to 1 Guest'}
            </Button>
          )}
        </div>
      </div>

      {/* Completed Event Banner */}
      {isEventCompleted && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-xl px-5 py-4 animate-fade-in">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <p className="text-sm font-medium">
            This event has been completed. Adding contacts and sending messages are no longer available.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Editor Area */}
        <div className="lg:col-span-2 space-y-6 animate-fade-up stagger-1">
          <div className="bg-surface rounded-xl border border-border p-6 space-y-6">
            <div>
              <label className="block text-sm font-sans text-foreground/80 mb-2">Target Event</label>
              <div className="w-full max-w-md relative z-20"><EventSearch events={events} value={selectedEventId} onChange={(val) => setSelectedEventId(val)} placeholder="Select an Event..." allowClear={false} /></div>
            </div>

            {/* Message type: the existing free-text campaign, or one approved
                WhatsApp template sent to a single guest. */}
            <div>
              <label className="block text-sm font-sans text-foreground/80 mb-2">Message Type</label>
              <div className="inline-flex rounded-lg border border-border overflow-hidden">
                {([
                  { id: 'custom' as const, label: 'Custom Message' },
                  { id: 'template' as const, label: 'WhatsApp Template' },
                ]).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setMessageMode(option.id)}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      messageMode === option.id
                        ? 'bg-accent text-white'
                        : 'bg-surface text-foreground/70 hover:bg-surfaceHover'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-foreground/50 mt-2">
                {messageMode === 'custom'
                  ? 'Free text and attachments, sent to the recipients you pick on the next screen.'
                  : 'An approved WhatsApp template, sent to the guests you select. Meta fills each message from the event and that guest.'}
              </p>
            </div>

            {messageMode === 'template' && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-sans text-foreground/80 mb-2">Template</label>
                  <select
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    className="w-full max-w-md rounded-md border border-border bg-background text-foreground p-2.5 text-sm focus:ring-2 focus:ring-white/20 outline-none"
                  >
                    {TEMPLATES.map((template) => (
                      <option key={template.name} value={template.name}>
                        {template.label} ({template.name})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-foreground/50 mt-2">
                    {TEMPLATES.find((template) => template.name === templateName)?.description}
                  </p>
                </div>

                <div>
                  <label htmlFor="template-guests" className="block text-sm font-sans text-foreground/80 mb-2">
                    Guests
                  </label>
                  <div className="w-full max-w-md relative z-10">
                    <GuestMultiSelect
                      id="template-guests"
                      guests={contacts}
                      value={selectedContactIds}
                      onChange={setSelectedContactIds}
                      isLoading={isContactsLoading}
                      disabled={!selectedEventId || isSendingTemplate}
                      emptyMessage={
                        selectedEventId
                          ? 'This event has no guest with a valid phone number yet.'
                          : 'Select an event first.'
                      }
                    />
                  </div>
                  {contactsError ? (
                    <p className="text-xs text-destructive mt-2">
                      The guest list could not be loaded: {contactsError}
                    </p>
                  ) : (
                    <p className="text-xs text-foreground/50 mt-2">
                      Each selected guest receives the approved template with their own name filled in.
                      PDF recipient extraction is not implemented yet.
                    </p>
                  )}
                </div>

                {isPreviewLoading && (
                  <p className="text-sm text-foreground/60">Loading the template preview...</p>
                )}

                {previewError && !isPreviewLoading && (
                  <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{previewError}</span>
                  </div>
                )}

                {templatePreview && !isPreviewLoading && (
                  <div className="rounded-lg border border-border bg-surface/50 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="text-sm font-semibold text-foreground">Values Meta will fill in</h4>
                      {templatePreview.templateStatus && (
                        <Badge variant={templatePreview.templateStatus === 'APPROVED' ? 'success' : 'warning'}>
                          {templatePreview.templateStatus}
                        </Badge>
                      )}
                    </div>
                    <div className="table-scroll">
                      <table className="w-full text-sm">
                        <tbody>
                          {templatePreview.variables.map((variable) => (
                            <tr key={variable.index} className="border-b border-border/60 last:border-0">
                              <td className="py-1.5 pr-3 text-foreground/40 whitespace-nowrap">{`{{${variable.index}}}`}</td>
                              <td className="py-1.5 pr-3 text-foreground/60 whitespace-nowrap">{variableLabel(variable.field)}</td>
                              <td className="py-1.5 text-foreground">{variable.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-foreground/50">
                      Preview for {templatePreview.recipient.fullName} ({templatePreview.recipient.phoneNumber})
                      {selectedContactIds.length > 1
                        ? ` — and ${selectedContactIds.length - 1} more guest${selectedContactIds.length > 2 ? 's' : ''}, each with their own name.`
                        : ''}
                    </p>
                    {templatePreview.bodySource === 'unavailable' && (
                      <p className="text-xs text-amber-400">
                        The approved wording could not be read from Meta, so the preview shows the values only.
                        The message itself is still rendered by Meta from the approved template.
                      </p>
                    )}
                    {templatePreview.placeholderMismatch && (
                      <p className="text-xs text-destructive">
                        The approved template expects a different number of values than this page fills, so
                        sending is blocked.
                      </p>
                    )}
                  </div>
                )}

                {templateError && (
                  <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{templateError}</span>
                  </div>
                )}

                {sendSummary && (
                  <div
                    className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                      sendSummary.tone === 'success'
                        ? 'border-emerald-500/30 bg-emerald-500/10'
                        : sendSummary.tone === 'partial'
                          ? 'border-amber-500/30 bg-amber-500/10'
                          : 'border-destructive/30 bg-destructive/10'
                    }`}
                  >
                    {sendSummary.tone === 'success' ? (
                      <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-emerald-400" />
                    ) : (
                      <AlertTriangle
                        className={`w-5 h-5 shrink-0 mt-0.5 ${
                          sendSummary.tone === 'partial' ? 'text-amber-400' : 'text-destructive'
                        }`}
                      />
                    )}
                    <div className="space-y-2 min-w-0 w-full">
                      <p
                        className={`text-sm font-medium ${
                          sendSummary.tone === 'success'
                            ? 'text-emerald-400'
                            : sendSummary.tone === 'partial'
                              ? 'text-amber-400'
                              : 'text-destructive'
                        }`}
                      >
                        {sendSummary.headline}
                      </p>

                      {sendSummary.sent.length > 0 && (
                        <ul className="space-y-1">
                          {sendSummary.sent.map((recipient) => (
                            <li key={recipient.contactId} className="text-xs text-foreground/60">
                              <span className="text-foreground/80">{recipient.fullName}</span> — {recipient.status}
                              <span className="font-mono break-all"> · {recipient.messageId}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {sendSummary.failed.length > 0 && (
                        <ul className="space-y-1">
                          {sendSummary.failed.map((recipient) => (
                            <li key={recipient.contactId} className="text-xs text-destructive">
                              <span className="font-medium">{recipient.fullName ?? 'Unknown guest'}</span> —{' '}
                              {recipient.reason}
                            </li>
                          ))}
                        </ul>
                      )}

                      <p className="text-xs text-foreground/50">
                        Delivery to each handset is confirmed later by the webhook, not by this response.
                      </p>
                      <button
                        type="button"
                        onClick={() => setLastSentKey(null)}
                        className="text-xs text-accent hover:underline"
                      >
                        Send again to this selection
                      </button>
                    </div>
                  </div>
                )}

                {sendBlockedReason(sendGate) && !isPreviewLoading && (
                  <p className="text-xs text-foreground/50">{sendBlockedReason(sendGate)}</p>
                )}

                <p className="flex items-center gap-2 text-xs text-foreground/40">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  The message is sent by the EventReach backend — WhatsApp credentials never reach the browser.
                </p>
              </div>
            )}

            {messageMode === 'custom' && (
            <>

            {/* History Section */}
            {history.length > 0 && (
              <div className="mb-6 space-y-4">
                <label className="block text-sm font-sans font-semibold text-foreground/80 mb-2">Previously Shared Messages</label>
                {history.map((item, idx) => (
                  <div key={`hist-box-${idx}`} className="bg-surface/50 border border-border rounded-lg p-4 opacity-80">
                    <div className="flex justify-between items-center mb-2">
                      <Badge variant="success">Sent</Badge>
                      <span className="text-xs text-foreground/50">{new Date(item.sentAt).toLocaleString()}</span>
                    </div>
                    {item.messageText && (
                      <p className="text-sm text-foreground whitespace-pre-wrap">{item.messageText}</p>
                    )}
                    {item.mediaAttachments && item.mediaAttachments.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.mediaAttachments.map((att: any, aIdx: number) => (
                          <div key={`hist-att-${aIdx}`} className="flex items-center gap-1 text-xs bg-black/20 dark:bg-white/10 px-2 py-1 rounded">
                            {att.type === 'image' ? <Image className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                            <span className="truncate max-w-[120px]">{att.filename}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div>
              <label className="block text-sm font-sans text-foreground/80 mb-2">Message Content</label>
              <textarea
                ref={textAreaRef}
                value={messageText}
                onChange={(e) => !isEventCompleted && setMessageText(e.target.value)}
                readOnly={isEventCompleted}
                className={`w-full h-48 rounded-md border border-border bg-background text-foreground p-3 text-sm focus:ring-2 focus:ring-white/20 outline-none resize-none transition-colors ${isEventCompleted ? 'opacity-60 cursor-not-allowed' : ''}`}
                placeholder="Type your WhatsApp message here..."
              />
            </div>

            {!isEventCompleted && (
            <div>
              <label className="block text-sm font-sans text-foreground/80 mb-2">Attachments</label>
              <div className="space-y-4">
                {attachments.length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {attachments.map((att, idx) => (
                      <div key={idx} className="relative group rounded-lg border border-border overflow-hidden bg-surface/50 flex flex-col items-center justify-center p-4">
                        {att.type === 'image' ? (
                          <Image className="w-8 h-8 text-accent mb-2" />
                        ) : (
                          <FileText className="w-8 h-8 text-accent mb-2" />
                        )}
                        <span className="text-xs text-center truncate w-full text-foreground/70" title={att.filename}>
                          {att.filename}
                        </span>
                        <button 
                          onClick={() => removeAttachment(idx)}
                          className="absolute top-1 right-1 p-1 bg-surfaceHover/80 hover:bg-destructive/10 text-foreground/50 hover:text-destructive rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="max-w-md">
                  <FileUpload 
                    onFileSelect={handleFileUpload} 
                    selectedFile={uploadFile}
                    onClear={() => setUploadFile(null)}
                    accept={{
                      'image/jpeg': ['.jpeg', '.jpg'],
                      'image/png': ['.png'],
                      'application/pdf': ['.pdf'],
                      'audio/mpeg': ['.mp3'],
                      'video/mp4': ['.mp4']
                    }}
                    // The real WhatsApp ceilings, from the same definition the
                    // upload endpoint enforces — so the UI can never promise a
                    // size the backend will refuse.
                    maxSize={WHATSAPP_MAX_ANY_BYTES}
                    perTypeMaxBytes={WHATSAPP_MEDIA_MAX_BYTES}
                    limitSummary={whatsAppMediaLimitSummary()}
                  />
                  {isUploading && (
                    <div className="mt-4 bg-surface border border-border rounded-lg p-4 animate-fade-in shadow-sm">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-sm text-foreground font-medium tracking-wide">Uploading... {uploadProgress}%</span>
                        <button 
                          onClick={cancelUpload}
                          className="text-foreground/40 hover:text-destructive transition-colors p-1.5 rounded-full hover:bg-destructive/10"
                          title="Cancel upload"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="w-full bg-black/10 dark:bg-white/10 rounded-full h-2.5 overflow-hidden">
                        <div 
                          className="bg-accent h-2.5 rounded-full transition-all duration-200 ease-out" 
                          style={{ width: uploadProgress + '%' }}
                        ></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            )} {/* end !isEventCompleted */}

            </>
            )} {/* end messageMode === 'custom' */}

          </div>
        </div>

        {/* Phone Preview */}
        <div className="lg:col-span-1 animate-fade-up stagger-2">
          <div className="sticky top-6">
            <h3 className="text-sm font-sans font-bold text-foreground/50 uppercase tracking-wider mb-4">Preview</h3>
            <div className="relative mx-auto border-gray-800 dark:border-gray-800 bg-gray-800 border-[8px] rounded-[2.5rem] h-[600px] w-[300px] shadow-xl">
              <div className="w-[148px] h-[18px] bg-gray-800 top-0 rounded-b-[1rem] left-1/2 -translate-x-1/2 absolute"></div>
              <div className="h-[46px] w-[3px] bg-gray-800 absolute -left-[11px] top-[124px] rounded-l-lg"></div>
              <div className="h-[46px] w-[3px] bg-gray-800 absolute -left-[11px] top-[178px] rounded-l-lg"></div>
              <div className="h-[64px] w-[3px] bg-gray-800 absolute -right-[11px] top-[142px] rounded-r-lg"></div>
              <div className="rounded-[2rem] overflow-hidden w-full h-full bg-[#EFEAE2] flex flex-col">
                
                {/* WA Header */}
                <div className="bg-[#075E54] text-white px-4 py-3 flex items-center space-x-3 pt-8">
                  <ArrowLeft className="w-5 h-5" />
                  <div className="flex-1">
                    <h4 className="font-semibold text-sm">
                      {messageMode === 'template' && templatePreview
                        ? templatePreview.recipient.fullName
                        : 'Guest Preview'}
                    </h4>
                    <p className="text-[10px] opacity-80">online</p>
                  </div>
                </div>

                {/* WA Chat Body */}
                <div className="flex-1 p-4 overflow-y-auto" style={{ backgroundImage: "url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')", backgroundSize: 'contain' }}>

                  {messageMode === 'template' ? (
                    /* The approved body as Meta holds it, with the resolved
                       values substituted. No wording is invented here: when the
                       body cannot be read, the values are listed instead. */
                    templatePreview ? (
                      <div className="bg-white p-2 rounded-lg shadow-sm w-[85%] float-left clear-both rounded-tl-none relative pb-6 text-[13px] text-slate-800 whitespace-pre-wrap">
                        {templatePreview.bodyText
                          ? renderTemplateBody(templatePreview.bodyText, templatePreview.variables)
                          : templatePreview.variables
                              .map((variable) => `${variableLabel(variable.field)}: ${variable.value}`)
                              .join('\n')}
                        <span className="absolute bottom-1 right-2 text-[10px] text-slate-400">
                          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ) : (
                      <div className="bg-white/80 p-2 rounded-lg shadow-sm w-[85%] float-left clear-both rounded-tl-none text-[12px] text-slate-500">
                        Select an event and at least one guest to preview the approved template.
                      </div>
                    )
                  ) : (
                  <>

                  {/* History Messages */}
                  {history.map((item, idx) => (
                    <div key={`wa-hist-${idx}`}>
                      {item.mediaAttachments && item.mediaAttachments.map((att: any, aIdx: number) => (
                        <div key={`wa-hist-att-${aIdx}`} className="bg-white p-1 rounded-lg shadow-sm w-[85%] mb-2 float-left clear-both rounded-tl-none opacity-90">
                          <div className="bg-slate-100 h-32 rounded flex items-center justify-center text-slate-400 mb-1">
                            {att.type === 'image' ? <Image className="w-8 h-8" /> : <FileText className="w-8 h-8" />}
                          </div>
                          <p className="text-xs text-slate-500 truncate px-1">{att.filename}</p>
                        </div>
                      ))}
                      {item.messageText && (
                        <div className="bg-white p-2 rounded-lg shadow-sm w-[85%] mb-4 float-left clear-both rounded-tl-none relative pb-6 text-[13px] text-slate-800 whitespace-pre-wrap opacity-90">
                          {item.messageText}
                          <span className="absolute bottom-1 right-2 text-[10px] text-slate-400">
                            {new Date(item.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Current Draft Messages */}
                  {attachments.map((att, idx) => (
                    <div key={idx} className="bg-white p-1 rounded-lg shadow-sm w-[85%] mb-2 float-left clear-both rounded-tl-none">
                      <div className="bg-slate-100 h-32 rounded flex items-center justify-center text-slate-400 mb-1">
                        {att.type === 'image' ? <Image className="w-8 h-8" /> : <FileText className="w-8 h-8" />}
                      </div>
                      <p className="text-xs text-slate-500 truncate px-1">{att.filename}</p>
                    </div>
                  ))}

                  {messageText && (
                    <div className="bg-white p-2 rounded-lg shadow-sm w-[85%] float-left clear-both rounded-tl-none relative pb-6 text-[13px] text-slate-800 whitespace-pre-wrap">
                      {getPreviewText()}
                      <span className="absolute bottom-1 right-2 text-[10px] text-slate-400">
                        {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}

                  </>
                  )}

                </div>

                {/* WA Input */}
                <div className="bg-[#f0f0f0] p-2 flex items-center space-x-2">
                  <div className="flex-1 bg-white rounded-full px-4 py-2 text-sm text-slate-400">Message</div>
                  <div className="w-10 h-10 bg-[#00A884] rounded-full flex items-center justify-center text-white">
                    <Plus className="w-5 h-5" />
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default Composer;




