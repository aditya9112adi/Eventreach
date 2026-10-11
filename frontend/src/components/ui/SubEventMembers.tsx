import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSpreadsheet, FileText, Search, UserMinus, UserPlus, Users, X } from 'lucide-react';
import type { Event } from '@eventreach/shared';
import api from '../../services/api';
import { Button } from './Button';
import { PaginationControls } from './PaginationControls';
import { ConfirmDeleteDialog } from './DeleteControls';
import { AddMembersDialog } from './AddMembersDialog';
import { useToast } from './Toast';
import { getSerialNumber } from '../../utils/pagination';
import { formatDateTime } from '../../utils/datetime';
import { buildReportFileName, exportToExcel, exportToPdf } from '../../utils/reportExport';
import { MEMBER_EXPORT_COLUMNS, buildMemberExportMeta, memberCountLabel, type SubEventMember as Member } from '../../utils/subEventMembers';

/**
 * A Sub-Event's member list, on its details page: the contacts chosen for this
 * sub-event alone (GET /events/:id/members), with adding, removing and an
 * Excel/PDF download of exactly this list.
 *
 * Removing a member takes the contact off this list only; the contact, its
 * Main Event's guest list and every other sub-event's list are untouched.
 */

interface SubEventMembersProps {
  subEvent: Event;
  /** Told the new count after every change, for the page header. */
  onCountChange?: (count: number) => void;
}

