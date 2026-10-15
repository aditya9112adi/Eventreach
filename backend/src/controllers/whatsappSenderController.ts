import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { Event } from '../models/Event';
import { Admin } from '../models/Admin';
import { WhatsAppSender } from '../models/WhatsAppSender';
import { AuditService } from '../services/AuditService';
import { isEventAuthorized } from '../services/eventAuthService';
import { forceRefreshSenderStatus, refreshSenderStatusIfStale, syncWhatsAppSenders } from '../services/whatsappSenderSyncService';
import { canEditEventContact } from '../services/eventOwnership';
import { isSenderStatusFresh } from '../services/whatsappSenderPolicy';
import { createTokenStatusClient } from '../services/whatsappSenderSyncService';
import { embeddedSenderProblems, isEmbeddedSender, ownerMayUseSender, ownerRefusal } from '../services/senderEligibility';
import { resolveEventOwner } from '../services/eventOwnership';
import { readSenderAccessToken } from '../services/whatsappOnboardingService';

const senderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  pocTestEnabled: z.boolean().optional(),
  label: z.string().trim().max(100).optional(),
  allowedAdminIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).optional(),
}).strict();

const contactSchema = z.object({
  poc: z.object({
    name: z.string().trim().min(1).max(100),
    mobile: z.string().trim().min(3).max(40),
    email: z.string().trim().email().max(254).optional().or(z.literal('')),
    responsibility: z.string().trim().max(120).optional(),
  }).strict().nullable().optional(),
  whatsappSenderId: z.string().regex(/^[a-f\d]{24}$/i).nullable().optional(),
}).strict();

const senderPublic = (sender: any, viewerRole?: string) => ({
  _id: String(sender._id),
  phoneNumberId: sender.phoneNumberId,
  isEnvironmentSender: Boolean(process.env.WHATSAPP_PHONE_ID?.trim() && process.env.WHATSAPP_PHONE_ID.trim() === sender.phoneNumberId),
  displayPhoneNumber: sender.displayPhoneNumber,
  verifiedName: sender.verifiedName,
  qualityRating: sender.qualityRating ?? null,
  metaStatus: sender.metaStatus ?? null,
  listedInMeta: sender.listedInMeta,
  enabled: sender.enabled,
  label: sender.label ?? '',
  lastSyncedAt: sender.lastSyncedAt ?? null,
  statusCheckedAt: sender.statusCheckedAt ?? null,
  source: sender.source ?? 'inventory',
  onboardingStatus: sender.onboardingStatus ?? null,
  nextActionMessage: sender.nextActionMessage ?? null,
  // The Business Account id, the allowlist (other Admins' ids) and the POC designation are for
  // Super Admins only. Any other viewer - or none given - gets none of them, so a
  // new caller of this function is private by default.
  ...(viewerRole === 'SuperAdmin'
    ? {
        wabaId: sender.wabaId,
        allowedAdminIds: (sender.allowedAdminIds || []).map(String),
        pocTestEnabled: Boolean(sender.pocTestEnabled),
        ownerAccountId: sender.ownerAccountId ? String(sender.ownerAccountId) : null,
        lastError: sender.lastError?.message ? { message: sender.lastError.message, at: sender.lastError.at ?? null } : null,
        lastVerifiedAt: sender.lastVerifiedAt ?? null,
      }
    : {}),
});

export const listWhatsAppSenders = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const query: Record<string, unknown> = {};
    if (user.role !== 'SuperAdmin') {
      // Their allowed senders, as before - plus every number they connected
      // themselves, usable or not, so the reason it is unavailable can be shown.
      query.$or = [
        { enabled: true, listedInMeta: true, allowedAdminIds: user.id },
        { source: 'embedded_signup', ownerAccountId: user.id },
      ];
    }
    const senders = await WhatsAppSender.find(query).select('+credential').sort({ displayPhoneNumber: 1 }).lean();
    return res.json({
      senders: senders.map((s: any) => ({
        ...senderPublic(s, user.role),
        // Why a connected number cannot be assigned yet, from what is stored.
        ...(isEmbeddedSender(s) ? { unavailableReasons: embeddedSenderProblems(s, Boolean(s.credential?.ciphertext)) } : {}),
      })),
    });
  } catch (error) {
    console.error('List WhatsApp senders failed:', error);
    return res.status(500).json({ error: 'Failed to list WhatsApp senders' });
  }
};

