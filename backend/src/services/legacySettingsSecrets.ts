import { Settings } from '../models/Settings';
import { AuditLog } from '../models/AuditLog';
import { isSensitiveName } from './AuditService';

/**
 * Finds - and, only when asked, removes - WhatsApp credentials that the old
 * Settings page stored in the database.
 *
 * Two places can hold one:
 *  - the `settings` collection itself (`{ key: 'whatsapp_token', value }`);
 *  - audit entries written before redaction covered a secret held in a field
 *    named `value` (changes.before / changes.after of SETTINGS_UPDATED).
 *
 * Reports identify records by id and time only. No value is ever returned,
 * printed or compared outside the database query itself.
 */

const REDACTED = '***REDACTED***';

/** Retired Settings keys whose value is a secret (the token, the verify token). */
export const LEGACY_SECRET_SETTING_KEYS = ['whatsapp_token', 'webhook_verify_token'].filter(isSensitiveName);

const unredactedSnapshot = (side: 'before' | 'after') => ({
  [`changes.${side}.key`]: { $in: LEGACY_SECRET_SETTING_KEYS },
  [`changes.${side}.value`]: { $type: 'string', $nin: ['', REDACTED] },
});

const auditQuery = () => ({
  collectionName: 'settings',
  $or: [unredactedSnapshot('before'), unredactedSnapshot('after')],
});

export interface LegacySecretsReport {
  storedSettings: { key: string; updatedAt: Date | null }[];
  auditEntries: { id: string; timestamp: Date | null; action: string }[];
}

export const findLegacySecrets = async (): Promise<LegacySecretsReport> => {
  const settings = await Settings.find(
    { key: { $in: LEGACY_SECRET_SETTING_KEYS }, value: { $type: 'string', $ne: '' } },
    { key: 1, updatedAt: 1 }
  ).lean();
  const audits = await AuditLog.find(auditQuery(), { _id: 1, timestamp: 1, action: 1 }).sort({ timestamp: 1 }).lean();
  return {
    storedSettings: settings.map((s: any) => ({ key: s.key, updatedAt: s.updatedAt ?? null })),
    auditEntries: audits.map((a: any) => ({ id: String(a._id), timestamp: a.timestamp ?? null, action: a.action })),
  };
};

export interface LegacySecretsCleanup {
  settingsCleared: number;
  auditSnapshotsRedacted: number;
}

/**
 * Blanks the stored values and redacts the audit snapshots in place. The
 * entries themselves - who changed which setting, and when - are kept.
 *
 * Irreversible by design. Any credential found should be rotated in Meta
 * regardless: it was readable by everyone with Audit Log or database access.
 */
export const removeLegacySecrets = async (): Promise<LegacySecretsCleanup> => {
  const settings = await Settings.updateMany(
    { key: { $in: LEGACY_SECRET_SETTING_KEYS }, value: { $type: 'string', $ne: '' } },
    { $set: { value: '' } }
  );

  let redacted = 0;
  for (const side of ['before', 'after'] as const) {
    const result = await AuditLog.updateMany(
      { collectionName: 'settings', ...unredactedSnapshot(side) },
      { $set: { [`changes.${side}.value`]: REDACTED } }
    );
    redacted += result.modifiedCount;
  }

  return { settingsCleared: settings.modifiedCount, auditSnapshotsRedacted: redacted };
};
