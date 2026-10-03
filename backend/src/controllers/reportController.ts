import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { MessageLog } from '../models/MessageLog';
import { Campaign } from '../models/Campaign';
import { isEventAuthorized } from '../services/eventAuthService';

/**
 * What a Delivery Log status filter means in a query.
 *
 * "Read" is a milestone timestamp rather than a status value (see
 * models/MessageLog.ts), so it filters on readAt; everything else is a plain
 * status match, and "All" (or nothing) applies no condition. Kept in one place
 * because three Delivery Log endpoints use it and a drift between them would
 * make the same filter answer differently depending on where it was chosen.
 */
const deliveryStatusCondition = (statusFilter: unknown): Record<string, any> => {
  if (typeof statusFilter !== 'string' || !statusFilter || statusFilter === 'All') return {};
  if (statusFilter === 'Read') return { readAt: { $ne: null } };
  return { status: statusFilter };
};

export const getCampaignStats = async (req: Request, res: Response) => {
  try {
    const { campaignId } = req.params;

    const campaign = await Campaign.findById(campaignId).populate('eventId');
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const currentUser = (req as any).user;
    const eventId = (campaign.eventId as any)?._id || campaign.eventId;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const stats = await MessageLog.aggregate([
      { $match: { campaignId: campaign._id } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const total = await MessageLog.countDocuments({ campaignId: campaign._id });

    // Transform the aggregation into a clean object
    const breakdown: Record<string, number> = {
      Pending: 0,
      Sent: 0,
      Delivered: 0,
      Failed: 0
    };

    stats.forEach((s: any) => {
      breakdown[s._id] = s.count;
    });

    /**
     * Delivery milestones counted from timestamps rather than from `status`,
     * because they are not mutually exclusive: a read message is also a
     * delivered message, and a delivered message was also accepted. Counting
     * them off the single status field would make each milestone erase the
     * previous one. See the note in models/MessageLog.ts.
     *
     * `accepted` is deliberately NOT called "sent": it means WhatsApp took
     * the message, not that any handset received it.
     */
    const [delivered, read, accepted] = await Promise.all([
      MessageLog.countDocuments({ campaignId: campaign._id, deliveredAt: { $ne: null } }),
      MessageLog.countDocuments({ campaignId: campaign._id, readAt: { $ne: null } }),
      MessageLog.countDocuments({ campaignId: campaign._id, sentAt: { $ne: null } }),
    ]);

    const summary = {
      total,
      pending: breakdown.Pending,
      accepted,                 // handed to WhatsApp and acknowledged
      delivered,                // confirmed on the device by the webhook
      read,                     // opened by the recipient
      failed: breakdown.Failed,
      awaitingConfirmation: Math.max(accepted - delivered - breakdown.Failed, 0),
    };

    // "Success" means WhatsApp accepted it — the honest ceiling on what the
    // send call alone can tell us. Delivery confirmation is reported
    // separately rather than being folded in here.
    const successRate = total > 0 ? Math.round((accepted / total) * 100) : 0;
    const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 0;

    const historyLen = campaign.history?.length || 0;
    const latestMessage = historyLen > 0 ? campaign.history[historyLen - 1].messageText : campaign.messageText;

    /**
     * Only the event fields the report actually renders.
     *
     * This previously returned the whole populated Event document, which
     * broke the endpoint outright: Event.organizerMobile is BSON Int64 and
     * hydrates as a JS bigint, and res.json() -> JSON.stringify throws on a
     * bigint. Every call to this endpoint answered 500 once that migration
     * landed, which is what surfaced in the UI as "Report data not
     * available." Trimming the payload also stops the organiser's personal
     * mobile number travelling to anyone who can read a campaign report.
     */
    const event = campaign.eventId as any;
    const eventDetails = event && event._id
      ? {
          _id: String(event._id),
          eventName: event.eventName,
          eventVenue: event.eventVenue,
          eventDate: event.eventDate,
        }
      : null;

    res.json({
      campaignId,
      campaignStatus: campaign.status,
      eventName: event?.eventName,
      eventDetails,
      messageContent: latestMessage,
      total,
      breakdown,
      summary,
      successRate,
      deliveryRate,
      // True once the webhook has told us anything at all. When false, the
      // report explains that delivery confirmation is not being received
      // rather than implying every message merely "sent".
      hasDeliveryData: delivered > 0 || read > 0,
    });
  } catch (error) {
    console.error('Get campaign stats error:', error);
    res.status(500).json({ error: 'Failed to fetch campaign stats' });
  }
};

export const getCampaignLogs = async (req: Request, res: Response) => {
  try {
    const { campaignId } = req.params;

    const campaign = await Campaign.findById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, campaign.eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const statusFilter = req.query.status as string;

    const query: any = { campaignId, ...deliveryStatusCondition(statusFilter) };

    const logs = await MessageLog.find(query)
      .populate('contactId', 'fullName phoneNumber')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const totalLogs = await MessageLog.countDocuments(query);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        total: totalLogs,
        totalPages: Math.ceil(totalLogs / limit)
      }
    });
  } catch (error) {
    console.error('Get campaign logs error:', error);
    res.status(500).json({ error: 'Failed to fetch campaign logs' });
  }
};

