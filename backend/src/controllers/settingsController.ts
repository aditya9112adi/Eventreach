import { Request, Response } from 'express';
import { Settings } from '../models/Settings';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { describeWhatsAppConnection } from '../services/whatsappConnection';

/** Settings an administrator edits here. */
const EDITABLE_KEYS = ['default_country_code', 'company_name'];

/**
 * WhatsApp credentials this page used to accept. Nothing ever read them:
 * every WhatsApp call uses the server environment (see
 * services/whatsappConnection.ts), so a value saved here changed nothing while
 * the page implied it did - and a token saved here was stored in plain text.
 * They are no longer returned or written; the connection's real status is
 * reported instead.
 */
export const RETIRED_WHATSAPP_KEYS = ['whatsapp_token', 'whatsapp_phone_id', 'webhook_verify_token'];

export const getSettings = async (req: Request, res: Response) => {
  try {
    const settings = await Settings.find({ key: { $in: [...EDITABLE_KEYS, ...RETIRED_WHATSAPP_KEYS] } }).lean();

    const settingsMap: Record<string, any> = {};
    for (const key of EDITABLE_KEYS) {
      settingsMap[key] = settings.find((s) => s.key === key)?.value ?? '';
    }

    // Whether an old credential is still stored - so it can be cleaned up and
    // rotated - but never the credential itself.
    const legacyStored = RETIRED_WHATSAPP_KEYS.filter((key) =>
      Boolean(settings.find((s) => s.key === key)?.value)
    );
    settingsMap.whatsappConnection = { ...describeWhatsAppConnection(), legacyStoredSettings: legacyStored };

    res.json(settingsMap);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
};

export const updateSettings = async (req: RequestWithId, res: Response) => {
  try {
    const updates: Record<string, string> = req.body;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Settings must be an object' });
    }

    // Everything is checked before anything is written, so a refused request
    // never leaves some of its settings saved.
    for (const [key, value] of Object.entries(updates)) {
      if (RETIRED_WHATSAPP_KEYS.includes(key)) {
        // An empty or masked value is what an older copy of the page sends
        // back untouched; ignore it. A real value is refused rather than
        // silently dropped, so nobody believes a credential was saved.
        if (typeof value === 'string' && value.trim() && !value.startsWith('••••')) {
          return res.status(400).json({
            error:
              'WhatsApp credentials are configured on the server, not in Settings. ' +
              'Ask the administrator who manages the deployment to update them.',
            field: key,
          });
        }
        continue;
      }
      if (!EDITABLE_KEYS.includes(key)) continue;

      // 2000 is comfortably above every real setting; the migration dry-run
      // confirms that all stored values already conform before the DB
      // validator enforces it.
      if (typeof value !== 'string') {
        return res.status(400).json({ error: `Setting '${key}' must be a string` });
      }
      if (value.length > 2000) {
        return res.status(400).json({ error: `Setting '${key}' exceeds 2000 characters` });
      }
    }

    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_KEYS.includes(key)) continue;

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
