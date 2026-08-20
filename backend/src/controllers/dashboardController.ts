import { Request, Response } from 'express';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { Campaign } from '../models/Campaign';
import { MessageLog } from '../models/MessageLog';

export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    const totalEvents = await Event.countDocuments();
    const totalContacts = await Contact.countDocuments();
    const totalCampaigns = await Campaign.countDocuments();

    // Aggregate message stats from MessageLog
    const messageStats = await MessageLog.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const msgBreakdown: Record<string, number> = {
      Sent: 0,
      Delivered: 0,
      Failed: 0,
      Pending: 0
    };

    messageStats.forEach((s: any) => {
      if (msgBreakdown[s._id] !== undefined) {
        msgBreakdown[s._id] = s.count;
      }
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
    // Get the last 7 campaigns or recent message activity grouped by day
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const dailyActivity = await MessageLog.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenDaysAgo }
        }
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
    const recentCampaigns = await Campaign.find()
      .populate('eventId', 'name')
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
