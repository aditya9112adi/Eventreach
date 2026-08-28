import { Request, Response } from 'express';
import { Campaign } from '../models/Campaign';
import { queueService } from '../services/QueueService';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import crypto from 'crypto';

export const uploadMedia = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Determine type
    let type: 'image' | 'video' | 'audio' | 'document' = 'document';
    if (file.mimetype.startsWith('image/')) type = 'image';
    else if (file.mimetype.startsWith('video/')) type = 'video';
    else if (file.mimetype.startsWith('audio/')) type = 'audio';

    // Construct local URL
    const url = `/uploads/${file.filename}`;

    res.json({
      url,
      type,
      filename: file.originalname
    });
  } catch (error) {
    console.error('Media upload error:', error);
    res.status(500).json({ error: 'Failed to upload media' });
  }
};

export const getCampaign = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    let campaign = await Campaign.findOne({ eventId });
    
    // If no campaign exists, return an empty template rather than 404
    if (!campaign) {
      return res.json({
        eventId,
        messageText: '',
        mediaAttachments: [],
        status: 'Draft'
      });
    }

    res.json(campaign);
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
};

export const saveCampaign = async (req: RequestWithId, res: Response) => {
  try {
    const { eventId } = req.params;
    const { messageText, mediaAttachments, status } = req.body;

    const beforeCampaign = await Campaign.findOne({ eventId });

    const campaign = await Campaign.findOneAndUpdate(
      { eventId },
      {
        messageText,
        mediaAttachments: mediaAttachments || [],
        status: status || 'Draft'
      },
      { new: true, upsert: true }
    );

    await AuditService.log({
      action: beforeCampaign ? 'CAMPAIGN_UPDATED' : 'CAMPAIGN_CREATED',
      collectionName: 'campaigns',
      documentId: campaign._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: beforeCampaign,
      after: campaign,
      description: beforeCampaign ? 'Saved existing campaign' : 'Created new campaign'
    });

    res.json(campaign);
  } catch (error) {
    console.error('Save campaign error:', error);
    res.status(500).json({ error: 'Failed to save campaign' });
  }
};

export const sendCampaign = async (req: RequestWithId, res: Response) => {
  try {
    const { eventId } = req.params;
    const { recipientIds } = req.body;
    const bulkOperationId = `BULK-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    
    const campaign = await Campaign.findOne({ eventId });
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const currentMessage = campaign.messageText;
    const currentAttachments = campaign.mediaAttachments;

    campaign.status = 'Sending';
    campaign.history.push({
      messageText: currentMessage,
      mediaAttachments: currentAttachments,
      sentAt: new Date()
    });
    
    campaign.messageText = '';
    campaign.mediaAttachments = [];
    
    await campaign.save();

    await AuditService.log({
      action: 'CAMPAIGN_STARTED',
      collectionName: 'campaigns',
      documentId: campaign._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      bulkOperationId,
      description: `Started sending campaign`
    });

    // Pass audit info to queue service
    const auditInfo = {
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      bulkOperationId
    };

    await queueService.processCampaign(campaign._id.toString(), recipientIds, currentMessage, currentAttachments, auditInfo);

    res.json({ message: 'Campaign queued successfully', campaign, bulkOperationId });
  } catch (error) {
    console.error('Send campaign error:', error);
    res.status(500).json({ error: 'Failed to queue campaign' });
  }
};

export const getAllCampaigns = async (req: Request, res: Response) => {
  try {
    const campaigns = await Campaign.find()
      .populate('eventId', 'eventName')
      .sort({ updatedAt: -1 })
      .lean();
    res.json(campaigns);
  } catch (error) {
    console.error('Get all campaigns error:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
};


