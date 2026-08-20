import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, XCircle, AlertTriangle, Upload } from 'lucide-react';
import api from '../../services/api';
import type { ExtractedContact, Event } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { FileUpload } from '../../components/ui/FileUpload';
import { useLoader } from '../../components/ui/FullScreenLoader';

const BulkImport = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultEventId = searchParams.get('eventId') || '';

  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>(defaultEventId);
  const [file, setFile] = useState<File | null>(null);
  
  const [isUploading, setIsUploading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  
  const [previewData, setPreviewData] = useState<ExtractedContact[]>([]);
  const [step, setStep] = useState<1 | 2>(1); // 1: Upload, 2: Preview & Confirm
  const { showLoader, showSuccess, showError, hideLoader } = useLoader();

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

  const handleUploadAndPreview = async () => {
    if (!file || !selectedEventId) return;

    setIsUploading(true);
    showLoader('Processing document...');
    setError('');
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('countryCode', 'US'); // could be dynamic

    try {
      const response = await api.post(`/contacts/event/${selectedEventId}/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      setPreviewData(response.data);
      hideLoader();
      setStep(2);
    } catch (err: any) {
      await showError(err.response?.data?.error || 'Failed to process file');
      setError(err.response?.data?.error || 'Failed to process file');
    } finally {
      setIsUploading(false);
    }
  };

  const handleConfirmImport = async () => {
    setIsImporting(true);
    showLoader('Importing contacts...');
    setError('');

    try {
      const response = await api.post(`/contacts/event/${selectedEventId}/import`, {
        contacts: previewData
      });
      await showSuccess(`Successfully imported ${response.data.importedCount} contacts.`);
      setSuccessMsg(`Successfully imported ${response.data.importedCount} contacts.`);
      setStep(1);
      setFile(null);
      setPreviewData([]);
    } catch (err: any) {
      if (err.response?.status === 207) {
        await showSuccess(err.response.data.message);
        setSuccessMsg(err.response.data.message);
        setStep(1);
        setFile(null);
        setPreviewData([]);
      } else {
        await showError(err.response?.data?.error || 'Failed to import contacts');
        setError(err.response?.data?.error || 'Failed to import contacts');
      }
    } finally {
      setIsImporting(false);
    }
  };

  const getStatusIcon = (status: string, reason?: string) => {
    if (status === 'Valid') return <span title="Valid Number"><CheckCircle2 className="w-5 h-5 text-emerald-500" /></span>;
    if (status === 'Duplicate') return <span title={reason || 'Duplicate'}><AlertTriangle className="w-5 h-5 text-amber-500" /></span>;
    return <span title={reason || 'Invalid Number'}><XCircle className="w-5 h-5 text-red-500" /></span>;
  };

  const removeFromPreview = (index: number) => {
    setPreviewData(prev => prev.filter((_, i) => i !== index));
  };

  const removeAllInvalid = () => {
    setPreviewData(prev => prev.filter(c => c.status !== 'Invalid'));
  };

  const removeAllDuplicates = () => {
    setPreviewData(prev => prev.filter(c => c.status !== 'Duplicate'));
  };

  const validCount = previewData.filter(c => c.status === 'Valid').length;
  const invalidCount = previewData.filter(c => c.status === 'Invalid').length;
  const duplicateCount = previewData.filter(c => c.status === 'Duplicate').length;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      
      <div className="flex items-center space-x-4 mb-2 animate-fade-in">
        <button 
          onClick={() => navigate('/contacts')}
          className="p-2 text-foreground/50 hover:text-foreground hover:bg-surfaceHover rounded-full transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Import Contacts</h2>
      </div>

      <div className="glass-panel rounded-3xl overflow-hidden animate-spring-up stagger-1">
        
        {step === 1 && (
          <div className="p-6 md:p-8 space-y-6 animate-fade-in">
            <h3 className="text-xl font-sans font-bold text-foreground uppercase tracking-wider">Step 1: Upload File</h3>
            
            {error && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 text-destructive rounded-md text-sm">
                {error}
              </div>
            )}
            
            {successMsg && (
              <div className="p-4 bg-accent/10 border border-accent/20 text-accent rounded-md text-sm">
                {successMsg}
              </div>
            )}

            <div>
              <label className="block text-sm font-sans text-foreground/80 mb-2">Target Event</label>
              <select 
                className="w-full max-w-md rounded-md border border-border bg-surface/50 text-foreground px-3 py-2.5 text-sm focus:ring-2 focus:ring-white/20 outline-none transition-all duration-200"
                value={selectedEventId}
                onChange={(e) => setSelectedEventId(e.target.value)}
              >
                <option value="" disabled>Select an Event</option>
                {events.map(e => (
                  <option key={e._id} value={e._id}>{e.name}</option>
                ))}
              </select>
            </div>

            <div className="pt-4">
              <label className="block text-sm font-sans text-foreground/80 mb-2">File</label>
              <FileUpload 
                onFileSelect={setFile} 
                selectedFile={file}
                onClear={() => setFile(null)}
                accept={{
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
                  'application/vnd.ms-excel': ['.xls'],
                  'application/pdf': ['.pdf']
                }}
              />
            </div>

            <div className="pt-6 border-t border-border flex justify-end">
              <Button 
                onClick={handleUploadAndPreview}
                disabled={!file || !selectedEventId}
                isLoading={isUploading}
              >
                Upload and Preview
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="p-6 md:p-8 space-y-6 flex flex-col h-[600px] animate-slide-in">
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-sans font-bold text-foreground uppercase tracking-wider">Step 2: Preview & Confirm</h3>
              <Button variant="ghost" onClick={() => setStep(1)}>
                Change File
              </Button>
            </div>
            
            <div className="flex space-x-4 mb-4">
              <Badge variant="success">Valid: {validCount}</Badge>
              <Badge variant="warning">Duplicates: {duplicateCount}</Badge>
              <Badge variant="error">Invalid: {invalidCount}</Badge>
              {duplicateCount > 0 && (
                <button onClick={removeAllDuplicates} className="text-xs text-amber-500 hover:text-amber-400 underline transition-colors">Remove All Duplicates</button>
              )}
              {invalidCount > 0 && (
                <button onClick={removeAllInvalid} className="text-xs text-destructive hover:text-red-400 underline transition-colors">Remove All Invalid</button>
              )}
            </div>

            {error && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 text-destructive rounded-md text-sm">
                {error}
              </div>
            )}

            <div className="flex-1 overflow-auto border border-border rounded-md">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-foreground/60 text-xs uppercase tracking-wider font-medium sticky top-0 shadow-sm border-b border-border">
                    <th className="py-2 px-4 w-10"></th>
                    <th className="py-2 px-4">Name</th>
                    <th className="py-2 px-4">Phone Number</th>
                    <th className="py-2 px-4">Status</th>
                    <th className="py-2 px-4 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {previewData.map((contact, idx) => (
                    <tr key={idx} className={contact.status !== 'Valid' ? 'bg-surface/50 opacity-80' : 'hover:bg-surfaceHover transition-colors'}>
                      <td className="py-2 px-4 text-center">
                        {getStatusIcon(contact.status, contact.validationReason)}
                      </td>
                      <td className="py-2 px-4 font-medium text-foreground">{contact.fullName}</td>
                      <td className="py-2 px-4 font-mono text-foreground/80">{contact.phoneNumber}</td>
                      <td className="py-2 px-4">
                        <span className={`text-xs ${contact.status === 'Valid' ? 'text-accent' : contact.status === 'Duplicate' ? 'text-amber-500' : 'text-destructive'}`}>
                          {contact.validationReason || 'Ready'}
                        </span>
                      </td>
                      <td className="py-2 px-4">
                        <button
                          onClick={() => removeFromPreview(idx)}
                          className="text-foreground/40 hover:text-destructive transition-colors p-1"
                          title="Remove"
                        >
                          <XCircle className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {previewData.length === 0 && (
                <div className="p-8 text-center text-foreground/50">
                  No contacts found in file.
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-border flex justify-between items-center">
              <p className="text-sm text-foreground/50">
                Only <strong className="text-accent">{validCount}</strong> valid contacts will be imported.
              </p>
              <Button 
                onClick={handleConfirmImport}
                disabled={validCount === 0}
                isLoading={isImporting}
              >
                <Upload className="w-4 h-4 mr-2" />
                Confirm Import
              </Button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default BulkImport;