export const syncWhatsAppSendersController = async (req: Request, res: Response) => {
  try {
    const result = await syncWhatsAppSenders();
    await AuditService.log({
      action: 'WHATSAPP_SENDERS_SYNCED', collectionName: 'whatsapp_senders',
      actor: AuditService.getActorFromReq(req), request: AuditService.getRequestInfo(req),
      description: `Synced WhatsApp senders from Meta (${result.discovered} discovered)`,
      metadata: { discovered: result.discovered, upserted: result.upserted },
    });
    return res.json({ success: true, ...result });
  } catch (error: any) {
    // Do not return provider response bodies, request headers, or credentials.
    console.error('WhatsApp sender sync failed:', error?.message || 'unknown error');
    return res.status(502).json({ error: error?.message === 'WHATSAPP_WABA_ID is not configured.' ? error.message : 'Unable to sync senders from Meta.' });
  }
};

export const updateWhatsAppSender = async (req: Request, res: Response) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid sender id' });
    const parsed = senderSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid sender settings' });
    const sender: any = await WhatsAppSender.findById(req.params.id);
    if (!sender) return res.status(404).json({ error: 'Sender not found' });
    const before = sender.toObject();
    const updates = parsed.data;
    if (updates.allowedAdminIds) {
      const unique = [...new Set(updates.allowedAdminIds)];
      const count = await Admin.countDocuments({ _id: { $in: unique }, role: 'Admin', status: 'Active', isAccessCancelled: { $ne: true } });
      if (count !== unique.length) return res.status(400).json({ error: 'Allowed IDs must belong to existing Admin accounts.' });
      sender.allowedAdminIds = unique;
    }
    if (updates.enabled !== undefined) sender.enabled = updates.enabled;
    if (updates.pocTestEnabled !== undefined) sender.pocTestEnabled = updates.pocTestEnabled;
    if (updates.label !== undefined) sender.label = updates.label;
    await sender.save();
    await AuditService.log({
      action: 'WHATSAPP_SENDER_UPDATED', collectionName: 'whatsapp_senders', documentId: String(sender._id),
      actor: AuditService.getActorFromReq(req), request: AuditService.getRequestInfo(req),
      before, after: sender, description: `Updated WhatsApp sender ${sender.displayPhoneNumber}`,
    });
    return res.json({ sender: senderPublic(sender, (req as any).user?.role) });
  } catch (error) {
    console.error('Update WhatsApp sender failed:', error);
    return res.status(500).json({ error: 'Failed to update WhatsApp sender' });
  }
};

/**
 * A Super Admin's "Refresh status": asks Meta now and says so. If Meta was
 * asked about this sender within the last minute, nothing is requested and
 * the answer says that the stored status is being shown (429). A failure
 * leaves the stored status unchanged and says so (502). `refreshed` is true
 * only when Meta actually answered.
 */
export const refreshWhatsAppSenderStatus = async (req: Request, res: Response) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid sender id' });
    const sender: any = await WhatsAppSender.findById(req.params.id);
    if (!sender) return res.status(404).json({ error: 'Sender not found' });
    const result = await forceRefreshSenderStatus(sender);
    const current: any = await WhatsAppSender.findById(sender._id).select('metaStatus statusCheckedAt').lean();
    if (!result.refreshed) {
      return res.status(429).json({
        refreshed: false,
        error: `This sender's status was checked with Meta less than a minute ago. The stored status is shown; try again in ${result.retryAfterSeconds}s.`,
        metaStatus: current?.metaStatus ?? null,
        checkedAt: current?.statusCheckedAt ?? null,
      });
    }
    return res.json({ refreshed: true, phoneNumberId: sender.phoneNumberId, metaStatus: result.status, checkedAt: current?.statusCheckedAt ?? null });
  } catch (error: any) {
    console.error('WhatsApp sender status refresh failed:', error?.message || 'unknown error');
    return res.status(502).json({ refreshed: false, error: 'Unable to refresh sender status from Meta. The stored status was not changed.' });
  }
};

/**
 * A stored POC, or null. `poc` is a nested path, so a hydrated document reads
 * as an object even when nothing is stored (`{}`, or a truthy wrapper after
 * being cleared); only a POC with a name counts.
 */
const pocOf = (raw: any) => {
  const value = raw && typeof raw.toObject === 'function' ? raw.toObject() : raw;
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim()) return null;
  return {
    name: value.name,
    mobile: value.mobile,
    ...(value.email ? { email: value.email } : {}),
    ...(value.responsibility ? { responsibility: value.responsibility } : {}),
  };
};

