import mongoose from 'mongoose';
import { Event } from '../models/Event';
import { WhatsAppSender } from '../models/WhatsAppSender';
import { EventTemplateError } from './eventTemplateMessage';
import { resolveEventOwner } from './eventOwnership';
import { refreshSenderStatusIfStale, createTokenStatusClient, type MetaSenderClient } from './whatsappSenderSyncService';
import { embeddedSenderProblems, isEmbeddedSender, ownerMayUseSender, ownerRefusal } from './senderEligibility';
import { readSenderAccessToken } from './whatsappOnboardingService';
import type { SendTarget } from './WhatsAppService';

/**
 * Which WhatsApp number a send for an event goes out from - checked at the
 * moment of sending, on the server, by every send path (the Composer and the
 * campaign queue).
 *
 * The sender is the event's own assignment, else its Main Event's (for a
 * Sub-Event), else - only when neither has one - the environment sender
 * (WHATSAPP_PHONE_ID), exactly as every unassigned event sends today.
 *
 * An assigned sender must be usable right now: still in the inventory, in
 * the configured WhatsApp Business Account, enabled, listed by Meta, allowed
 * for the event's owning Admin (decision A - the caller's own permissions do
 * not count, and a Super Admin is no exception), and CONNECTED by a status
 * no older than 15 minutes, checked with Meta if it is. If any of that fails,
 * nothing is sent. An assigned sender is never swapped for the environment
 * sender: the send fails closed instead.
 *
 * The sender comes only from the event. No request field can choose it.
 */

export class SenderUnavailableError extends EventTemplateError {
  constructor(code: string, message: string, httpStatus: number) {
    super(code, message, httpStatus);
    this.name = 'SenderUnavailableError';
  }
}

export type ResolvedSender =
  | { kind: 'environment' }
  | {
      kind: 'assigned';
      source: 'event' | 'main-event';
      senderId: string;
      phoneNumberId: string;
      displayPhoneNumber: string;
      /**
       * Whose credential sends for it: 'environment' (WHATSAPP_TOKEN) for an
       * inventory sender, 'sender' (its own stored business token) for a number
       * connected through Embedded Signup. The token itself is never carried
       * here - it is read at the moment of sending (sendTargetFor).
       */
      credential: 'environment' | 'sender';
    };

export interface SenderResolutionDeps {
  /** Meta status client; the live one when omitted. Tests inject a mock. */
  client?: MetaSenderClient;
}

const NOTHING_SENT = 'Nothing was sent.';

const loadEvent = async (eventOrId: any) => {
  if (eventOrId && typeof eventOrId === 'object' && 'parentEventId' in eventOrId && 'whatsappSenderId' in eventOrId) return eventOrId;
  const id = eventOrId && typeof eventOrId === 'object' && eventOrId._id ? eventOrId._id : eventOrId;
  if (!id || !mongoose.isValidObjectId(String(id))) return null;
  return Event.findById(String(id)).select('adminId createdBy parentEventId whatsappSenderId').lean();
};

export const resolveSendingSender = async (eventOrId: any, deps: SenderResolutionDeps = {}): Promise<ResolvedSender> => {
  const event: any = await loadEvent(eventOrId);
  if (!event) throw new SenderUnavailableError('EVENT_NOT_FOUND', `Event not found. ${NOTHING_SENT}`, 404);

  let assignedId: string | null = event.whatsappSenderId ? String(event.whatsappSenderId) : null;
  let source: 'event' | 'main-event' = 'event';
  if (!assignedId && event.parentEventId) {
    const main: any = await Event.findById(event.parentEventId).select('whatsappSenderId').lean();
    if (!main) {
      // Without the Main Event its assignment is unknown; the environment
      // sender is not assumed in its place.
      throw new SenderUnavailableError('SENDER_UNVERIFIED', `The Sub-Event's Main Event no longer exists, so its WhatsApp sender cannot be determined. ${NOTHING_SENT}`, 409);
    }
    if (main.whatsappSenderId) {
      assignedId = String(main.whatsappSenderId);
      source = 'main-event';
    }
  }
  if (!assignedId) return { kind: 'environment' };

  const whose = source === 'event' ? "This event's" : "The Main Event's";
  const sender: any = await WhatsAppSender.findById(assignedId).select('+credential').lean();
  if (!sender) {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `${whose} WhatsApp sender is no longer in the sender inventory. ${NOTHING_SENT}`, 409);
  }
  // A number a business connected itself (Embedded Signup): its own account,
  // its own credential, and the owner rule in senderEligibility.
  if (isEmbeddedSender(sender)) return resolveEmbeddedSender(event, sender, source, whose, deps);
  const configuredWaba = process.env.WHATSAPP_WABA_ID?.trim();
  if (!configuredWaba || String(sender.wabaId) !== configuredWaba) {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `${whose} WhatsApp sender belongs to a different WhatsApp Business Account. ${NOTHING_SENT}`, 409);
  }
  if (!sender.enabled) {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `${whose} WhatsApp sender is disabled. ${NOTHING_SENT}`, 409);
  }
  if (!sender.listedInMeta) {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `${whose} WhatsApp sender is no longer listed in the WhatsApp Business Account. ${NOTHING_SENT}`, 409);
  }

  // Decision A: the event's owning Admin must be allowed to use this sender.
  const owner = await resolveEventOwner(event);
  if (owner.kind === 'unverified') {
    throw new SenderUnavailableError('EVENT_OWNER_UNVERIFIED', `${owner.reason} An assigned WhatsApp sender is used only for an event with a verified owning Admin. ${NOTHING_SENT}`, 409);
  }
  if (owner.kind === 'superadmin') {
    throw new SenderUnavailableError('SENDER_NOT_ALLOWED', `This event is owned by a Super Admin, and an assigned WhatsApp sender can be used only by events owned by an Admin on its allowed list. Remove the assignment to send from the default sender. ${NOTHING_SENT}`, 409);
  }
  if (!(sender.allowedAdminIds || []).some((id: any) => String(id) === owner.adminId)) {
    throw new SenderUnavailableError('SENDER_NOT_ALLOWED', `The event's owning Admin is not allowed to use its assigned WhatsApp sender. ${NOTHING_SENT}`, 409);
  }

  let status: string | null;
  try {
    status = await refreshSenderStatusIfStale(sender, deps.client);
  } catch {
    throw new SenderUnavailableError('SENDER_STATUS_UNVERIFIED', `The assigned WhatsApp sender's status could not be verified with WhatsApp. ${NOTHING_SENT} Try again shortly.`, 502);
  }
  if (status !== 'CONNECTED') {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `${whose} WhatsApp sender is not connected (WhatsApp reports ${status ?? 'no status'}). ${NOTHING_SENT}`, 409);
  }

  return { kind: 'assigned', source, senderId: String(sender._id), phoneNumberId: String(sender.phoneNumberId), displayPhoneNumber: String(sender.displayPhoneNumber), credential: 'environment' };
};

