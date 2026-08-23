import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, Plus, Phone, CheckCircle2, XCircle, AlertTriangle, Users, Trash2, Edit3 } from 'lucide-react';
import api from '../../services/api';
import type { Contact, Event } from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { EventSearch } from '../../components/ui/EventSearch';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const contactSchema = z.object({
  fullName: z.string().min(1, 'Name is required'),
  phoneNumber: z.string().min(1, 'Phone is required'),
  countryCode: z.string().min(1, 'Code required'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
});
type ContactForm = z.infer<typeof contactSchema>;

const ContactList = () => {
  const [searchParams] = useSearchParams();
  const selectedEventId = searchParams.get('eventId');
  const { showToast } = useToast();
  
  const [events, setEvents] = useState<Event[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activeEvent, setActiveEvent] = useState<string>(selectedEventId || '');
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [addError, setAddError] = useState('');

  const { register, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<ContactForm>({
    resolver: zodResolver(contactSchema),
    defaultValues: { countryCode: 'US' }
  });

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const response = await api.get('/events');
        setEvents(response.data);
        
      } catch (error) {
        console.error('Failed to fetch events', error);
      }
    };
    fetchEvents();
  }, []);

  useEffect(() => {
    const fetchContacts = async () => {
      
      setIsLoading(true);
      try {
        const response = await api.get(`/contacts/event/${activeEvent}`);
        setContacts(response.data);
      } catch (error) {
        console.error('Failed to fetch contacts', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchContacts();
  }, [activeEvent]);

  const onAddContact = async (data: ContactForm) => {
    try {
      setAddError('');
      const response = await api.post('/contacts', {
        ...data,
        eventId: activeEvent
      });
      setContacts([response.data, ...contacts]);
      setIsAddModalOpen(false);
      reset();
      showToast('success', 'Guest added successfully');
    } catch (err: any) {
      setAddError(err.response?.data?.error || 'Failed to add contact');
    }
  };

  const onEditContact = async (data: ContactForm) => {
    if (!editingContact) return;
    try {
      setAddError('');
      const response = await api.put(`/contacts/${editingContact._id}`, data);
      setContacts(contacts.map(c => c._id === editingContact._id ? response.data : c));
      setEditingContact(null);
      reset();
      showToast('success', 'Contact updated');
    } catch (err: any) {
      setAddError(err.response?.data?.error || 'Failed to update contact');
    }
  };

  const handleDelete = async (contactId: string) => {
    if (!window.confirm('Are you sure you want to delete this contact?')) return;
    try {
      await api.delete(`/contacts/${contactId}`);
      setContacts(contacts.filter(c => c._id !== contactId));
      showToast('success', 'Contact deleted');
    } catch (err) {
      showToast('error', 'Failed to delete contact');
    }
  };

  const openEditModal = (contact: Contact) => {
    setEditingContact(contact);
    setValue('fullName', contact.fullName);
    setValue('phoneNumber', contact.phoneNumber);
    setValue('countryCode', contact.countryCode);
    setValue('email', contact.email || '');
    setAddError('');
  };

  const filteredContacts = contacts.filter(c => 
    c.fullName.toLowerCase().includes(searchTerm.toLowerCase()) || 
    c.phoneNumber.includes(searchTerm)
  );

  const getStatusIcon = (status: string, reason?: string) => {
    if (status === 'Valid') return <span title="Valid Number"><CheckCircle2 className="w-5 h-5 text-emerald-500" /></span>;
    if (status === 'Duplicate') return <span title={reason || 'Duplicate'}><AlertTriangle className="w-5 h-5 text-amber-500" /></span>;
    return <span title={reason || 'Invalid Number'}><XCircle className="w-5 h-5 text-red-500" /></span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 animate-fade-in">
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Guest List</h2>
        
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="w-full sm:w-64 relative z-50"><EventSearch events={events} value={activeEvent} onChange={(val) => setActiveEvent(val)} placeholder="Select an Event..." allowClear={true} /></div>
          
          <Link to={`/contacts/import?eventId=${activeEvent}`}>
            <Button variant="secondary" disabled={!activeEvent}>
              Import from File
            </Button>
          </Link>
          
          <Button onClick={() => { setEditingContact(null); reset({ countryCode: 'US', fullName: '', phoneNumber: '', email: '' }); setIsAddModalOpen(true); }} disabled={!activeEvent}>
            <Plus className="w-4 h-4 mr-2" />
            Add Guest
          </Button>
        </div>
      </div>

      <div className="glass-panel rounded-3xl overflow-hidden flex flex-col min-h-[500px] animate-spring-up stagger-1">
        <div className="p-4 border-b border-border flex flex-col sm:flex-row justify-between gap-4">
          <div className="relative max-w-md w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
            <Input 
              placeholder="Search by name or phone..." 
              className="pl-9 bg-background"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="text-sm text-foreground/50 flex items-center font-medium">
            {contacts.length} contacts total
          </div>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-foreground/50">
            <Users className="w-12 h-12 text-foreground/20 mb-4" />
            <p>No guests found for this event.</p>
            <Button variant="secondary" className="mt-4" onClick={() => setIsAddModalOpen(true)}>
              Add First Guest
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="bg-black/5 dark:bg-white/5 text-foreground/60 text-xs uppercase tracking-wider font-medium border-b border-border">
                  <th className="py-3 px-4 w-12"></th>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">WhatsApp Number</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Added</th>
                  <th className="py-3 px-4 w-24">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredContacts.map((contact, idx) => (
                  <tr key={contact._id} className={`hover:bg-surfaceHover transition-colors group animate-fade-up stagger-${(idx % 5) + 1}`}>
                    <td className="py-3 px-4 text-center">
                      {getStatusIcon(contact.status, contact.validationReason)}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-foreground">{contact.fullName}</div>
                      {contact.email && <div className="text-xs text-foreground/50">{contact.email}</div>}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center text-sm text-foreground/80">
                        <Phone className="w-3.5 h-3.5 mr-1.5 text-foreground/40" />
                        {contact.phoneNumber}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={contact.status === 'Valid' ? 'success' : contact.status === 'Duplicate' ? 'warning' : 'error'}>
                        {contact.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-sm text-foreground/50">
                      {new Date(contact.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => openEditModal(contact)}
                          className="p-1.5 text-foreground/40 hover:text-accent hover:bg-accent/10 rounded transition-colors"
                          title="Edit"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(contact._id)}
                          className="p-1.5 text-foreground/40 hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Contact Modal */}
      {(isAddModalOpen || editingContact) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/40 backdrop-blur-md animate-fade-in">
          <div className="glass-panel rounded-3xl w-full max-w-md overflow-hidden animate-spring-up shadow-glass-lg">
            <div className="p-6 border-b border-white/10 flex justify-between items-center">
              <h3 className="text-xl font-sans font-bold text-foreground uppercase tracking-wider">
                {editingContact ? 'Edit Guest' : 'Add Guest Manually'}
              </h3>
              <button onClick={() => { setIsAddModalOpen(false); setEditingContact(null); reset(); }} className="text-foreground/50 hover:text-foreground transition-colors">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              {addError && (
                <div className="mb-4 p-3 bg-destructive/10 text-destructive text-sm rounded-md border border-destructive/20">
                  {addError}
                </div>
              )}
              <form onSubmit={handleSubmit(editingContact ? onEditContact : onAddContact)} className="space-y-4">
                <Input
                  label="Full Name"
                  placeholder="John Doe"
                  {...register('fullName')}
                  error={errors.fullName?.message}
                />
                
                <div className="flex gap-2">
                  <div className="w-1/3">
                    <label className="block text-sm font-sans text-foreground/80 mb-2">Country</label>
                    <select 
                      className="w-full rounded-md border border-border bg-surface/50 text-foreground px-3 py-2.5 text-sm focus:ring-2 focus:ring-white/20 outline-none transition-all duration-200"
                      {...register('countryCode')}
                    >
                      <option value="US">US (+1)</option>
                      <option value="GB">UK (+44)</option>
                      <option value="IN">IN (+91)</option>
                      <option value="AU">AU (+61)</option>
                    </select>
                  </div>
                  <div className="w-2/3">
                    <Input
                      label="WhatsApp Number"
                      placeholder="e.g. 555 123 4567"
                      {...register('phoneNumber')}
                      error={errors.phoneNumber?.message}
                    />
                  </div>
                </div>

                <Input
                  label="Email (Optional)"
                  placeholder="john@example.com"
                  {...register('email')}
                  error={errors.email?.message}
                />

                <div className="flex justify-end gap-3 mt-6">
                  <Button type="button" variant="ghost" onClick={() => { setIsAddModalOpen(false); setEditingContact(null); reset(); }}>
                    Cancel
                  </Button>
                  <Button type="submit" isLoading={isSubmitting}>
                    {editingContact ? 'Save Changes' : 'Add Guest'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContactList;


