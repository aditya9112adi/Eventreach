import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { Calendar, CalendarPlus, Edit3, Layers, MapPin, Search, X } from 'lucide-react';
import type { Event } from '@eventreach/shared';
import api from '../../services/api';
import { Button } from './Button';
import { Badge } from './Badge';
import { PaginationControls } from './PaginationControls';
import { ConfirmDeleteDialog, DeleteIconButton } from './DeleteControls';
import { useToast } from './Toast';
import { getPaginatedData, getSerialNumber } from '../../utils/pagination';
import { formatEventType } from '../../utils/eventType';
import { memberCountLabel } from '../../utils/subEventMembers';

/**
 * The Sub-Events of a Main Event (Haldi, Wedding Ceremony, Reception...), on
 * the Main Event's details page.
 *
 * Read from GET /events?parentEventId=, which the server authorizes against
 * the Main Event. What the buttons offer follows the roles the server allows -
 * creating and deleting are administrative, editing is open to whoever may
 * edit the event - but the server decides every request regardless.
 */

const statusBadge = (status: string) => {
  switch (status) {
    case 'Upcoming':  return <Badge variant="info">Upcoming</Badge>;
    case 'Completed': return <Badge variant="success">Completed</Badge>;
    case 'Cancelled': return <Badge variant="error">Cancelled</Badge>;
    default:          return <Badge>{status}</Badge>;
  }
};

interface SubEventsSectionProps {
  parent: Event;
  /** Admin or SuperAdmin: may create and delete sub-events. */
  canManage: boolean;
  /** Told the new count after a deletion, so the page can keep its own copy right. */
  onCountChange?: (count: number) => void;
}

