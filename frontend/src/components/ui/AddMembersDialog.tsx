import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, UserPlus, X, RotateCcw } from 'lucide-react';
import type { Event } from '@eventreach/shared';
import api from '../../services/api';
import { Button } from './Button';
import { Badge } from './Badge';
import { PaginationControls } from './PaginationControls';
import { RowSelectCheckbox, SelectAllCheckbox } from './DeleteControls';
import { useToast } from './Toast';
import { getPageSelectionState, toggleSelectAllOnPage, toggleSelection } from '../../utils/selection';
import {
  ADD_MEMBERS_BATCH_SIZE,
  chunkIds,
  describeOutcome,
  emptyOutcome,
  mergeBatchFailure,
  mergeBatchResponse,
  retryableIds,
  type AddMembersOutcome,
} from '../../utils/subEventMembers';

/**
 * Picks existing contacts for a Sub-Event's member list.
 *
 * The contacts offered are the server's (GET /events/:id/member-candidates):
 * those of the organizer's own events, the Main Event first. The table, its
 * row and page checkboxes and its pagination are the Contacts tab's; selection
 * is kept across pages and events here, because adding is not destructive and
 * a guest list is often built from several pages. Contacts already on this
 * sub-event's list are marked and cannot be picked twice; contacts on another
 * sub-event's list are offered like any other.
 *
 * The selection is sent in batches (utils/subEventMembers.ts) and the outcome
 * shown is what the server reported for every id - partial results are never
 * reported as complete, and ids that failed can be retried.
 */

interface Candidate {
  _id: string;
  fullName: string;
  phoneNumber: string;
  email?: string;
  status: string;
  isMember: boolean;
  sourceEvent: { _id: string; eventId?: string; eventName: string } | null;
}

interface SourceEvent {
  _id: string;
  eventId?: string;
  eventName: string;
}

interface AddMembersDialogProps {
  subEvent: Event;
  open: boolean;
  onClose: () => void;
  /** After any batch that changed the list: the page refreshes its members. */
  onAdded: (outcome: AddMembersOutcome) => void;
}

