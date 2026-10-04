import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../services/api';
import { useSocket } from '../../contexts/SocketContext';
import { DeliveryLogTable } from './DeliveryLogTable';
import type { DeliveryLogRow } from '../../utils/deliveryLogReport';

/**
 * How many recipients one request asks for. The server caps a page, and the
 * table says so when the event has more than this rather than quietly showing
 * a partial list as if it were the whole.
 */
const PAGE_LIMIT = 200;

/**
 * The Delivery Log under the Event Report: every WhatsApp recipient of ONE
 * event, from the same MessageLog rows the campaign report reads.
 *
 * It is mounted only once an Event Report has been generated, so opening the
 * Reports page, switching to another report, or clearing never reaches the
 * server for it. The status filter belongs to this component and refetches
 * only this log - it never touches the Event Report's own rows.
 *
 * One request returns the campaign's recipients and the template sends
 * together (GET /reports/event/:eventId/delivery-log), so the cost does not
 * grow with the number of recipients.
 */
export const EventDeliveryLog = ({
  eventId,
  onAllTotal,
}: {
  eventId: string;
  /**
   * Told how many messages the event has in all, each time the unfiltered log
   * loads. Lets the View page enable its downloads without asking the server a
   * second time. Changes nothing on screen.
   */
  onAllTotal?: (total: number) => void;
}) => {
  const [logs, setLogs] = useState<DeliveryLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('All');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { socket } = useSocket();

  // Only the newest request may write to the screen. A slow answer for an
  // earlier filter must not land on top of a faster one for the current one.
  const latestRequest = useRef(0);
  // Held in a ref so a new callback from the parent does not refetch the log.
  const onAllTotalRef = useRef(onAllTotal);
  onAllTotalRef.current = onAllTotal;

  const load = useCallback(
    async (silent = false) => {
      const requestId = ++latestRequest.current;
      if (!silent) setIsLoading(true);
      try {
        const res = await api.get(`/reports/event/${eventId}/delivery-log`, {
          params: {
            status: statusFilter === 'All' ? undefined : statusFilter,
            limit: PAGE_LIMIT,
          },
        });
        if (latestRequest.current !== requestId) return;
        setLogs(res.data?.logs ?? []);
        setTotal(res.data?.pagination?.total ?? 0);
        // Only the unfiltered count says whether the event has messages at all;
        // "no Read messages" is not "no messages".
        if (statusFilter === 'All') onAllTotalRef.current?.(res.data?.pagination?.total ?? 0);
        setCampaignId(res.data?.campaignId ?? null);
        setError(null);
      } catch (err: any) {
        if (latestRequest.current !== requestId) return;
        const status = err?.response?.status;
        setError(
          status === 403
            ? "You do not have access to this event's delivery log."
            : err?.response?.data?.error || 'The delivery log could not be loaded.'
        );
      } finally {
        if (latestRequest.current === requestId) setIsLoading(false);
      }
    },
    [eventId, statusFilter]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A message changing state - from the send path or from the WhatsApp
   * webhook - refreshes the log if it is this event's, so the table shows the
   * latest status rather than the one it loaded with. A campaign message is
   * recognised by its campaign and a template message by its event.
   */
  useEffect(() => {
    if (!socket) return;
    const onUpdate = (data: { eventId?: string; campaignId?: string }) => {
      const mine =
        (data?.eventId && data.eventId === eventId) ||
        (data?.campaignId && campaignId && data.campaignId === campaignId);
      if (mine) void load(true);
    };
    socket.on('message-log-updated', onUpdate);
    return () => {
      socket.off('message-log-updated', onUpdate);
    };
  }, [socket, eventId, campaignId, load]);

  const emptyMessage = isLoading
    ? 'Loading the delivery log...'
    : error
      ? error
      : statusFilter !== 'All'
        ? 'No messages match this status.'
        : 'No WhatsApp messages have been sent for this event yet.';

  const footnote = error ? (
    <button
      type="button"
      onClick={() => void load()}
      className="mt-4 text-accent hover:text-accent/80 font-medium text-sm transition-colors"
    >
      Try again
    </button>
  ) : total > logs.length ? (
    <p className="mt-4 text-xs text-foreground/50">
      Showing the latest {logs.length} of {total} messages.
    </p>
  ) : null;

  return (
    <DeliveryLogTable
      logs={error ? [] : logs}
      statusFilter={statusFilter}
      onStatusFilterChange={setStatusFilter}
      emptyMessage={emptyMessage}
      footnote={footnote}
    />
  );
};
