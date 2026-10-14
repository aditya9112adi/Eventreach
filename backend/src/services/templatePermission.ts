import mongoose from 'mongoose';
import { Admin } from '../models/Admin';

/**
 * Who may manage WhatsApp templates: every Super Admin, and an Admin only with
 * an explicit grant (`canManageWhatsAppTemplates`) from a Super Admin. Users
 * never.
 *
 * Decided from the database on every call - never from the token, the request
 * or anything the frontend sends - so granting or revoking takes effect on the
 * very next request.
 */

export type TemplateRole = 'SuperAdmin' | 'Admin';

/** The rule itself, for an account already read from the database. */
export const accountCanManageTemplates = (account: { role?: unknown; canManageWhatsAppTemplates?: unknown } | null | undefined): boolean =>
  !!account && (account.role === 'SuperAdmin' || (account.role === 'Admin' && account.canManageWhatsAppTemplates === true));

/**
 * The account's role as stored, if it may manage templates; null otherwise.
 * Only Admin accounts can qualify, so a User id never matches.
 */
export const templateManagerRole = async (accountId: unknown): Promise<TemplateRole | null> => {
  if (typeof accountId !== 'string' || !mongoose.Types.ObjectId.isValid(accountId)) return null;
  const account: any = await Admin.findById(accountId).select('role canManageWhatsAppTemplates').lean();
  return accountCanManageTemplates(account) ? (account.role as TemplateRole) : null;
};