/**
 * The same guarantees for a connected (Embedded Signup) number: connected and
 * enabled here, its stored credential present, the event's owner allowed to use
 * it (its owner's own events, or an allowed Admin's), and CONNECTED at Meta by a
 * fresh status - checked with ITS OWN credential. Any failure refuses the send;
 * it never falls back to the environment sender.
 */
const resolveEmbeddedSender = async (event: any, sender: any, source: 'event' | 'main-event', whose: string, deps: SenderResolutionDeps): Promise<ResolvedSender> => {
  const problems = embeddedSenderProblems(sender, Boolean(sender.credential?.ciphertext));
  if (problems.length > 0) {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `${whose} WhatsApp sender cannot be used: ${problems[0]} ${NOTHING_SENT}`, 409);
  }
  const owner = await resolveEventOwner(event);
  if (owner.kind === 'unverified') {
    throw new SenderUnavailableError('EVENT_OWNER_UNVERIFIED', `${owner.reason} An assigned WhatsApp sender is used only for an event with a verified owning Admin. ${NOTHING_SENT}`, 409);
  }
  if (!ownerMayUseSender(sender, owner)) {
    throw new SenderUnavailableError('SENDER_NOT_ALLOWED', `${ownerRefusal(sender, owner)} ${NOTHING_SENT}`, 409);
  }

  let status: string | null;
  try {
    const client = deps.client ?? createTokenStatusClient(await readSenderAccessToken(String(sender._id)));
    status = await refreshSenderStatusIfStale(sender, client);
  } catch {
    throw new SenderUnavailableError('SENDER_STATUS_UNVERIFIED', `The assigned WhatsApp sender's status could not be verified with WhatsApp. ${NOTHING_SENT} Try again shortly.`, 502);
  }
  if (status !== 'CONNECTED') {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `${whose} WhatsApp sender is not connected (WhatsApp reports ${status ?? 'no status'}). ${NOTHING_SENT}`, 409);
  }
  return { kind: 'assigned', source, senderId: String(sender._id), phoneNumberId: String(sender.phoneNumberId), displayPhoneNumber: String(sender.displayPhoneNumber), credential: 'sender' };
};

/**
 * Re-checks, during a send already under way, that the event still resolves
 * to the same, still-eligible sender. Called before each recipient (Composer)
 * and each batch (campaign queue), so a sender disabled, disconnected or
 * reassigned part-way through stops the remaining messages.
 */
export const assertSameSender = async (eventOrId: any, expected: ResolvedSender, deps: SenderResolutionDeps = {}): Promise<ResolvedSender> => {
  const current = await resolveSendingSender(eventOrId, deps);
  const same = current.kind === expected.kind && (current.kind === 'environment' || (expected.kind === 'assigned' && current.senderId === expected.senderId));
  if (!same) {
    throw new SenderUnavailableError('SENDER_CHANGED', "The event's WhatsApp sender changed while messages were being sent. The remaining messages were not sent.", 409);
  }
  return current;
};

/** The phone number id to send from, or undefined for the environment sender (unchanged default). */
export const sendingPhoneNumberId = (sender: ResolvedSender): string | undefined =>
  sender.kind === 'assigned' ? sender.phoneNumberId : undefined;

/**
 * Where and with what a message goes out: the resolved sender's phone number id
 * and, for a connected number, its own decrypted business token - read now, at
 * the moment of sending, and never stored on a job or logged. {} is the
 * environment sender (WHATSAPP_PHONE_ID with WHATSAPP_TOKEN), unchanged. A
 * connected number whose token cannot be read refuses the send; it is never
 * sent with the environment token instead.
 */
export const sendTargetFor = async (sender: ResolvedSender): Promise<SendTarget> => {
  if (sender.kind === 'environment') return {};
  if (sender.credential !== 'sender') return { phoneNumberId: sender.phoneNumberId };
  try {
    return { phoneNumberId: sender.phoneNumberId, accessToken: await readSenderAccessToken(sender.senderId) };
  } catch {
    throw new SenderUnavailableError('SENDER_UNAVAILABLE', `The assigned WhatsApp sender's stored authorization could not be used. Its owner must connect it again. ${NOTHING_SENT}`, 409);
  }
};
