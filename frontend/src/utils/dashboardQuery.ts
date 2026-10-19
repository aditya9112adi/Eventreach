/**
 * What the Dashboard asks the server for, and how it reads the answer.
 *
 * The Event Status and Event Name filters are exclusive on the page (choosing
 * one clears the other). "All" is no status at all, so it sends nothing - never
 * the text "All", which the server would read as a status with no events.
 */

export interface DashboardStats {
  totalEvents: number;
  totalContacts: number;
  totalCampaigns: number;
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  messagesPending: number;
}

export const EMPTY_DASHBOARD_STATS: DashboardStats = {
  totalEvents: 0, totalContacts: 0, totalCampaigns: 0,
  messagesSent: 0, messagesDelivered: 0, messagesFailed: 0, messagesPending: 0,
};

const isAll = (value: string) => ['', 'all'].includes(value.trim().toLowerCase());

/** "?eventId=..." for a selected event, else "?status=..." for a chosen status, else "" (everything). */
export const buildDashboardQuery = (filters: { eventId?: string | null; status?: string | null }): string => {
  const params = new URLSearchParams();
  const eventId = filters.eventId?.trim() ?? '';
  const status = filters.status?.trim() ?? '';
  if (eventId && !isAll(eventId)) params.set('eventId', eventId);
  else if (status && !isAll(status)) params.set('status', status);
  const query = params.toString();
  return query ? `?${query}` : '';
};

/**
 * The server's answer as stats, or null if it is not a complete set of numbers.
 * A partial body is an error to report, not a set of zeros to display.
 */
export const readDashboardStats = (data: unknown): DashboardStats | null => {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const stats: Record<string, number> = {};
  for (const key of Object.keys(EMPTY_DASHBOARD_STATS)) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    stats[key] = value;
  }
  return stats as unknown as DashboardStats;
};

/**
 * Tells a page which of its requests is the latest. Each request takes a token
 * from next(); only the holder of the newest token may show its answer, so a
 * slow answer to an earlier filter cannot replace the answer to the current one.
 */
export const createLatestGate = () => {
  let latest = 0;
  return {
    next: (): number => ++latest,
    isLatest: (token: number): boolean => token === latest,
  };
};

/** The message shown when the numbers could not be loaded. */
export const dashboardErrorMessage = (error: any): string =>
  error?.response?.data?.error || 'The dashboard statistics could not be loaded. Check your connection and try again.';
