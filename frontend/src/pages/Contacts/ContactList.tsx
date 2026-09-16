import { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { motion } from 'framer-motion';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, Plus, Phone, CheckCircle2, XCircle, AlertTriangle, Users, Edit3, X, ChevronRight, ChevronLeft } from 'lucide-react';
import api from '../../services/api';
import type { Contact, Event } from '@eventreach/shared';
import {
  COUNTRY_OPTIONS,
  DEFAULT_COUNTRY_CODE,
  INDIA_E164_LENGTH,
  INDIA_MOBILE_DIGITS,
  indianSubscriberLength,
  normalizeIndianMobile,
} from '@eventreach/shared';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../store/authStore';
import { PaginationControls } from '../../components/ui/PaginationControls';
import {
  SelectAllCheckbox,
  RowSelectCheckbox,
  DeleteIconButton,
  BulkDeleteBar,
  ConfirmDeleteDialog,
} from '../../components/ui/DeleteControls';
import { getSerialNumber } from '../../utils/pagination';
import { getPageSelectionState, toggleSelectAllOnPage, toggleSelection } from '../../utils/selection';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { EventSearch } from '../../components/ui/EventSearch';

const contactSchema = z.object({
  fullName: z.string().min(1, 'Name is required').max(50, 'Full name must be at most 50 characters'),
  // Accepts 9876543210, +919876543210 or 919876543210 and rejects a doubled
  // country code or a non-Indian number — the same rule the server applies.
  phoneNumber: z.string().superRefine((value, ctx) => {
    const result = normalizeIndianMobile(value);
    if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
  }),
  countryCode: z.string().min(1, 'Code required'),
  email: z.string()
    .optional()
    .or(z.literal(''))
    .refine(
      (val) => !val || /^[^@]{1,50}@gmail\.com$/.test(val),
      { message: 'Only @gmail.com emails allowed' }
    ),
});
type ContactForm = z.infer<typeof contactSchema>;

/** `value` may be the raw text, or a pre-computed count where the visible
 *  characters and the countable ones differ (a phone number's country code). */
const CharCount = ({ value, max }: { value: string | number | undefined; max: number }) => {
  const len = typeof value === 'number' ? value : value?.length ?? 0;
  const atLimit = len >= max;
  return (
    <p className={`mt-1 text-xs text-right ${atLimit ? 'text-destructive font-semibold' : 'text-foreground/40'}`}>
      {len}/{max}{atLimit ? ' — limit reached' : ''}
    </p>
  );
};

