import { Response, NextFunction } from 'express';
import path from 'path';
import { Campaign } from '../models/Campaign';
import { isEventAuthorized } from '../services/eventAuthService';
import { AuthRequest } from './authMiddleware';

/**
 * Authorizes a request for an uploaded campaign media file.
 *
 * Uploaded media belongs to a campaign, and a campaign belongs to an event, so
 * the same per-event rule that guards every other campaign resource applies
 * here too. The file is located by its stored `/uploads/<filename>` URL, which
 * may appear either on the campaign's current attachments or in its send
 * history.
 *
 * Runs after requireAuth, so the caller is already an authenticated account and
 * the identity comes from the verified JWT rather than the request.
 */
export const authorizeUpload = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // req.path is the portion after the /uploads mount, e.g. "/1699-photo.png".
    const requested = decodeURIComponent(req.path).replace(/^\/+/, '');

    // Refuse anything that is not a plain file name in the uploads root, so a
    // traversal attempt can never be turned into a lookup or a file read.
    if (!requested || requested !== path.basename(requested)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const storedUrl = `/uploads/${requested}`;

    const campaign = await Campaign.findOne({
      $or: [
        { 'mediaAttachments.url': storedUrl },
        { 'history.mediaAttachments.url': storedUrl },
      ],
    })
      .select('eventId')
      .lean();

    // An orphaned file is reported as missing rather than as forbidden: that
    // keeps the response from confirming which files exist on disk.
    if (!campaign) {
      return res.status(404).json({ error: 'File not found' });
    }

    const allowed = await isEventAuthorized((req as any).user, (campaign as any).eventId);
    if (!allowed) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    return next();
  } catch (error) {
    console.error('Upload authorization error:', error);
    return res.status(500).json({ error: 'Unable to serve this file right now.' });
  }
};