const senderIdOf = (raw: any): string | null => (raw ? String(raw) : null);

/**
 * What the contact panel shows about a sender. statusFresh says whether
 * metaStatus was confirmed within the freshness window, so a stale or unknown
 * status is never presented as a current CONNECTED.
 */
const senderSummary = (sender: any) => sender ? {
  _id: String(sender._id),
  displayPhoneNumber: sender.displayPhoneNumber,
  verifiedName: sender.verifiedName,
  metaStatus: sender.metaStatus ?? null,
  enabled: Boolean(sender.enabled),
  listedInMeta: Boolean(sender.listedInMeta),
  statusCheckedAt: sender.statusCheckedAt ?? null,
  statusFresh: isSenderStatusFresh(sender.statusCheckedAt),
} : null;

const SENDER_SUMMARY_FIELDS = 'displayPhoneNumber verifiedName metaStatus enabled listedInMeta statusCheckedAt';

/**
 * The POC and sender an event effectively uses: its own, otherwise its Main
 * Event's (for a Sub-Event), otherwise - for the sender - the environment
 * sender (WHATSAPP_PHONE_ID), which every unassigned event sends from today.
 *
 * The environment sender is looked up in the synced inventory by its phone
 * number id, so the panel shows its real number and name. The id itself is
 * not returned; environmentSenderConfigured only says whether one is set.
 */
const effectiveContact = async (event: any) => {
  const parent: any = event.parentEventId ? await Event.findById(event.parentEventId).select('poc whatsappSenderId').lean() : null;
  const localPoc = pocOf(event.poc);
  const parentPoc = pocOf(parent?.poc);
  const localSenderId = senderIdOf(event.whatsappSenderId);
  const parentSenderId = senderIdOf(parent?.whatsappSenderId);
  const assignedSenderId = localSenderId || parentSenderId;
  const environmentPhoneId = process.env.WHATSAPP_PHONE_ID?.trim() || null;

  const effectiveSender = assignedSenderId
    ? await WhatsAppSender.findById(assignedSenderId).select(SENDER_SUMMARY_FIELDS).lean()
    : environmentPhoneId
      ? await WhatsAppSender.findOne({ phoneNumberId: environmentPhoneId }).select(SENDER_SUMMARY_FIELDS).lean()
      : null;

  return {
    poc: localPoc || parentPoc || null,
    whatsappSenderId: assignedSenderId,
    effectiveSender: senderSummary(effectiveSender),
    assignmentSource: localSenderId ? 'event' : parentSenderId ? 'main-event' : 'environment',
    pocSource: localPoc ? 'event' : parentPoc ? 'main-event' : 'none',
    environmentSenderConfigured: Boolean(environmentPhoneId),
  };
};

/** The response for an event's contact panel, from a lean (plain) event. */
const contactResponse = async (event: any) => ({
  ...await effectiveContact(event),
  localPoc: pocOf(event.poc),
  localWhatsAppSenderId: senderIdOf(event.whatsappSenderId),
});

export const getEventContact = async (req: Request, res: Response) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid event id' });
    const user = (req as any).user;
    if (!(await isEventAuthorized(user, req.params.id))) return res.status(403).json({ error: 'Access denied' });
    const event: any = await Event.findById(req.params.id).select('poc whatsappSenderId parentEventId').lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    return res.json(await contactResponse(event));
  } catch (error) {
    console.error('Get event contact failed:', error);
    return res.status(500).json({ error: 'Failed to fetch event contact settings' });
  }
};

