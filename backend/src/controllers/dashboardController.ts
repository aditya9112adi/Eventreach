import { Request, Response } from 'express';
import { Campaign } from '../models/Campaign';
import { updateExpiredEvents } from './eventController';
import { isEventAuthorized } from '../services/eventAuthService';
import {
  computeDashboardStats,
  dailyActivity,
  parseEventIdFilter,
  parseStatusFilter,
  resolveScope,
  type DashboardFilters,
} from '../services/dashboardStats';

/**
 * Dashboard cards and charts. Which events match, and what each number means,
 * is decided in services/dashboardStats.ts; these handlers only read the two
 * filters, authorize a selected event, and answer.
 *
 * `status` and `eventId` may each be absent, empty, or "All" for no filter; an
 * unknown status or a malformed event id is a 400, never a silent "no results".
 */

const readFilters = (req: Request): { ok: true; filters: DashboardFilters } | { ok: false; error: string } => {
  const status = parseStatusFilter(req.query.status);
  if (!status.ok) return { ok: false, error: status.error };
  const eventId = parseEventIdFilter(req.query.eventId);
  if (!eventId.ok) return { ok: false, error: eventId.error };
  return { ok: true, filters: { eventId: eventId.value, status: status.value } };
};

export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();

    const currentUser = (req as any).user;
    const parsed = readFilters(req);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;

    if (filters.eventId && !(await isEventAuthorized(currentUser, filters.eventId))) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const { stats } = await computeDashboardStats(currentUser, filters);
    res.json(stats);
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
};

export const getRecentCampaignActivity = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();

    const currentUser = (req as any).user;
    const parsed = readFilters(req);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { filters } = parsed;

    if (filters.eventId && !(await isEventAuthorized(currentUser, filters.eventId))) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const scope = await resolveScope(currentUser, filters);
    const chartData = await dailyActivity(scope);

    // The five most recently updated campaigns: a "recent" list, not a statistic.
    const recentCampaigns = scope.eventIds.length
      ? await Campaign.find({ eventId: { $in: scope.eventIds } })
          .populate('eventId', 'eventName')
          .sort({ updatedAt: -1 })
          .limit(5)
          .lean()
      : [];

    res.json({ chartData, recentCampaigns });
  } catch (error) {
    console.error('Get recent activity error:', error);
    res.status(500).json({ error: 'Failed to fetch recent activity' });
  }
};