/**
 * GET /api/reports/event/:eventId/template-logs
 *
 * The Delivery Log for proactive template sends. Those have no campaign —
 * campaigns are one per event — so their rows are found by event instead, and
 * authorized by that same event rather than through a campaign.
 *
 * Deliberately a separate query from getCampaignLogs: a campaign's Delivery
 * Log keeps returning exactly the rows it always has.
 */
export const getEventTemplateLogs = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const statusFilter = req.query.status as string;

    // templateName is what distinguishes a proactive send from anything else
    // that might one day carry an eventId.
    const query: any = {
      eventId,
      templateName: { $exists: true, $ne: null },
      ...deliveryStatusCondition(statusFilter),
    };

    const logs = await MessageLog.find(query)
      .populate('contactId', 'fullName phoneNumber')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const totalLogs = await MessageLog.countDocuments(query);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        total: totalLogs,
        totalPages: Math.ceil(totalLogs / limit),
      },
    });
  } catch (error) {
    console.error('Get event template logs error:', error);
    res.status(500).json({ error: 'Failed to fetch template delivery logs' });
  }
};

/**
 * GET /api/reports/event/:eventId/delivery-log
 *
 * Everything WhatsApp has been asked to send for ONE event, in one response:
 * the campaign's recipients and the proactive template sends. The Event Report
 * shows this under its event table.
 *
 * The two kinds of row are linked to the event differently - a campaign
 * message reaches it through Campaign.eventId (one campaign per event) and
 * carries no eventId of its own, while a template send carries eventId and no
 * campaign - so this is one $or over the two existing indexes rather than the
 * three round trips the page would otherwise make. contactId is populated by
 * Mongoose in a single batched lookup, not one per recipient.
 *
 * Authorization is the event's, exactly as the campaign and template-log
 * endpoints apply it, and the rows come straight from MessageLog: nothing is
 * copied or counted anywhere else, so a webhook update is visible on the next
 * read.
 */
export const getEventDeliveryLog = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;

    // Refused before it reaches a query: an id that is not an ObjectId would
    // otherwise surface as a cast error and a 500.
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ error: 'Invalid event id.' });
    }

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    // Capped so one request cannot ask for an unbounded slice of the collection.
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 500);

    const campaign = await Campaign.findOne({ eventId }).select('_id').lean();

    const ownedByEvent: any[] = [{ eventId, templateName: { $exists: true, $ne: null } }];
    if (campaign) ownedByEvent.push({ campaignId: campaign._id });

    const query: any = {
      $or: ownedByEvent,
      ...deliveryStatusCondition(req.query.status),
    };

    const [logs, total] = await Promise.all([
      MessageLog.find(query)
        .populate('contactId', 'fullName phoneNumber')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      MessageLog.countDocuments(query),
    ]);

    res.json({
      eventId,
      campaignId: campaign ? String(campaign._id) : null,
      logs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Get event delivery log error:', error);
    res.status(500).json({ error: 'Failed to fetch the delivery log' });
  }
};
