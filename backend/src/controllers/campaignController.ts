import { Request, Response } from 'express';
import { z } from 'zod';
import { Campaign } from '../models/Campaign';
import { queueService } from '../services/QueueService';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { isEventAuthorized, getAuthorizedEventIds } from '../services/eventAuthService';
import crypto from 'crypto';
import fs from 'fs';
import { sniffMimeFromFile } from '../utils/mediaSniff';
import { validateWhatsAppMedia, WHATSAPP_MEDIA_RULES } from '@eventreach/shared';

/** One media attachment, matching mediaAttachmentSchema in the Campaign model. */
const mediaAttachmentBody = z.object({
  url: z.string().min(1, 'Attachment url is required'),
  type: z.enum(['image', 'video', 'audio', 'document'], {
    errorMap: () => ({ message: 'Attachment type must be image, video, audio or document' }),
  }),
  filename: z.string().min(1, 'Attachment filename is required'),
});

/**
 * Body accepted by saveCampaign.
 *
 * messageText intentionally has no maximum: no UI or API layer caps it today,
 * and imposing one here could reject drafts that already exist. The migration
 * dry-run reports the longest stored value so a limit can be set deliberately.
 */
const saveCampaignSchema = z.object({
  messageText: z.string().optional().default(''),
  mediaAttachments: z.array(mediaAttachmentBody).optional().default([]),
  status: z.enum(['Draft', 'Scheduled', 'Sending', 'Completed']).optional().default('Draft'),
});

/** Removes a rejected upload so a refused file never lingers on disk. */
const discardUpload = async (filePath?: string) => {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => {});
};

export const uploadMedia = async (req: Request, res: Response) => {
  const file = req.file;
  try {
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    /**
     * Second gate, and the one that matters. The middleware only saw the
     * browser-declared MIME and the claimed extension; both are supplied by
     * the caller. Here the file exists on disk, so its real size and its
     * actual magic bytes can be checked — a renamed executable declaring
     * image/png is rejected at this point, not sent to WhatsApp.
     */
    const stat = await fs.promises.stat(file.path);
    const sniffed = await sniffMimeFromFile(file.path);

    const problem = validateWhatsAppMedia({
      declaredMime: file.mimetype,
      filename: file.originalname,
      sizeBytes: stat.size,
      sniffedMime: sniffed,
    });

    if (problem) {
      await discardUpload(file.path);
      return res.status(400).json({ error: problem });
    }

    /**
     * The contents must POSITIVELY identify as the declared type. Requiring a
     * match rather than merely the absence of a mismatch is the difference
     * that matters: an executable's header matches none of the five supported
     * signatures, so the sniffer returns null — and treating "unrecognised"
     * as acceptable would let evil.exe renamed to photo.png and declared
     * image/png straight through, which is exactly what it did before this
     * check. Only five types are supported, so anything unidentifiable is
     * refused rather than guessed at.
     */
    if (sniffed !== file.mimetype) {
      await discardUpload(file.path);
      return res.status(400).json({
        error: 'The file contents do not match its type. It may be renamed, corrupted, or not a real media file.',
      });
    }

    const rule = WHATSAPP_MEDIA_RULES[file.mimetype];
    const url = `/uploads/${file.filename}`;

    res.json({
      url,
      type: rule.kind,
      filename: file.originalname,
      // Carried so the sender knows how to hand this to WhatsApp without
      // re-inspecting the file, and so the report can show what was attached.
      mimeType: file.mimetype,
      sizeBytes: stat.size,
    });
  } catch (error) {
    // Never log the file's contents — only that handling it failed.
    console.error('Media upload error:', error instanceof Error ? error.message : error);
    await discardUpload(file?.path);
    res.status(500).json({ error: 'Failed to upload media' });
  }
};

export const getCampaign = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

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
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    // This endpoint previously wrote req.body straight through with no
    // validation of any kind. The rules below are exactly the ones the schema
    // and the application already rely on — no new limits are introduced, and
    // messageText stays unbounded because no existing layer caps it.
    const parsed = saveCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { messageText, mediaAttachments, status } = parsed.data;

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
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

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
    const currentUser = (req as any).user;
    const authorizedIds = await getAuthorizedEventIds(currentUser);

    const query: any = {};
    if (authorizedIds !== null) {
      query.eventId = { $in: authorizedIds };
    }

    const campaigns = await Campaign.find(query)
      .populate('eventId', 'eventName')
      .sort({ updatedAt: -1 })
      .lean();
    res.json(campaigns);
  } catch (error) {
    console.error('Get all campaigns error:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
};