export const SubEventsSection = ({ parent, canManage, onCountChange }: SubEventsSectionProps) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [subEvents, setSubEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchSubEvents = useCallback(async () => {
    setLoadError('');
    try {
      const res = await api.get('/events', { params: { parentEventId: parent._id } });
      setSubEvents(res.data);
      onCountChange?.(res.data.length);
    } catch (error: any) {
      setLoadError(error?.response?.data?.error || 'Failed to load sub-events.');
    } finally {
      setIsLoading(false);
    }
  }, [parent._id, onCountChange]);

  useEffect(() => { fetchSubEvents(); }, [fetchSubEvents]);

  const filtered = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();
    if (!q) return subEvents;
    return subEvents.filter((e) =>
      [e.eventId, e.eventName, e.eventType, e.eventDate, e.eventTime, e.eventVenue, e.eventStatus]
        .some((v) => (v || '').toLowerCase().includes(q))
    );
  }, [subEvents, searchTerm]);

  useEffect(() => { setCurrentPage(1); }, [searchTerm, rowsPerPage]);
  const pageRows = getPaginatedData(filtered, currentPage, rowsPerPage);

  const canCreate = canManage && parent.eventStatus === 'Upcoming';
  const toDelete = confirmDeleteId ? subEvents.find((e) => e._id === confirmDeleteId) ?? null : null;

  const confirmDelete = async () => {
    if (!confirmDeleteId || isDeleting) return;
    setIsDeleting(true);
    try {
      await api.delete(`/events/${confirmDeleteId}`);
      // Refetched rather than spliced out: the row goes once the server says so.
      await fetchSubEvents();
      showToast('success', 'Sub-event deleted successfully.');
      setConfirmDeleteId(null);
    } catch (error: any) {
      showToast('error', error?.response?.data?.error || 'Failed to delete sub-event.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <section aria-labelledby="sub-events-heading" className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up stagger-2">
      <div className="p-6 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 id="sub-events-heading" className="text-lg font-sans font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-5 h-5 text-foreground/50" /> Sub-Events
          </h3>
          <p className="text-sm text-foreground/50 mt-1">
            Each sub-event has its own date, venue and member list. Members are chosen per sub-event - nobody is added automatically.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => navigate(`/events/${parent._id}/sub-events/new`)}
            disabled={!canCreate}
            title={canCreate ? undefined : 'Sub-events can only be added to an upcoming event'}
            className="shrink-0"
          >
            <CalendarPlus className="w-4 h-4 mr-2" /> Create Sub-Event
          </Button>
        )}
      </div>

      {subEvents.length > 0 && (
        <div className="px-6 pt-4">
          <div className="relative max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-foreground/40" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search sub-events..."
              aria-label="Search sub-events"
              className="w-full bg-surface border border-border rounded-md pl-9 pr-8 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-accent"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center p-12" role="status" aria-label="Loading sub-events">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
        </div>
      ) : loadError ? (
        <div className="p-8 text-center space-y-3">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="secondary" onClick={() => { setIsLoading(true); fetchSubEvents(); }}>Try again</Button>
        </div>
      ) : subEvents.length === 0 ? (
        <div className="p-10 text-center space-y-2">
          <Layers className="w-10 h-10 mx-auto text-foreground/20" />
          <p className="font-semibold text-foreground">No sub-events yet</p>
          <p className="text-sm text-foreground/50 max-w-md mx-auto">
            {canCreate
              ? 'Add ceremonies such as Haldi, Mehendi or Reception, each with its own guest list.'
              : 'Sub-events of this event will appear here.'}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="p-8 text-center text-sm text-foreground/50">No sub-events match "{searchTerm}".</p>
      ) : (
        <>
          <div className="table-scroll mt-4">
            <table className="w-full min-w-[960px] text-left border-collapse">
              <thead>
                <tr className="bg-surfaceHover text-foreground/60 font-medium border-y border-border uppercase tracking-wide text-xs">
                  <th className="py-3 px-4 w-16 whitespace-nowrap">Sr No</th>
                  <th className="py-3 px-4">Event ID</th>
                  <th className="py-3 px-4">Sub-Event</th>
                  <th className="py-3 px-4">Date & Time</th>
                  <th className="py-3 px-4">Venue</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Members</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageRows.map((sub, index) => (
                  <tr key={sub._id} className="hover:bg-surfaceHover transition-colors">
                    <td className="py-3 px-4 text-sm text-foreground/50 tabular-nums">{getSerialNumber(currentPage, rowsPerPage, index)}</td>
                    <td className="py-3 px-4 text-sm font-mono text-foreground/70 whitespace-nowrap select-all">{sub.eventId || '—'}</td>
                    <td className="py-3 px-4">
                      <p className="font-medium text-foreground">{sub.eventName}</p>
                      <p className="text-xs text-foreground/50">{formatEventType(sub.eventType)}</p>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center text-sm text-foreground/80 whitespace-nowrap">
                        <Calendar className="w-3.5 h-3.5 mr-1.5 text-foreground/40" />
                        {sub.eventDate} at {sub.eventTime}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center text-sm text-foreground/80">
                        <MapPin className="w-3.5 h-3.5 mr-1.5 text-foreground/40" />
                        {sub.eventVenue}
                      </div>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">{statusBadge(sub.eventStatus)}</td>
                    <td className="py-3 px-4 text-sm text-foreground/80 whitespace-nowrap tabular-nums">{memberCountLabel(sub.memberCount)}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <Link to={`/events/${sub._id}`}>
                          <Button variant="secondary" className="text-xs py-1.5 px-3">View</Button>
                        </Link>
                        {sub.eventStatus !== 'Completed' && (
                          <Link to={`/events/${sub._id}/edit`} aria-label={`Edit sub-event ${sub.eventName}`} title="Edit Sub-Event">
                            <span className="inline-flex p-1.5 rounded-md text-foreground/40 hover:text-foreground hover:bg-surfaceHover transition-colors">
                              <Edit3 className="w-4 h-4" />
                            </span>
                          </Link>
                        )}
                        {canManage && (
                          <DeleteIconButton
                            onClick={() => setConfirmDeleteId(sub._id)}
                            title="Delete Sub-Event"
                            label={`Delete sub-event ${sub.eventId || sub.eventName}`}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            currentPage={currentPage}
            rowsPerPage={rowsPerPage}
            totalItems={filtered.length}
            onPageChange={setCurrentPage}
            onRowsChange={setRowsPerPage}
          />
        </>
      )}

      {/* Portalled, as the app's other dialogs are: the page wrapper's transform
          would otherwise pin `fixed` to the page instead of the window. */}
      {createPortal(
        <ConfirmDeleteDialog
          open={Boolean(confirmDeleteId)}
          title="Delete Sub-Event?"
          message={
            <>
              Delete{' '}
              <span className="font-semibold text-foreground">
                {toDelete ? `${toDelete.eventName}${toDelete.eventId ? ` (${toDelete.eventId})` : ''}` : 'this sub-event'}
              </span>
              ? Its member list is removed with it. The contacts themselves, the main event and the other sub-events are not changed. This cannot be undone.
            </>
          }
          confirmLabel="Delete"
          isDeleting={isDeleting}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmDeleteId(null)}
        />,
        document.body
      )}
    </section>
  );
};