export const SubEventMembers = ({ subEvent, onCountChange }: SubEventMembersProps) => {
  const { showToast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [total, setTotal] = useState(0);
  const [memberCount, setMemberCount] = useState<number>(subEvent.memberCount ?? 0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);

  // Adding is offered on the same terms as adding guests on the Contacts tab.
  const canAdd = subEvent.eventStatus !== 'Completed';

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);
  useEffect(() => { setCurrentPage(1); }, [debouncedSearch, rowsPerPage]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setLoadError('');
      try {
        const res = await api.get(`/events/${subEvent._id}/members`, {
          params: { page: currentPage, limit: rowsPerPage, ...(debouncedSearch ? { search: debouncedSearch } : {}) },
        });
        if (cancelled) return;
        setMembers(res.data.data || []);
        setTotal(res.data.pagination?.total ?? 0);
        setMemberCount(res.data.memberCount ?? 0);
        onCountChange?.(res.data.memberCount ?? 0);
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.response?.data?.error || 'Failed to load members.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [subEvent._id, currentPage, rowsPerPage, debouncedSearch, refreshToken, onCountChange]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  const removeMember = async () => {
    if (!confirmRemove || isRemoving) return;
    setIsRemoving(true);
    try {
      await api.delete(`/events/${subEvent._id}/members/${confirmRemove._id}`);
      showToast('success', `${confirmRemove.fullName} removed from ${subEvent.eventName}.`);
      setConfirmRemove(null);
      refresh();
    } catch (error: any) {
      showToast('error', error?.response?.data?.error || 'Failed to remove member.');
    } finally {
      setIsRemoving(false);
    }
  };

  /** Downloads the members matching the search, read fresh from the server. */
  const runExport = async (format: 'excel' | 'pdf') => {
    if (exporting) return;
    setExporting(format);
    try {
      const res = await api.get(`/events/${subEvent._id}/members`, {
        params: debouncedSearch ? { search: debouncedSearch } : {},
      });
      const rows: Member[] = Array.isArray(res.data) ? res.data : [];
      if (rows.length === 0) {
        showToast('warning', 'There are no members to download.');
        return;
      }
      const name = buildReportFileName('SubEventMembers', subEvent.eventId || subEvent.eventName);
      const meta = buildMemberExportMeta(subEvent, debouncedSearch, rows);
      if (format === 'excel') await exportToExcel(name, 'Sub-Event Members', MEMBER_EXPORT_COLUMNS, rows, meta);
      else await exportToPdf(name, 'Sub-Event Members', MEMBER_EXPORT_COLUMNS, rows, meta);
    } catch (error: any) {
      showToast('error', error?.response?.data?.error || 'Failed to download the member list.');
    } finally {
      setExporting(null);
    }
  };

  return (
    <section aria-labelledby="members-heading" className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up stagger-2">
      <div className="p-6 border-b border-border flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 id="members-heading" className="text-lg font-sans font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
            <Users className="w-5 h-5 text-foreground/50" /> Members
            <span className="text-sm font-medium normal-case tracking-normal text-foreground/50">({memberCountLabel(memberCount)})</span>
          </h3>
          <p className="text-sm text-foreground/50 mt-1">
            Only the contacts on this list belong to this sub-event. Adding or removing here does not change the main event or any other sub-event.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button variant="secondary" onClick={() => runExport('excel')} isLoading={exporting === 'excel'} disabled={memberCount === 0 || Boolean(exporting)} className="text-xs px-3 py-2">
            <FileSpreadsheet className="w-4 h-4 mr-1.5" /> Excel
          </Button>
          <Button variant="secondary" onClick={() => runExport('pdf')} isLoading={exporting === 'pdf'} disabled={memberCount === 0 || Boolean(exporting)} className="text-xs px-3 py-2">
            <FileText className="w-4 h-4 mr-1.5" /> PDF
          </Button>
          <Button
            onClick={() => setIsAddOpen(true)}
            disabled={!canAdd}
            title={canAdd ? undefined : 'Members cannot be added to a completed event'}
            className="text-xs px-4 py-2"
          >
            <UserPlus className="w-4 h-4 mr-1.5" /> Add Members
          </Button>
        </div>
      </div>

      {memberCount > 0 && (
        <div className="px-6 pt-4">
          <div className="relative max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-foreground/40" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search members..."
              aria-label="Search members"
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

      {isLoading && members.length === 0 ? (
        <div className="flex items-center justify-center p-12" role="status" aria-label="Loading members">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
        </div>
      ) : loadError ? (
        <div className="p-8 text-center space-y-3">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="secondary" onClick={refresh}>Try again</Button>
        </div>
      ) : memberCount === 0 ? (
        <div className="p-10 text-center space-y-2">
          <Users className="w-10 h-10 mx-auto text-foreground/20" />
          <p className="font-semibold text-foreground">No members yet</p>
          <p className="text-sm text-foreground/50 max-w-md mx-auto">
            This sub-event starts with an empty list. Use Add Members to choose contacts from the main event or your other events.
          </p>
        </div>
      ) : members.length === 0 ? (
        <p className="p-8 text-center text-sm text-foreground/50">No members match "{debouncedSearch}".</p>
      ) : (
        <>
          <div className="table-scroll mt-4">
            <table className={`w-full min-w-[880px] text-left border-collapse ${isLoading ? 'opacity-60' : ''}`}>
              <thead>
                <tr className="bg-surfaceHover text-foreground/60 font-medium border-y border-border uppercase tracking-wide text-xs">
                  <th className="py-3 px-4 w-16 whitespace-nowrap">Sr No</th>
                  <th className="py-3 px-4">Full Name</th>
                  <th className="py-3 px-4">Phone</th>
                  <th className="py-3 px-4">Email</th>
                  <th className="py-3 px-4">Added From</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Added On</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.map((m, index) => (
                  <tr key={m._id} className="hover:bg-surfaceHover transition-colors">
                    <td className="py-3 px-4 text-sm text-foreground/50 tabular-nums">{getSerialNumber(currentPage, rowsPerPage, index)}</td>
                    <td className="py-3 px-4 text-sm font-medium text-foreground">{m.fullName}</td>
                    <td className="py-3 px-4 text-sm text-foreground/80 whitespace-nowrap">{m.phoneNumber}</td>
                    <td className="py-3 px-4 text-sm text-foreground/70">{m.email || '—'}</td>
                    <td className="py-3 px-4 text-sm text-foreground/70">{m.sourceEvent?.eventName ?? '—'}</td>
                    <td className="py-3 px-4 text-xs text-foreground/60 uppercase">{m.status}</td>
                    <td className="py-3 px-4 text-sm text-foreground/70 whitespace-nowrap">{formatDateTime(m.addedAt, '—')}</td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => setConfirmRemove(m)}
                        title="Remove from this sub-event"
                        aria-label={`Remove ${m.fullName} from ${subEvent.eventName}`}
                        className="p-1.5 rounded-md text-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <UserMinus className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            currentPage={currentPage}
            rowsPerPage={rowsPerPage}
            totalItems={total}
            onPageChange={setCurrentPage}
            onRowsChange={setRowsPerPage}
          />
        </>
      )}

      <AddMembersDialog subEvent={subEvent} open={isAddOpen} onClose={() => setIsAddOpen(false)} onAdded={refresh} />

      {/* Portalled, as the app's other dialogs are (see AddMembersDialog). */}
      {createPortal(
        <ConfirmDeleteDialog
          open={Boolean(confirmRemove)}
          title="Remove Member?"
          message={
            <>
              Remove <span className="font-semibold text-foreground">{confirmRemove?.fullName}</span> from {subEvent.eventName}?
              The contact is not deleted and stays on the main event and any other sub-event.
            </>
          }
          confirmLabel="Remove"
          busyLabel="Removing…"
          isDeleting={isRemoving}
          onConfirm={removeMember}
          onCancel={() => setConfirmRemove(null)}
        />,
        document.body
      )}
    </section>
  );
};
