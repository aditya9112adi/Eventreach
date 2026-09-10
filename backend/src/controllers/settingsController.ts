import { Request, Response } from 'express';
import { Settings } from '../models/Settings';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';

const ALLOWED_KEYS = [
  'whatsapp_token',
  'whatsapp_phone_id',
  'default_country_code',
  'company_name',
  'webhook_verify_token'
];

export const getSettings = async (req: Request, res: Response) => {
  try {
    const settings = await Settings.find({ key: { $in: ALLOWED_KEYS } }).lean();
    
    // Convert to a key-value map, masking sensitive values
    const settingsMap: Record<string, string> = {};
    for (const key of ALLOWED_KEYS) {
      const found = settings.find(s => s.key === key);
      if (found) {
        // Mask tokens - only show last 4 chars
        if (key === 'whatsapp_token' && found.value) {
          settingsMap[key] = '••••••••' + found.value.slice(-4);
        } else {
          settingsMap[key] = found.value;
        }
      } else {
        settingsMap[key] = '';
      }
    }

    res.json(settingsMap);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
};

export const updateSettings = async (req: RequestWithId, res: Response) => {
  try {
    const updates: Record<string, string> = req.body;

    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_KEYS.includes(key)) continue;

      // The endpoint previously wrote any value through untouched. 2000 is
      // comfortably above every real setting (the longest is a WhatsApp token
      // at a few hundred characters); the migration dry-run confirms that all
      // stored values already conform before the DB validator enforces it.
      if (typeof value !== 'string') {
        return res.status(400).json({ error: `Setting '${key}' must be a string` });
      }
      if (value.length > 2000) {
        return res.status(400).json({ error: `Setting '${key}' exceeds 2000 characters` });
      }
      
      // Don't overwrite token with masked value
      if (key === 'whatsapp_token' && value.startsWith('••••')) continue;

      const beforeSetting = await Settings.findOne({ key });
      
      const afterSetting = await Settings.findOneAndUpdate(
        { key },
        { value },
        { upsert: true, new: true }
      );

      await AuditService.log({
        action: 'SETTINGS_UPDATED',
        collectionName: 'settings',
        documentId: afterSetting._id.toString(),
        actor: AuditService.getActorFromReq(req),
        request: AuditService.getRequestInfo(req),
        before: beforeSetting,
        after: afterSetting,
        description: `Updated setting: ${key}`
      });
    }

    res.json({ message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
};
