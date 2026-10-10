import { useEffect, useMemo, useState } from 'react';
import api from '../../services/api';
import { Badge } from './Badge';
import { PaginationControls } from './PaginationControls';
import { getPaginatedData, getSerialNumber } from '../../utils/pagination';
import type { ReportColumn } from '../../utils/reportExport';

/**
 * View for one event of the Access or Contact Report: the event's details,
 * then its records - laid out like the Event Report's own View, with the
 * same "Back to All Events" and the same table.
 *
 * The report's filters decide which events are listed. When the report was
 * searched by a name/username or a status, the View opens on this event's
 * records matching that search - the ones the row counted - with a switch to
 * every record of the event. Without such a search it shows every record, as
 * the event alone. Either way the records come from the report's existing
 * endpoint scoped to ?eventId=, so the server authorizes the event and returns
 * only its records; a refusal is shown as the server words it.
 */
interface ReportEventViewProps {
  eventId: string;
  eventName: string;
  /** The event's lines, worded as the Event Report table words them. */
  eventDetails: Array<[string, string]>;
  /** "Access Details" or "Contact Details". */
  title: string;
  endpoint: string;
  columns: ReportColumn<any>[];
  /** Adds what a record needs to be shown (a contact's event name). */
  decorate?: (row: any) => any;
  /**
   * The report's filters, as request parameters, when it was searched by a
   * name/username or a status: the View then opens on the matching records.
   * Left out, the View shows every record of the event.
   */
  matchParams?: Record<string, string>;
  statusVariant: (status: string) => string;
  onBack: () => void;
}

export const ReportEventView = ({
  eventId,
  eventName,
  eventDetails,
  title,
  endpoint,
  columns,
  decorate,
  matchParams,
  statusVariant,
  onBack,
}: ReportEventViewProps) => {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  /** Matching records first; this switches to every record of the event. */
  const [showAll, setShowAll] = useState(false);
  const matchKey = matchParams ? JSON.stringify(matchParams) : '';
  const showingMatches = Boolean(matchParams) && !showAll;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setCurrentPage(1);
    const params = showingMatches ? { ...JSON.parse(matchKey), eventId } : { eventId };
    api
      .get(endpoint, { params })
      .then((res) => {
        if (cancelled) return;
        setRows(Array.isArray(res.data) ? res.data : []);
        setStatus('success');
      })
      .catch((err) => {
        if (cancelled) return;
        setRows([]);
        setError(err?.response?.data?.error || 'Could not load this event. Please try again.');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, eventId, matchKey, showingMatches]);

  // Every record the event-scoped endpoint returned; none is filtered out here.
  const shown = useMemo(() => (decorate ? rows.map(decorate) : rows), [rows, decorate]);

  const paged = useMemo(() => getPaginatedData(shown, currentPage, rowsPerPage), [shown, currentPage, rowsPerPage]);

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider truncate">
          {eventName || 'Event'}
        </h3>
        <button
          onClick={onBack}
          className="text-accent hover:text-accent/80 font-medium text-sm transition-colors"
        >
          ← Back to All Events
        </button>
      </div>

      <div className="glass-panel rounded-2xl p-6">
        <h4 className="text-sm font-sans font-bold text-foreground/70 uppercase tracking-wider mb-4">Event Details</h4>
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          {eventDetails.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-foreground/50">{label}</dt>
              <dd className="text-foreground/80 break-words">{value || '-'}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="glass-panel rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">{title}</h3>
          <div className="flex flex-wrap items-center gap-3">
            {status === 'success' && (
              <span className="text-xs text-foreground/50">
                {showingMatches
                  ? `${shown.length} matching the report's filters`
                  : `${shown.length} ${matchParams ? 'records in all' : 'for this event'}`}
              </span>
            )}
            {matchParams && (
              <button
                type="button"
                onClick={() => setShowAll((all) => !all)}
                className="text-accent hover:text-accent/80 font-medium text-xs transition-colors"
              >
                {showAll ? 'Show only matching records' : 'Show all records'}
              </button>
            )}
          </div>
        </div>

        {status === 'loading' ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
          </div>
        ) : status === 'error' ? (
          <p className="text-destructive text-center py-8 text-sm font-medium">{error}</p>
        ) : shown.length === 0 ? (
          <p className="text-foreground/40 text-center py-8">
            {showingMatches ? 'No records for this event match the report\'s filters.' : 'No records for this event.'}
          </p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="w-full min-w-[870px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs whitespace-nowrap pr-4 w-20">Sr No</th>
                    {columns.map((column) => (
                      <th
                        key={column.header}
                        className="pb-3 font-semibold text-foreground/60 uppercase tracking-wide text-xs whitespace-nowrap pr-4"
                      >
                        {column.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paged.map((row: any, index: number) => (
                    <tr key={row._id} className="hover:bg-surfaceHover transition-colors group">
                      <td className="py-4 pr-4 text-foreground/50 tabular-nums whitespace-nowrap">{getSerialNumber(currentPage, rowsPerPage, index)}</td>
                      {columns.map((column) => {
                        const cell = String(column.value(row));
                        return (
                          <td key={column.header} className="py-4 pr-4 text-foreground/70 whitespace-nowrap">
                            {column.header === 'Status' ? <Badge variant={statusVariant(cell) as any}>{cell}</Badge> : cell}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationControls
              currentPage={currentPage}
              rowsPerPage={rowsPerPage}
              totalItems={shown.length}
              onPageChange={setCurrentPage}
              onRowsChange={(n) => {
                setRowsPerPage(n);
                setCurrentPage(1);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};