export const AddMembersDialog = ({ subEvent, open, onClose, onAdded }: AddMembersDialogProps) => {
  const { showToast } = useToast();
  const [sources, setSources] = useState<SourceEvent[]>([]);
  const [sourceEventId, setSourceEventId] = useState<string>(subEvent.parentEventId || '');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<AddMembersOutcome | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => { setCurrentPage(1); }, [debouncedSearch, sourceEventId, rowsPerPage]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setLoadError('');
      try {
        const res = await api.get(`/events/${subEvent._id}/member-candidates`, {
          params: {
            page: currentPage,
            limit: rowsPerPage,
            ...(sourceEventId ? { sourceEventId } : {}),
            ...(debouncedSearch ? { search: debouncedSearch } : {}),
          },
        });
        if (cancelled) return;
        setCandidates(res.data.data || []);
        setTotal(res.data.pagination?.total ?? 0);
        setSources(res.data.sources || []);
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.response?.data?.error || 'Failed to load contacts.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [open, subEvent._id, currentPage, rowsPerPage, sourceEventId, debouncedSearch, refreshToken]);

  // Escape closes, except while a request is in flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isAdding) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isAdding, onClose]);

  const selectableIds = useMemo(() => candidates.filter((c) => !c.isMember).map((c) => c._id), [candidates]);
  const { allSelected, someSelected } = getPageSelectionState(selected, selectableIds);

  const runAdd = useCallback(async (ids: string[]) => {
    if (isAdding || ids.length === 0) return;
    setIsAdding(true);
    setOutcome(null);
    const batches = chunkIds(ids, ADD_MEMBERS_BATCH_SIZE);
    let result = emptyOutcome();
    setProgress({ done: 0, total: batches.length });
    for (let i = 0; i < batches.length; i++) {
      try {
        const res = await api.post(`/events/${subEvent._id}/members`, { contactIds: batches[i] });
        result = mergeBatchResponse(result, res.data);
      } catch (error: any) {
        const body = error?.response?.data;
        // A refused batch still reports each id; only a batch with no answer
        // is recorded as failed as a whole.
        result = body && (Array.isArray(body.rejected) || Array.isArray(body.failed))
          ? mergeBatchResponse(result, body)
          : mergeBatchFailure(result, batches[i], body?.error || 'Could not reach the server. Try again.');
      }
      setProgress({ done: i + 1, total: batches.length });
    }
    setOutcome(result);
    setProgress(null);
    setIsAdding(false);
    // Whatever can usefully be sent again stays selected; the rest is done.
    setSelected(new Set(retryableIds(result)));
    const { tone, message } = describeOutcome(result);
    showToast(tone, message);
    if (result.added.length > 0) onAdded(result);
    setRefreshToken((t) => t + 1);
  }, [isAdding, subEvent._id, showToast, onAdded]);

  if (!open) return null;

  const summary = outcome ? describeOutcome(outcome) : null;
  const notAdded = outcome ? [...outcome.rejected, ...outcome.failed] : [];
  const retryIds = outcome ? retryableIds(outcome) : [];
  const nameOf = (id: string) => candidates.find((c) => c._id === id)?.fullName;

  // Portalled to <body>, as the app's other dialogs are: the page wrapper is
  // animated with a transform, which would otherwise pin `fixed` to the page.
  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-members-title"
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col animate-spring-up"
      >
        <div className="p-5 border-b border-border flex items-start justify-between gap-4">
          <div>
            <h3 id="add-members-title" className="text-xl font-bold text-foreground flex items-center gap-2">
              <UserPlus className="w-5 h-5" /> Add Members
            </h3>
            <p className="text-sm text-foreground/50 mt-1">
              Choose existing contacts for <span className="font-medium text-foreground/80">{subEvent.eventName}</span>. Only this sub-event's list changes.
            </p>
          </div>
          <button onClick={onClose} disabled={isAdding} aria-label="Close" className="p-1.5 rounded-md text-foreground/50 hover:text-foreground hover:bg-surfaceHover disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 flex flex-col sm:flex-row gap-3 border-b border-border">
          <label className="sm:w-72">
            <span className="block text-xs font-medium text-foreground/60 uppercase tracking-wide mb-1">Contacts from</span>
            <select
              value={sourceEventId}
              onChange={(e) => setSourceEventId(e.target.value)}
              className="w-full bg-surface border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
            >
              <option value="">All my events</option>
              {sources.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.eventId ? `${s.eventId} | ` : ''}{s.eventName}{s._id === subEvent.parentEventId ? ' (main event)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex-1">
            <span className="block text-xs font-medium text-foreground/60 uppercase tracking-wide mb-1">Search</span>
            <span className="relative block">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-foreground/40" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Name, phone or email..."
                className="w-full bg-surface border border-border rounded-md pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-accent"
              />
            </span>
          </label>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading && candidates.length === 0 ? (
            <div className="flex items-center justify-center p-12" role="status" aria-label="Loading contacts">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : loadError ? (
            <div className="p-8 text-center space-y-3">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button variant="secondary" onClick={() => setRefreshToken((t) => t + 1)}>Try again</Button>
            </div>
          ) : candidates.length === 0 ? (
            <p className="p-10 text-center text-sm text-foreground/50">
              {debouncedSearch ? `No contacts match "${debouncedSearch}".` : 'No contacts in this event yet. Add guests to the main event from the Contacts tab first.'}
            </p>
          ) : (
            <div className="table-scroll">
              <table className={`w-full min-w-[720px] text-left border-collapse ${isLoading ? 'opacity-60' : ''}`}>
                <thead>
                  <tr className="bg-surfaceHover text-foreground/60 font-medium border-b border-border uppercase tracking-wide text-xs">
                    <th className="py-3 px-4 w-10">
                      <SelectAllCheckbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onChange={() => setSelected((prev) => toggleSelectAllOnPage(prev, selectableIds))}
                        label="Select all contacts on this page"
                      />
                    </th>
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Phone</th>
                    <th className="py-3 px-4">Event</th>
                    <th className="py-3 px-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {candidates.map((c) => (
                    <tr key={c._id} className={c.isMember ? 'opacity-60' : 'hover:bg-surfaceHover transition-colors'}>
                      <td className="py-2.5 px-4">
                        {c.isMember ? (
                          <input type="checkbox" checked disabled aria-label={`${c.fullName} is already a member`} className="rounded border-border opacity-50" />
                        ) : (
                          <RowSelectCheckbox
                            checked={selected.has(c._id)}
                            onChange={() => setSelected((prev) => toggleSelection(prev, c._id))}
                            label={`Select ${c.fullName}`}
                          />
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-sm font-medium text-foreground">
                        {c.fullName}
                        {c.isMember && <Badge variant="success" className="ml-2">Member</Badge>}
                      </td>
                      <td className="py-2.5 px-4 text-sm text-foreground/80 whitespace-nowrap">{c.phoneNumber}</td>
                      <td className="py-2.5 px-4 text-sm text-foreground/60">{c.sourceEvent?.eventName ?? '—'}</td>
                      <td className="py-2.5 px-4 text-xs text-foreground/60 uppercase">{c.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <PaginationControls
            currentPage={currentPage}
            rowsPerPage={rowsPerPage}
            totalItems={total}
            onPageChange={setCurrentPage}
            onRowsChange={setRowsPerPage}
          />
        </div>

        {outcome && summary && (
          <div
            role="status"
            className={`mx-5 mt-4 rounded-md border px-4 py-3 text-sm ${
              summary.tone === 'success' ? 'border-accent/30 bg-accent/5 text-foreground'
                : summary.tone === 'info' ? 'border-blue-500/30 bg-blue-500/5 text-foreground'
                : summary.tone === 'warning' ? 'border-amber-500/30 bg-amber-500/5 text-foreground'
                : 'border-destructive/30 bg-destructive/5 text-foreground'
            }`}
          >
            <p className="font-medium">{summary.message}</p>
            {notAdded.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-foreground/70 max-h-24 overflow-y-auto">
                {notAdded.slice(0, 20).map((issue) => (
                  <li key={issue.id}>{nameOf(issue.id) ?? issue.id}: {issue.reason}</li>
                ))}
                {notAdded.length > 20 && <li>…and {notAdded.length - 20} more.</li>}
              </ul>
            )}
          </div>
        )}

        <div className="p-5 flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3">
          <span className="text-sm text-foreground/60" aria-live="polite">
            {progress ? `Adding… batch ${progress.done} of ${progress.total}` : `${selected.size} selected`}
          </span>
          <div className="flex gap-3 justify-end">
            <Button variant="secondary" onClick={onClose} disabled={isAdding}>
              {outcome ? 'Done' : 'Cancel'}
            </Button>
            {retryIds.length > 0 && !isAdding && (
              <Button variant="secondary" onClick={() => runAdd(retryIds)}>
                <RotateCcw className="w-4 h-4 mr-2" /> Retry failed ({retryIds.length})
              </Button>
            )}
            <Button onClick={() => runAdd(Array.from(selected))} disabled={selected.size === 0} isLoading={isAdding}>
              <UserPlus className="w-4 h-4 mr-2" /> Add {selected.size > 0 ? selected.size : ''} Selected
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