const ContactList = () => {
  const [searchParams] = useSearchParams();
  const initialEventId = searchParams.get('eventId');
  const openAddModal = searchParams.get('add') === 'true';
  const { showToast } = useToast();
  const { user } = useAuth();
  /**
   * Deleting guests is administrative, matching the Events list. The server
   * refuses a User with 403 on both delete endpoints regardless; this only
   * avoids offering controls that could never succeed.
   */
  const canDelete = user?.role !== 'User';
  
  const [events, setEvents] = useState<Event[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  // Total across the whole result set, reported by the server, not the page length.
  const [totalContacts, setTotalContacts] = useState(0);
  // Bumped to re-run the contact fetch after an add, edit or delete.
  const [refreshToken, setRefreshToken] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  
  // Active event selected via EventSearch dropdown
  const [activeEventId, setActiveEventId] = useState<string>(initialEventId || '');
  
  const [isAddModalOpen, setIsAddModalOpen] = useState(openAddModal);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [addError, setAddError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Selection is scoped to the page on screen, as on the Events list, and
  // cleared whenever that page changes (see the effect below).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  // Disables the confirm buttons while a request is in flight, so a double
  // click cannot send a second deletion.
  const [isDeleting, setIsDeleting] = useState(false);

  const activeEvent = events.find(e => e._id === activeEventId) || null;

  // Derive whether the currently selected event is completed
  const isEventCompleted = activeEvent?.eventStatus === 'Completed';

  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = useForm<ContactForm>({
    resolver: zodResolver(contactSchema),
    defaultValues: { countryCode: DEFAULT_COUNTRY_CODE }
  });

  const [wFullName, wPhone, wEmail] = watch(['fullName', 'phoneNumber', 'email']);

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

  // Typing used to filter an already-downloaded list; it now queries the
  // server, so wait for a pause before asking.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    let cancelled = false;

    const fetchContacts = async () => {
      setIsLoading(true);
      try {
        const endpoint = activeEventId ? `/contacts/event/${activeEventId}` : '/contacts';
        // Only this page is fetched. Passing page/limit opts into the
        // paginated response shape; callers that omit them still get an array.
        const response = await api.get(endpoint, {
          params: {
            page: currentPage,
            limit: rowsPerPage,
            ...(debouncedSearch ? { search: debouncedSearch } : {}),
          },
        });
        if (cancelled) return;

        const payload = response.data;
        if (Array.isArray(payload)) {
          // Defensive: an older backend would still return a bare array.
          setContacts(payload);
          setTotalContacts(payload.length);
        } else {
          setContacts(payload.data || []);
          setTotalContacts(payload.pagination?.total ?? 0);
        }
      } catch (error) {
        if (!cancelled) console.error('Failed to fetch contacts', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchContacts();
    return () => {
      cancelled = true;
    };
  }, [activeEventId, currentPage, rowsPerPage, debouncedSearch, refreshToken]);

  const onAddContact = async (data: ContactForm) => {
    if (!activeEvent) return;
    try {
      setAddError('');
      const response = await api.post('/contacts', {
        ...data,
        eventId: activeEvent._id
      });
      setRefreshToken((t) => t + 1);
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
      setRefreshToken((t) => t + 1);
      setEditingContact(null);
      reset();
      showToast('success', 'Contact updated');
    } catch (err: any) {
      setAddError(err.response?.data?.error || 'Failed to update contact');
    }
  };

  const handleDelete = (contactId: string) => {
    setConfirmDeleteId(contactId);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId || isDeleting) return;
    const id = confirmDeleteId;
    setIsDeleting(true);
    try {
      await api.delete(`/contacts/${id}`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // The list is re-fetched from the server rather than edited locally, so
      // the row only disappears once the server has confirmed it is gone.
      setRefreshToken((t) => t + 1);
      showToast('success', 'Guest deleted successfully.');
      setConfirmDeleteId(null);
    } catch (err: any) {
      // The dialog stays open on failure so the user can retry or cancel.
      showToast('error', err?.response?.data?.error || 'Failed to delete guest.');
    } finally {
      setIsDeleting(false);
    }
  };

  const confirmBulkDelete = async () => {
    if (isDeleting) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setIsDeleting(true);
    try {
      const res = await api.post('/contacts/bulk-delete', { ids });
      const deletedCount: number = res.data?.deletedCount ?? 0;
      const failedCount: number = res.data?.failed?.length ?? 0;

      setSelectedIds(new Set());
      setConfirmBulk(false);
      setRefreshToken((t) => t + 1);

      // Reported from what the server actually deleted, never from what was
      // selected, so a partial failure is not announced as a clean success.
      if (failedCount > 0) {
        showToast('warning', `${deletedCount} guest${deletedCount === 1 ? '' : 's'} deleted, ${failedCount} could not be deleted.`);
      } else {
        showToast('success', `${deletedCount} guest${deletedCount === 1 ? '' : 's'} deleted successfully.`);
      }
    } catch (err: any) {
      showToast('error', err?.response?.data?.error || 'Failed to delete the selected guests.');
    } finally {
      setIsDeleting(false);
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

  // The server already applied the search and returned just this page, so
  // these are pass-throughs kept under their original names.
  const filteredContacts = contacts;

  const totalPages = Math.ceil(totalContacts / rowsPerPage);
  const paginatedContacts = contacts;

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, activeEventId, rowsPerPage]);

  useEffect(() => {
    const totalPages = Math.ceil(totalContacts / rowsPerPage);
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [totalContacts, currentPage, rowsPerPage]);

  // ── Selection ──────────────────────────────────────────────────────────────

  // Any change to which guests are on screen clears the selection, so it can
  // never include a guest the user is no longer looking at.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [activeEventId, currentPage, rowsPerPage, debouncedSearch]);

  const pageIds = useMemo(() => paginatedContacts.map((c) => c._id), [paginatedContacts]);
  const { allSelected: allPageSelected, someSelected: somePageSelected } = useMemo(
    () => getPageSelectionState(selectedIds, pageIds),
    [selectedIds, pageIds]
  );
  const toggleSelectAll = () => setSelectedIds((prev) => toggleSelectAllOnPage(prev, pageIds));
  const toggleOne = (id: string) => setSelectedIds((prev) => toggleSelection(prev, id));

  // Looked up so the confirmation names the guest rather than saying "this contact".
  const contactToDelete = confirmDeleteId ? contacts.find((c) => c._id === confirmDeleteId) ?? null : null;

  const getStatusIcon = (status: string, reason?: string) => {
    if (status === 'Valid') return <span title="Valid Number"><CheckCircle2 className="w-5 h-5 text-emerald-500" /></span>;
    if (status === 'Duplicate') return <span title={reason || 'Duplicate'}><AlertTriangle className="w-5 h-5 text-amber-500" /></span>;
    return <span title={reason || 'Invalid Number'}><XCircle className="w-5 h-5 text-red-500" /></span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 animate-fade-in relative z-50">
        <div>
          <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Guest List</h2>
          {activeEvent && (
            <p className="text-xs text-foreground/50 mt-1 flex items-center gap-1">
              Showing:
              <span className="text-accent font-semibold">{activeEvent.eventName}</span>
            </p>
          )}
        </div>
        
        <div className="flex items-center gap-3 w-full sm:w-auto">
          {/* Event Search dropdown */}
          <div className="w-full sm:w-72 relative z-50">
            <EventSearch
              events={events}
              value={activeEventId}
              onChange={(id) => setActiveEventId(id)}
              placeholder="All Events (Search...)"
              allowClear={true}
            />
          </div>
          
          {isEventCompleted ? (
            <Button variant="secondary" disabled>
              Import from File
            </Button>
          ) : (
            <Link to={`/contacts/import?eventId=${activeEventId}`}>
              <Button variant="secondary" disabled={!activeEventId}>
                Import from File
              </Button>
            </Link>
          )}
          
          <Button
            disabled={isEventCompleted}
            onClick={() => { 
              if (!activeEvent) {
                showToast('error', 'Please select an Event from the search box first');
                return;
              }
              if (isEventCompleted) {
                showToast('error', 'This event has been completed. Adding contacts is no longer available.');
                return;
              }
              setEditingContact(null); 
              reset({ countryCode: DEFAULT_COUNTRY_CODE, fullName: '', phoneNumber: '', email: '' }); 
              setIsAddModalOpen(true); 
            }}>
            <Plus className="w-4 h-4 mr-2" />
            Add Guest
          </Button>
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

      <div className="glass-panel rounded-3xl overflow-hidden flex flex-col min-h-[500px] animate-spring-up stagger-1">
        <div className="p-4 border-b border-border flex flex-col sm:flex-row justify-between gap-4">
          <div className="relative max-w-md w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by name or phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-md border border-border bg-surface/50 pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/40 hover:border-border/80 transition-all duration-200"
            />
          </div>
          <div className="text-sm text-foreground/50 flex items-center font-medium">
            {totalContacts} contacts total
          </div>
        </div>

        {canDelete && selectedIds.size > 0 && (
          <div className="px-4 pt-4">
            <BulkDeleteBar count={selectedIds.size} noun="guest" onDelete={() => setConfirmBulk(true)} />
          </div>
        )}

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-foreground/50">
            <Users className="w-12 h-12 text-foreground/20 mb-4" />
            <p>No guests found for this event.</p>
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() => {
                // Match the main "Add Guest" button: clear any stale field
                // values and set the country back to the default before opening.
                setEditingContact(null);
                reset({ countryCode: DEFAULT_COUNTRY_CODE, fullName: '', phoneNumber: '', email: '' });
                setIsAddModalOpen(true);
              }}
            >
              Add First Guest
            </Button>
          </div>
        ) : (
          <div className="table-scroll flex-1">
            <table className="w-full text-left border-collapse min-w-[1000px]">
              <thead>
                <tr className="bg-black/5 dark:bg-white/5 text-foreground/60 text-xs uppercase tracking-wider font-medium border-b border-border">
                  {canDelete && (
                    <th className="py-3 px-4 w-10">
                      <SelectAllCheckbox
                        checked={allPageSelected}
                        indeterminate={somePageSelected}
                        onChange={toggleSelectAll}
                        label="Select all guests"
                      />
                    </th>
                  )}
                  <th className="py-3 px-4 w-20 whitespace-nowrap">Sr No</th>
                  <th className="py-3 px-4 w-12"></th>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">WhatsApp Number</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Added</th>
                  <th className="py-3 px-4 w-24">Actions</th>
                </tr>
              </thead>
              <motion.tbody
                className="divide-y divide-border"
                initial="hidden"
                animate="visible"
                variants={{ visible: { transition: { staggerChildren: 0.06 } } }}
              >
                {paginatedContacts.map((contact, index) => (
                  <motion.tr
                    key={contact._id}
                    variants={{
                      hidden: { opacity: 0, y: 12 },
                      visible: { opacity: 1, y: 0, transition: { duration: 0.28, ease: 'easeOut' } },
                    }}
                    className="hover:bg-surfaceHover transition-colors group"
                  >
                    {canDelete && (
                      <td className="py-3 px-4">
                        <RowSelectCheckbox
                          checked={selectedIds.has(contact._id)}
                          onChange={() => toggleOne(contact._id)}
                          label={`Select guest ${contact.fullName}`}
                        />
                      </td>
                    )}
                    {/* The server returns this page already searched and
                        ordered, so its index plus the page offset is the
                        guest's position in the whole result. */}
                    <td className="py-3 px-4 text-sm text-foreground/50 tabular-nums whitespace-nowrap">
                      {getSerialNumber(currentPage, rowsPerPage, index)}
                    </td>
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
                      <div className="flex items-center space-x-1 transition-opacity">
                        <button
                          onClick={() => openEditModal(contact)}
                          className="p-1.5 text-foreground/40 hover:text-accent hover:bg-accent/10 rounded transition-colors"
                          title="Edit"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        {canDelete && (
                          <DeleteIconButton
                            onClick={() => handleDelete(contact._id)}
                            title="Delete Guest"
                            label={`Delete guest ${contact.fullName}`}
                          />
                        )}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )}
        
        {/* Pagination Controls */}
        {!isLoading && filteredContacts.length > 0 && (
          <PaginationControls
            currentPage={currentPage}
            rowsPerPage={rowsPerPage}
            totalItems={totalContacts}
            onPageChange={setCurrentPage}
            onRowsChange={setRowsPerPage}
          />
        )}
      </div>

      {/* Add / Edit Contact Modal */}
      {(isAddModalOpen || editingContact) && ReactDOM.createPortal(
        <div className="fixed top-0 left-0 w-screen h-screen z-50 flex items-center justify-center p-4 bg-background/40 backdrop-blur-md animate-fade-in">
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
                <div>
                  <Input
                    label="Full Name"
                    placeholder="John Doe"
                    maxLength={50}
                    {...register('fullName')}
                    error={errors.fullName?.message}
                  />
                  <CharCount value={wFullName} max={50} />
                </div>
                
                <div className="flex gap-2">
                  <div className="w-1/3">
                    <label className="block text-sm font-sans text-foreground/80 mb-2">Country</label>
                    {/* India-only system: fixed rather than a one-item dropdown
                        that looks like a choice. The value still travels with
                        the form via the registered hidden input below. */}
                    <div
                      className="w-full rounded-md border border-border bg-surface/30 text-foreground/70 px-3 py-2.5 text-sm cursor-not-allowed select-none"
                      aria-label="Country"
                      title="This application sends only to Indian numbers"
                    >
                      {COUNTRY_OPTIONS[0].label}
                    </div>
                    <input type="hidden" {...register('countryCode')} value={DEFAULT_COUNTRY_CODE} />
                  </div>
                  <div className="w-2/3">
                    <Input
                      label="WhatsApp Number"
                      placeholder="9876543210"
                      /* 13 so "+919876543210" can actually be typed. It used to
                         be 10, which silently truncated a pasted +91 number. */
                      maxLength={INDIA_E164_LENGTH}
                      {...register('phoneNumber')}
                      error={errors.phoneNumber?.message}
                    />
                    {/* Counts the subscriber digits, not the raw string: with
                        the country code included the old counter read
                        "13/10 — limit reached" for a perfectly valid number. */}
                    <CharCount value={indianSubscriberLength(wPhone)} max={INDIA_MOBILE_DIGITS} />
                  </div>
                </div>

                <div>
                  <Input
                    label="Email (Optional)"
                    placeholder="john@gmail.com"
                    maxLength={60} // 50 for name + 10 for @gmail.com
                    {...register('email')}
                    error={errors.email?.message}
                  />
                  <CharCount value={wEmail} max={60} />
                </div>

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
        </div>,
        document.body
      )}

      {/* Same dialog as the Events list. Portalled because this page's panel
          establishes its own stacking context. */}
      {ReactDOM.createPortal(
        <>
          <ConfirmDeleteDialog
            open={Boolean(confirmDeleteId)}
            title="Delete Guest?"
            message={
              <>
                Are you sure you want to delete{' '}
                {contactToDelete ? (
                  <span className="font-semibold text-foreground">
                    {contactToDelete.fullName} ({contactToDelete.phoneNumber})
                  </span>
                ) : 'this guest'}
                ? They will be permanently removed from this event. This action cannot be undone.
              </>
            }
            confirmLabel="Delete"
            isDeleting={isDeleting}
            onConfirm={confirmDelete}
            onCancel={() => setConfirmDeleteId(null)}
          />
          <ConfirmDeleteDialog
            open={confirmBulk && selectedIds.size > 0}
            title="Delete Selected Guests?"
            message={`You are about to delete ${selectedIds.size} guest${selectedIds.size === 1 ? '' : 's'}. This action cannot be undone.`}
            confirmLabel={`Delete ${selectedIds.size} Guest${selectedIds.size === 1 ? '' : 's'}`}
            isDeleting={isDeleting}
            onConfirm={confirmBulkDelete}
            onCancel={() => setConfirmBulk(false)}
          />
        </>,
        document.body
      )}
    </div>
  );
};

export default ContactList;




