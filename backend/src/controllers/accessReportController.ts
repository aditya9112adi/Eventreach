import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Event } from '../models/Event';
import { getAuthorizedEventIds, isEventAuthorized } from '../services/eventAuthService';
import { getEventAccessRecords } from '../services/accessReportService';
import { MAIN_EVENT_FILTER } from '../services/subEventService';
import { ACCESS_STATUSES, getAccessStatus, statusesMatching } from '../utils/accessStatus';
import { eventSearchFilter, readReportSearch, ReportSearchError, textMatcher } from '../utils/reportSearch';
import {
  parseReportDateRange,
  dateRangeFilter,
  ReportDateRangeError,
  reportDateRangeResponse,
} from '../utils/reportDateRange';

/**
 * GET /api/admin/access-report?startDate=&endDate=&q=&eventId=&status=
 *
 * The Access Report, by event - as the Event and Contact Reports are: the
 * events the caller may see whose event date falls in the period, and for
 * each, the people who have access to it (see accessReportService). Each
 * record carries the events it reaches (accessEventIds), so the page shows one
 * row per event, and how it reaches the one in a View (accessVia).
 *
 *  - eventId: one event's View - its access holders, authorized first.
 *  - q: the "All Fields" search - a person's own name, email, role, status or
 *    assigned event, or any searchable field of the event (then everyone with
 *    access to it). Someone found only through events keeps just those events.
 *  - status: the effective access status, matched from the start of a word.
 *
 * The plain list of access accounts - the Just Access page - is unchanged at
 * GET /api/admin/users/access-records.
 */
export const getAccessReport = async (req: Request, res: Response) => {
  try {
    const viewer = (req as any).user;
    const isSuperAdmin = viewer?.role === 'SuperAdmin';

    let range;
    let search: string | null;
    try {
      range = parseReportDateRange(req.query);
      search = readReportSearch(req.query.q);
    } catch (error) {
      if (error instanceof ReportDateRangeError) return res.status(400).json(reportDateRangeResponse(error));
      if (error instanceof ReportSearchError) return res.status(400).json({ error: error.message });
      throw error;
    }

    const rawStatus = req.query.status;
    if (rawStatus !== undefined && typeof rawStatus !== 'string') {
      return res.status(400).json({ error: 'Invalid status filter.' });
    }
    const statusText = (rawStatus ?? '').trim();
    if (statusText.length > 100) return res.status(400).json({ error: 'The status filter is too long.' });
    const wantedStatuses = statusText ? statusesMatching(ACCESS_STATUSES, statusText) : null;

    // The events in scope: the caller's own Main Events, in the period by event date.
    const authorized = await getAuthorizedEventIds(viewer);
    const eventQuery: any = { ...MAIN_EVENT_FILTER, ...dateRangeFilter('eventDate', range) };
    if (authorized !== null) eventQuery._id = { $in: authorized };

    const eventId = req.query.eventId;
    if (eventId !== undefined && eventId !== '') {
      if (typeof eventId !== 'string' || !mongoose.isValidObjectId(eventId)) {
        return res.status(400).json({ error: 'Invalid event id.' });
      }
      if (!(await isEventAuthorized(viewer, eventId))) {
        return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
      }
      eventQuery._id = eventId;
    }

    const events: any[] = await Event.find(eventQuery)
      .select('_id adminId createdBy assignedUserId assignedUserIds')
      .lean();
    if (events.length === 0) return res.json([]);

    const { records: found, reach } = await getEventAccessRecords(events, viewer);

    // The events the search names, among those in scope (one query).
    const matchingEvents = search
      ? new Set((await Event.find({ ...eventQuery, ...eventSearchFilter(search) }).select('_id').lean()).map((e: any) => String(e._id)))
      : null;
    const matches = search ? textMatcher(search) : null;

    const now = new Date();
    let records = found.flatMap((r: any) => {
      const record = { ...r, accessStatus: getAccessStatus(r, now) };
      let reached = [...(reach.get(String(r._id))?.keys() || [])];
      if (matches && !matches(record.name, record.email, record.type, record.accessStatus, record.assignedEventName)) {
        reached = reached.filter((id) => matchingEvents!.has(id));
      }
      if (reached.length === 0) return [];
      return [{
        ...record,
        accessEventIds: reached,
        // How this person reaches the event of a View; a list spans many events.
        accessVia: eventId ? (reach.get(String(r._id))?.get(String(eventId)) || []).join(', ') : undefined,
      }];
    });
    if (wantedStatuses) records = records.filter((r: any) => wantedStatuses.includes(r.accessStatus));

    // Approval/rejection metadata is Super Admin information only.
    if (!isSuperAdmin) {
      records = records.map((r: any) => {
        const { approvedAt, approvedBy, rejectedAt, rejectedBy, rejectionReason, ...rest } = r;
        return rest;
      });
    }

    res.json(records.sort((a: any, b: any) => String(a.name || '').localeCompare(String(b.name || ''))));
  } catch (error) {
    console.error('Error building the access report:', error);
    res.status(500).json({ error: 'Failed to build the access report' });
  }
};