export const updateEventContact = async (req: Request, res: Response) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid event id' });
    const user = (req as any).user;
    if (!user || !['SuperAdmin', 'Admin'].includes(user.role)) return res.status(403).json({ error: 'Only Admins and SuperAdmins can edit event contact settings.' });
    if (!(await isEventAuthorized(user, req.params.id))) return res.status(403).json({ error: 'Access denied' });
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message || 'Invalid contact settings' });
    const event: any = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // Decision B: seeing an event (isEventAuthorized, above) is not enough to
    // change its POC or sender - only its owning Admin or a Super Admin may.
    if (!(await canEditEventContact(user, event))) {
      return res.status(403).json({ error: "Only the event's owning Admin or a Super Admin can edit its contact settings." });
    }

    if (parsed.data.poc !== undefined && parsed.data.poc !== null) {
      const mobile = parsePhoneNumberFromString(parsed.data.poc.mobile, 'IN');
      if (!mobile?.isValid()) return res.status(400).json({ error: 'Enter a valid POC mobile number, including country code for international numbers.' });
      parsed.data.poc.mobile = mobile.number;
      if (parsed.data.poc.email === '') parsed.data.poc.email = undefined;
    }
    const currentSenderId = senderIdOf(event.whatsappSenderId);
    // A new assignment is checked; keeping the current one is not, so a POC
    // can still be edited after the event's sender has become unavailable.
    // Sending re-checks the sender separately (a later stage).
    if (parsed.data.whatsappSenderId && parsed.data.whatsappSenderId !== currentSenderId) {
      const sender: any = await WhatsAppSender.findById(parsed.data.whatsappSenderId).select('+credential').lean();
      if (!sender) return res.status(400).json({ error: 'Selected WhatsApp sender was not synced from Meta.' });
      if (isEmbeddedSender(sender)) {
        // A connected number: usable only for its owner's events or an allowed
        // Admin's, only once connected and enabled, and checked with its own token.
        const problems = embeddedSenderProblems(sender, Boolean(sender.credential?.ciphertext));
        if (problems.length > 0) return res.status(409).json({ error: problems[0], reasons: problems });
        const owner = await resolveEventOwner(event);
        if (!ownerMayUseSender(sender, owner)) return res.status(403).json({ error: ownerRefusal(sender, owner) });
        if (user.role === 'Admin' && String(sender.ownerAccountId) !== String(user.id) && !(sender.allowedAdminIds || []).some((id: any) => String(id) === String(user.id))) {
          return res.status(403).json({ error: 'You are not allowed to assign this WhatsApp sender.' });
        }
        let connectedStatus: string | null;
        try {
          connectedStatus = await refreshSenderStatusIfStale(sender, createTokenStatusClient(await readSenderAccessToken(String(sender._id))));
        } catch {
          return res.status(502).json({ error: 'Could not verify the number with WhatsApp; assignment was not saved.' });
        }
        if (connectedStatus !== 'CONNECTED') return res.status(409).json({ error: `WhatsApp reports this number as ${connectedStatus ?? 'unknown'}.` });
      } else {
      // Local checks first: an Admin who may not use this sender, or a sender
      // that is disabled, unlisted or in another account, never causes a call
      // to Meta.
      if (user.role === 'Admin' && !(sender.allowedAdminIds || []).some((id: any) => String(id) === String(user.id))) {
        return res.status(403).json({ error: 'You are not allowed to assign this WhatsApp sender.' });
      }
      if (!sender.listedInMeta || !sender.enabled) return res.status(409).json({ error: 'Selected WhatsApp sender is not enabled and connected.' });
      if (String(sender.wabaId) !== String(process.env.WHATSAPP_WABA_ID || '').trim()) {
        return res.status(409).json({ error: 'Selected WhatsApp sender belongs to a different WhatsApp Business Account.' });
      }
      let freshStatus: string | null;
      try {
        freshStatus = await refreshSenderStatusIfStale(sender);
      } catch {
        return res.status(502).json({ error: 'Could not verify sender status freshness; assignment was not saved.' });
      }
      if (freshStatus !== 'CONNECTED') return res.status(409).json({ error: 'Selected WhatsApp sender is not enabled and connected.' });
      }
    }

    const before = { poc: pocOf(event.poc), whatsappSenderId: currentSenderId };
    if (parsed.data.poc !== undefined) event.poc = parsed.data.poc;
    if (parsed.data.whatsappSenderId !== undefined) event.whatsappSenderId = parsed.data.whatsappSenderId;
    await event.save();
    // Read back as stored: the response and the audit record show what is
    // actually saved, with an inherited value showing once a local one is cleared.
    const saved: any = await Event.findById(event._id).select('poc whatsappSenderId parentEventId').lean();
    const after = { poc: pocOf(saved?.poc), whatsappSenderId: senderIdOf(saved?.whatsappSenderId) };
    await AuditService.log({
      action: 'EVENT_CONTACT_SETTINGS_UPDATED', collectionName: 'events', documentId: String(event._id),
      actor: AuditService.getActorFromReq(req), request: AuditService.getRequestInfo(req), before, after,
      description: `Updated point of contact and WhatsApp sender for event ${event.eventName}`,
    });
    return res.json(await contactResponse(saved));
  } catch (error) {
    console.error('Update event contact settings failed:', error);
    return res.status(500).json({ error: 'Failed to update event contact settings' });
  }
};
