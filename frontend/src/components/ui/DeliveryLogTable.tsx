import type { ReactNode } from 'react';
import { CheckCircle, Clock, Send, AlertTriangle } from 'lucide-react';
import { Badge } from './Badge';
import { getSerialNumber } from '../../utils/pagination';
import {
  DELIVERY_STATUS_FILTERS,
  describeDeliveryLog,
  deliveryStamp,
  type DeliveryLogRow,
} from '../../utils/deliveryLogReport';

/**
 * The Delivery Log table: one row per WhatsApp recipient, with the status
 * filter at the top right.
 *
 * Lifted out of the campaign report so the Event Report can show the very same
 * table rather than a second copy of it. It is presentational on purpose: the
 * caller fetches the rows and owns the filter, so the same markup serves a
 * campaign's own report and an event's.
 *
 * The status it prints is the milestone resolved from the stored fields
 * (describeDeliveryLog), and a timestamp that does not exist prints as a dash
 * - nothing here invents a value.
 */
interface DeliveryLogTableProps {
  logs: DeliveryLogRow[];
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  /** The card around the table. The campaign report spans two grid columns. */
  className?: string;
  title?: string;
  /** Shown in place of the rows when there are none. */
  emptyMessage?: string;
  /** Under the table: a note that the list is cut short, a retry link, etc. */
  footnote?: ReactNode;
}

export const DeliveryLogTable = ({
  logs,
  statusFilter,
  onStatusFilterChange,
  className = 'bg-surface rounded-xl border border-border p-6',
  title = 'Delivery Log',
  emptyMessage = 'No message logs found.',
  footnote,
}: DeliveryLogTableProps) => (
  <div className={className}>
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-lg font-sans font-bold text-foreground uppercase tracking-wider">{title}</h3>
      <select
        aria-label="Filter the delivery log by status"
        className="rounded-md border border-border bg-surface/50 text-foreground px-3 py-1.5 text-sm focus:ring-2 focus:ring-white/20 outline-none transition-colors"
        value={statusFilter}
        onChange={(e) => onStatusFilterChange(e.target.value)}
      >
        {DELIVERY_STATUS_FILTERS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>

    {/* The wide detail columns scroll inside the card; the page does not. */}
    <div className="table-scroll">
      <table className="w-full min-w-[1150px] text-sm">
        <thead>
          <tr className="border-b border-border text-left uppercase tracking-wide text-xs text-foreground/60">
            <th className="pb-3 pr-4 font-semibold w-20 whitespace-nowrap">Sr No</th>
            <th className="pb-3 font-semibold">Contact</th>
            <th className="pb-3 font-semibold">Phone</th>
            <th className="pb-3 font-semibold">Status</th>
            <th className="pb-3 font-semibold whitespace-nowrap">Accepted</th>
            <th className="pb-3 font-semibold whitespace-nowrap">Delivered</th>
            <th className="pb-3 font-semibold whitespace-nowrap">Read</th>
            <th className="pb-3 font-semibold whitespace-nowrap">Failed</th>
            <th className="pb-3 font-semibold">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {logs.length === 0 ? (
            <tr>
              <td colSpan={9} className="py-8 text-center text-foreground/40">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            logs.map((log, index) => {
              const state = describeDeliveryLog(log);
              return (
                <tr key={log._id ?? index} className="hover:bg-surfaceHover transition-colors">
                  {/* The report loads only the first page of logs, so this is page 1. */}
                  <td className="py-3 pr-4 text-foreground/50 tabular-nums whitespace-nowrap">{getSerialNumber(1, logs.length, index)}</td>
                  <td className="py-3 font-medium text-foreground whitespace-nowrap">
                    {log.contactId?.fullName || log.contactName || 'Unknown'}
                    {log.templateName && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-foreground/40">
                        {log.templateName}
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-foreground/80 font-mono text-xs whitespace-nowrap">
                    {log.contactId?.phoneNumber || log.phoneNumber}
                  </td>
                  <td className="py-3 whitespace-nowrap">
                    <Badge variant={state.variant}>{state.label}</Badge>
                  </td>
                  <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{deliveryStamp(log.sentAt)}</td>
                  <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{deliveryStamp(log.deliveredAt)}</td>
                  <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{deliveryStamp(log.readAt)}</td>
                  <td className="py-3 text-foreground/50 text-xs whitespace-nowrap">{deliveryStamp(log.failedAt)}</td>
                  <td className="py-3 text-foreground/50 text-xs max-w-[220px] truncate" title={log.errorReason}>
                    {log.status === 'Failed' ? (
                      <span className="flex items-center text-destructive">
                        <AlertTriangle className="w-3 h-3 mr-1 flex-shrink-0" />
                        {log.errorCode ? `[${log.errorCode}] ` : ''}{log.errorReason || 'Unknown error'}
                      </span>
                    ) : log.readAt ? (
                      <span className="flex items-center text-success">
                        <CheckCircle className="w-3 h-3 mr-1" /> Opened by recipient
                      </span>
                    ) : log.deliveredAt ? (
                      <span className="flex items-center text-info">
                        <CheckCircle className="w-3 h-3 mr-1" /> Delivered to device
                      </span>
                    ) : log.status === 'Sent' ? (
                      <span className="flex items-center text-info">
                        <Send className="w-3 h-3 mr-1" /> Accepted by WhatsApp
                      </span>
                    ) : (
                      <span className="flex items-center text-amber-500">
                        <Clock className="w-3 h-3 mr-1" /> Waiting to be processed
                      </span>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>

    {footnote}
  </div>
);
