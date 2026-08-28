import { Request, Response } from 'express';
import { MessageLog } from '../models/MessageLog';
import { Campaign } from '../models/Campaign';

export const getCampaignStats = async (req: Request, res: Response) => {
  try {
    const { campaignId } = req.params;

    const campaign = await Campaign.findById(campaignId).populate('eventId');
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
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

    const successCount = breakdown.Sent + breakdown.Delivered;
    const successRate = total > 0 ? Math.round((successCount / total) * 100) : 0;

    const historyLen = campaign.history?.length || 0;
    const latestMessage = historyLen > 0 ? campaign.history[historyLen - 1].messageText : campaign.messageText;

    res.json({
      campaignId,
      campaignStatus: campaign.status,
      eventName: (campaign.eventId as any).eventName,
      eventDetails: campaign.eventId,
      messageContent: latestMessage,
      total,
      breakdown,
      successRate
    });
  } catch (error) {
    console.error('Get campaign stats error:', error);
    res.status(500).json({ error: 'Failed to fetch campaign stats' });
  }
};

export const getCampaignLogs = async (req: Request, res: Response) => {
  try {
    const { campaignId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const statusFilter = req.query.status as string;

    const query: any = { campaignId };
    if (statusFilter && statusFilter !== 'All') {
      query.status = statusFilter;
    }

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

