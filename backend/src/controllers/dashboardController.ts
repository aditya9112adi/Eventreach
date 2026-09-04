import { Request, Response } from 'express';
import { Event } from '../models/Event';
import { updateExpiredEvents } from './eventController';
import { Contact } from '../models/Contact';
import { Campaign } from '../models/Campaign';
import { MessageLog } from '../models/MessageLog';
import { getAuthorizedEventIds, isEventAuthorized } from '../services/eventAuthService';

export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();

    const currentUser = (req as any).user;
    const { eventId, status } = req.query;

    // Check authorization if specific eventId is requested
    if (eventId) {
      const authorized = await isEventAuthorized(currentUser, eventId);
      if (!authorized) {
        return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
      }
    }

    const authorizedIds = await getAuthorizedEventIds(currentUser);

    // If non-superadmin has 0 authorized events, return all zeroes
    if (authorizedIds !== null && authorizedIds.length === 0) {
      return res.json({
        totalEvents: 0,
        totalContacts: 0,
        totalCampaigns: 0,
        messagesSent: 0,
        messagesDelivered: 0,
        messagesFailed: 0,
        messagesPending: 0,
      });
    }

    let eventQuery: any = {};
    let contactQuery: any = {};
    let campaignQuery: any = {};
    let messageMatchQuery: any = {};

    // Apply role-based event scope if not SuperAdmin
    if (authorizedIds !== null) {
      eventQuery._id = { $in: authorizedIds };
    }

    // Filter by status
    if (status) {
      eventQuery.eventStatus = status;
    }

    // Filter by specific event
    if (eventId) {
      eventQuery._id = eventId;
      contactQuery.eventId = eventId;
      campaignQuery.eventId = eventId;

      const campaigns = await Campaign.find({ eventId }).select('_id');
      const campaignIds = campaigns.map((c) => c._id);

      messageMatchQuery = campaignIds.length > 0
        ? { campaignId: { $in: campaignIds } }
        : { campaignId: null };
    } else {
      // Find all matching events within authorized scope
      const matchingEvents = await Event.find(eventQuery).select('_id');
      const matchingEventIds = matchingEvents.map((e) => e._id);

      contactQuery.eventId = { $in: matchingEventIds };
      campaignQuery.eventId = { $in: matchingEventIds };

      const campaigns = await Campaign.find(campaignQuery).select('_id');
      const campaignIds = campaigns.map((c) => c._id);

      messageMatchQuery = campaignIds.length > 0
        ? { campaignId: { $in: campaignIds } }
        : { campaignId: null };
    }

    const totalEvents = await Event.countDocuments(eventQuery);
    const totalContacts = await Contact.countDocuments(contactQuery);
    const totalCampaigns = await Campaign.countDocuments(campaignQuery);

    const messageStats = await MessageLog.aggregate([
      { $match: messageMatchQuery },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const msgBreakdown: Record<string, number> = {
      Sent: 0, Delivered: 0, Failed: 0, Pending: 0
    };
    messageStats.forEach((s: any) => {
      if (msgBreakdown[s._id] !== undefined) msgBreakdown[s._id] = s.count;
    });

    res.json({
      totalEvents,
      totalContacts,
      totalCampaigns,
      messagesSent: msgBreakdown.Sent,
      messagesDelivered: msgBreakdown.Delivered,
      messagesFailed: msgBreakdown.Failed,
      messagesPending: msgBreakdown.Pending,
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
};

export const getRecentCampaignActivity = async (req: Request, res: Response) => {
  try {
    await updateExpiredEvents();

    const currentUser = (req as any).user;
    const { eventId, status } = req.query;

    if (eventId) {
      const authorized = await isEventAuthorized(currentUser, eventId);
      if (!authorized) {
        return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
      }
    }

    const authorizedIds = await getAuthorizedEventIds(currentUser);
    if (authorizedIds !== null && authorizedIds.length === 0) {
      return res.json({
        chartData: [],
        recentCampaigns: [],
      });
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    let messageMatchQuery: any = { createdAt: { $gte: sevenDaysAgo } };
    let campaignQuery: any = {};

    if (eventId) {
      campaignQuery = { eventId };
      const campaigns = await Campaign.find({ eventId }).select('_id');
      const campaignIds = campaigns.map((c) => c._id);
      messageMatchQuery.campaignId = campaignIds.length > 0
        ? { $in: campaignIds } : null;
    } else {
      let eventQuery: any = {};
      if (authorizedIds !== null) {
        eventQuery._id = { $in: authorizedIds };
      }
      if (status) {
        eventQuery.eventStatus = status;
      }

      const matchingEvents = await Event.find(eventQuery).select('_id');
      const matchingEventIds = matchingEvents.map((e) => e._id);
      campaignQuery = { eventId: { $in: matchingEventIds } };

      const campaigns = await Campaign.find(campaignQuery).select('_id');
      const campaignIds = campaigns.map((c) => c._id);
      messageMatchQuery.campaignId = campaignIds.length > 0
        ? { $in: campaignIds } : null;
    }

    const dailyActivity = await MessageLog.aggregate([
      {
        $match: messageMatchQuery
      },
      {
        $group: {
          _id: {
            day: { $dayOfWeek: '$createdAt' },
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
          },
          sent: {
            $sum: { $cond: [{ $in: ['$status', ['Sent', 'Delivered']] }, 1, 0] }
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'Failed'] }, 1, 0] }
          },
          total: { $sum: 1 }
        }
      },
      { $sort: { '_id.date': 1 } },
      { $limit: 7 }
    ]);

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const chartData = dailyActivity.map((item: any) => ({
      name: dayNames[item._id.day - 1] || item._id.date,
      sent: item.sent + item.failed, // total attempted
      delivered: item.sent,
    }));

    // Get recent campaigns with their stats
    const recentCampaigns = await Campaign.find(campaignQuery)
      .populate('eventId', 'eventName')
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();

    res.json({
      chartData,
      recentCampaigns
    });
  } catch (error) {
    console.error('Get recent activity error:', error);
    res.status(500).json({ error: 'Failed to fetch recent activity' });
  }
};
