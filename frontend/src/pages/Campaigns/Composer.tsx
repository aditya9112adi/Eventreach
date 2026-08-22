import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Save, Send, Image, FileText, Plus, X } from 'lucide-react';
import api from '../../services/api';
import type { Event, MediaAttachment } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { EventSearch } from '../../components/ui/EventSearch';
import { FileUpload } from '../../components/ui/FileUpload';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';

const Composer = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultEventId = searchParams.get('eventId') || '';
  const { showToast } = useToast();

  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>(defaultEventId);
  const [messageText, setMessageText] = useState('');
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

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
        }
      } catch (err) {
        console.error('Failed to fetch campaign', err);
      }
    };
    fetchCampaign();
  }, [selectedEventId]);


  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await api.post('/campaigns/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setAttachments(prev => [...prev, response.data]);
      setUploadFile(null);
    } catch (error) {
      console.error('Upload failed', error);
      showToast('error', 'Failed to upload file');
    } finally {
      setIsUploading(false);
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

  const getPreviewText = () => {
    let preview = messageText;
    preview = preview.replace(/{{fullName}}/g, 'John Doe');
    preview = preview.replace(/{{eventName}}/g, events.find(e => e._id === selectedEventId)?.name || 'The Event');
    preview = preview.replace(/{{venue}}/g, events.find(e => e._id === selectedEventId)?.venue || 'The Venue');
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
          <Button variant="secondary" onClick={handleSave} isLoading={isSaving} disabled={isSending}>
            <Save className="w-4 h-4 mr-2" /> Save Draft
          </Button>
          <Button onClick={handleSend} isLoading={isSending} disabled={!selectedEventId || !messageText || isSaving}>
            <Send className="w-4 h-4 mr-2" /> Proceed to Send
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Editor Area */}
        <div className="lg:col-span-2 space-y-6 animate-fade-up stagger-1">
          <div className="bg-surface rounded-xl border border-border p-6 space-y-6">
            <div>
              <label className="block text-sm font-sans text-foreground/80 mb-2">Target Event</label>
              <div className="w-full max-w-md relative z-20"><EventSearch events={events} value={selectedEventId} onChange={(val) => setSelectedEventId(val)} placeholder="Select an Event..." allowClear={false} /></div>
            </div>


            <div>
              <label className="block text-sm font-sans text-foreground/80 mb-2">Message Content</label>
              <textarea
                ref={textAreaRef}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                className="w-full h-48 rounded-md border border-border bg-background text-foreground p-3 text-sm focus:ring-2 focus:ring-white/20 outline-none resize-none transition-colors"
                placeholder="Type your WhatsApp message here..."
              />
            </div>

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
                  />
                  {isUploading && <p className="text-sm text-accent mt-2 animate-pulse">Uploading...</p>}
                </div>
              </div>
            </div>

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
                    <h4 className="font-semibold text-sm">Guest Preview</h4>
                    <p className="text-[10px] opacity-80">online</p>
                  </div>
                </div>

                {/* WA Chat Body */}
                <div className="flex-1 p-4 overflow-y-auto" style={{ backgroundImage: "url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')", backgroundSize: 'contain' }}>
                  
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
                      <span className="absolute bottom-1 right-2 text-[10px] text-slate-400">12:00 PM</span>
                    </div>
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

