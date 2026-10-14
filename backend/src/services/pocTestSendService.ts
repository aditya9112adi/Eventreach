import crypto from 'crypto';
import mongoose from 'mongoose';
import { WhatsAppSender } from '../models/WhatsAppSender';
import { WhatsAppTemplate } from '../models/WhatsAppTemplate';
import { PocTestRecipient, POC_RECIPIENTS_PER_OWNER } from '../models/PocTestRecipient';
import { TemplateTestSend, TEST_SEND_RETENTION_DAYS, type ITemplateTestSend, type TestSendDelivery } from '../models/TemplateTestSend';
import { AuditLog } from '../models/AuditLog';
import { AuditService, type AuditParams } from './AuditService';
import { normalizeIndianPhone } from '../utils/indianPhone';
import { templateManagerRole } from './templatePermission';
import { isTemplateSendable } from './templateDefinition';
import { canViewTemplate, type TemplateActor } from './templateService';
import { refreshSenderStatusIfStale, isSenderStatusFresh, type MetaSenderClient } from './whatsappSenderSyncService';
import {
  LANGUAGE_CODE_PATTERN,
  WhatsAppTemplateError,
  readTemplateConfig,
  sendTemplateMessage,
  validateTemplateMessage,
  type TemplateHttpPost,
} from './whatsappTemplateService';

/**
 * Testing an approved template from the designated proof-of-concept (POC)
 * WhatsApp sender.
 *
 * WHAT THIS IS NOT. It is not a campaign and not a way around the sender rules
 * for events. It sends ONE template message to ONE person who agreed to
 * receive tests, from a sender a Super Admin designated for it, and records
 * exactly what happened.
 *
 * WHAT MAKES A SEND POSSIBLE - all of it checked on the server, on every
 * preview and again on send, none of it taken from the browser:
 *   caller    a Super Admin, or an Admin with the template-management grant
 *             who is on the sender's allowed list. Read from the database.
 *   sender    designated for POC tests, enabled, still listed by Meta, in the
 *             configured WhatsApp Business Account, and CONNECTED by a status
 *             checked with Meta in the last 15 minutes. Its phone number id is
 *             the one the message goes out from; there is NO fallback to any
 *             other number - not the environment sender, not another POC
 *             sender. If it is unusable, nothing is sent.
 *   template  one EventReach holds, Approved locally AND by Meta, in the same
 *             WhatsApp Business Account as the sender (templates belong to the
 *             account, so a sender only ever sees its own account's), visible
 *             to the caller.
 *   recipient registered with a recorded consent, active, the caller's own
 *             (a Super Admin may use any).
 *   variables exactly as many as the template has placeholders, each valid
 *             for Meta (the same rules as every other template send).
 *
 * TWO STEPS, NEVER ONE. `preview` checks all of the above, shows what would be
 * sent and returns a hash of it plus a one-time idempotency key. `send` needs
 * `confirmed: true`, that hash and that key; if anything changed in between,
 * the hash no longer matches and nothing is sent. No GET route, page load,
 * refresh, poll or retry of a read can send.
 *
 * AT-MOST-ONCE PER KEY, HONESTLY. The record is written BEFORE the request to
 * Meta (and so is its audit entry: if it cannot be saved, nothing is sent). A
 * unique index on (actor, key) means the same key claims once, so a double
 * click, a client retry or two instances send once. If the answer is lost -
 * timeout, a 2xx without a message id, a Meta "unexpected error", a crash -
 * the outcome is UNKNOWN and stays so until a person reconciles it. A new
 * preview for the same message is refused (DUPLICATE_RISK) unless the person
 * explicitly acknowledges that the earlier one may have arrived. Two
 * DIFFERENT keys racing for the same message are caught by a read-then-insert
 * guard, which is not a distributed lock and can lose a true race.
 *
 * PRIVACY. No message content or variable values and no full phone number are
 * stored in the test-send record or the audit trail: the recipient appears as
 * its id and masked form.
 *
 * MULTIPLE INSTANCES. State lives in MongoDB, so instances agree about claims,
 * outcomes and the hourly limit. The only in-process state is the sender
 * status refresh cooldown already used by event sends.
 */

export class PocTestError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly field?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, httpStatus: number, options: { field?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'PocTestError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.field = options.field;
    this.details = options.details;
  }

  toResponse() {
    return {
      success: false as const,
      error: { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}), ...(this.details ? { details: this.details } : {}) },
    };
  }
}

export interface PocActor {
  id: string;
  email?: string;
  role?: string;
  name?: string;
}

export interface PocTestDeps {
  /** The HTTP call to Meta's messages endpoint. Tests inject a double; never reached otherwise. */
  post?: TemplateHttpPost;
  /** Meta status client for the sender's CONNECTED check. */
  client?: MetaSenderClient;
  now?: () => Date;
  /** Who is acting and from where, as AuditService reads them off the request. */
  auditContext?: { request?: AuditParams['request'] };
}

/** A claim older than this has no live process behind it. Longer than the 30 s request timeout. */
export const TEST_SEND_LEASE_MS = 2 * 60 * 1000;
export const TEST_SENDS_PER_HOUR = 20;
/** An Accepted send of the same message within this window needs an explicit acknowledgement to repeat. */
export const RECENT_ACCEPTED_WINDOW_MS = 10 * 60 * 1000;
/** An Unknown or in-flight one blocks a repeat for this long. */
export const UNCERTAIN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Meta's own codes for "something went wrong on our side": the message may or may not exist. */
const AMBIGUOUS_META_CODES = new Set([1, 2, 131000, 131016]);

const nowOf = (deps: PocTestDeps) => (deps.now ? deps.now() : new Date());
const NOTHING_SENT = 'Nothing was sent.';

/** "+91******2833": enough to recognise a number, not to use it. */
export const maskPhone = (value: string): string => {
  const digits = String(value ?? '');
  return digits.length > 7 ? `${digits.slice(0, 3)}${'*'.repeat(digits.length - 7)}${digits.slice(-4)}` : '****';
};

// ── caller and configuration ────────────────────────────────────────────────

const requireActor = async (caller: PocActor): Promise<PocActor & { role: 'SuperAdmin' | 'Admin' }> => {
  const role = await templateManagerRole(caller?.id);
  if (!role) throw new PocTestError('ACCESS_DENIED', 'You do not have permission to send WhatsApp test messages.', 403);
  return { ...caller, id: String(caller.id), role };
};

export const pocConfigStatus = (env: NodeJS.ProcessEnv = process.env) => {
  const tokenConfigured = Boolean(env.WHATSAPP_TOKEN?.trim());
  const wabaConfigured = Boolean(env.WHATSAPP_WABA_ID?.trim());
  return {
    tokenConfigured,
    wabaConfigured,
    // Names only, never values.
    missing: [!tokenConfigured ? 'WHATSAPP_TOKEN' : null, !wabaConfigured ? 'WHATSAPP_WABA_ID' : null].filter(Boolean) as string[],
  };
};

const requireConfigured = () => {
  const status = pocConfigStatus();
  if (status.missing.length > 0) {
    throw new PocTestError('CONFIGURATION_ERROR', `WhatsApp is not configured on the server (missing ${status.missing.join(', ')}). ${NOTHING_SENT}`, 503);
  }
  return process.env.WHATSAPP_WABA_ID!.trim();
};

const auditActor = (actor: PocActor) => ({ userId: actor.id, email: actor.email ?? null, name: actor.name ?? actor.email ?? null, role: actor.role ?? null });

const validObjectId = (value: unknown): value is string => typeof value === 'string' && mongoose.Types.ObjectId.isValid(value) && /^[a-f\d]{24}$/i.test(value);

// ── senders ─────────────────────────────────────────────────────────────────

/** Why this sender cannot be used by this caller, from what is stored. Empty: no stored reason against it. */
const senderReasons = (sender: any, actor: PocActor, configuredWaba: string | null): string[] => {
  const reasons: string[] = [];
  if (!sender.pocTestEnabled) reasons.push('This sender is not designated for POC test messages.');
  if (!sender.enabled) reasons.push('This sender is disabled.');
  if (!sender.listedInMeta) reasons.push('This sender is no longer listed in the WhatsApp Business Account.');
  if (!configuredWaba) reasons.push('The WhatsApp Business Account is not configured on the server.');
  else if (String(sender.wabaId) !== configuredWaba) reasons.push('This sender belongs to a different WhatsApp Business Account than the one configured.');
  if (actor.role !== 'SuperAdmin' && !(sender.allowedAdminIds || []).some((id: any) => String(id) === actor.id)) {
    reasons.push('You are not on this sender\'s allowed list.');
  }
  return reasons;
};

export const listPocSenders = async (caller: PocActor, deps: PocTestDeps = {}) => {
  const actor = await requireActor(caller);
  const config = pocConfigStatus();
  const configuredWaba = process.env.WHATSAPP_WABA_ID?.trim() || null;
  const senders: any[] = await WhatsAppSender.find({ pocTestEnabled: true }).sort({ displayPhoneNumber: 1 }).lean();
  const now = nowOf(deps).getTime();

  return {
    config,
    senders: senders
      .map((s) => {
        const reasons = senderReasons(s, actor, configuredWaba);
        // Only the caller's own eligible senders are listed; others' are not revealed.
        if (actor.role !== 'SuperAdmin' && reasons.some((r) => r.includes('allowed list'))) return null;
        const fresh = isSenderStatusFresh(s.statusCheckedAt, now);
        const connected = s.metaStatus === 'CONNECTED';
        const stored = [...reasons];
        if (!connected) stored.push(`WhatsApp reports this number as ${s.metaStatus ?? 'unknown'}.`);
        return {
          id: String(s._id),
          label: s.label || s.verifiedName,
          verifiedName: s.verifiedName,
          displayPhoneNumberMasked: maskPhone(String(s.displayPhoneNumber).replace(/[\s()-]/g, '')),
          metaStatus: s.metaStatus ?? null,
          statusCheckedAt: s.statusCheckedAt ?? null,
          statusFresh: fresh,
          qualityRating: s.qualityRating ?? null,
          capabilities: {
            pocTestEnabled: Boolean(s.pocTestEnabled),
            enabled: Boolean(s.enabled),
            listedInMeta: Boolean(s.listedInMeta),
            inConfiguredAccount: Boolean(configuredWaba && String(s.wabaId) === configuredWaba),
            allowedForYou: actor.role === 'SuperAdmin' || (s.allowedAdminIds || []).some((id: any) => String(id) === actor.id),
            connected,
          },
          // From stored data only: the live check with Meta happens on preview and on send.
          eligible: stored.length === 0,
          reasons: stored,
        };
      })
      .filter(Boolean),
  };
};

// ── templates for a sender ──────────────────────────────────────────────────

const templateReasons = (template: any, actor: TemplateActor, sender: any): string[] => {
  const reasons: string[] = [];
  if (String(template.wabaId) !== String(sender.wabaId)) reasons.push('This template belongs to a different WhatsApp Business Account than the sender.');
  if (!isTemplateSendable(template)) {
    reasons.push(
      template.localState === 'Approved'
        ? `WhatsApp does not list this template as approved (${template.metaStatus ?? 'no status'}).`
        : `This template is not approved (${template.localState}).`
    );
  }
  if (!LANGUAGE_CODE_PATTERN.test(String(template.language))) reasons.push('This template has no valid language code.');
  if (!canViewTemplate(actor, template)) reasons.push('You cannot use this template.');
  return reasons;
};

/**
 * The templates this sender could send, each with whether it can be used now.
 * Only a `sendable` one is ever offered for selection: the others are listed
 * with their reason so nothing looks usable that is not.
 */
export const listPocTemplatesForSender = async (caller: PocActor, senderId: unknown) => {
  const actor = await requireActor(caller);
  if (!validObjectId(senderId)) throw new PocTestError('VALIDATION_ERROR', 'A valid sender is required.', 400, { field: 'senderId' });
  const sender: any = await WhatsAppSender.findById(senderId).lean();
  // A sender that is not designated for POC tests is not part of this feature: it is not revealed either.
  if (!sender || !sender.pocTestEnabled || senderReasons(sender, actor, process.env.WHATSAPP_WABA_ID?.trim() || null).some((r) => r.includes('allowed list'))) {
    throw new PocTestError('SENDER_NOT_FOUND', 'Sender not found.', 404);
  }
  const templates: any[] = await WhatsAppTemplate.find({ wabaId: sender.wabaId }).sort({ updatedAt: -1 }).limit(200).lean();
  return {
    templates: templates
      .filter((t) => canViewTemplate(actor, t))
      .map((t) => {
        const reasons = templateReasons(t, actor, sender);
        return {
          id: String(t._id),
          name: t.name,
          displayName: t.displayName,
          language: t.language,
          category: t.category,
          body: t.body,
          localState: t.localState,
          metaStatus: t.metaStatus ?? null,
          variables: (t.variables || []).map((v: any) => ({ position: v.position, label: v.label, sample: v.sample })),
          buttons: (t.buttons || []).map((b: any) => ({ type: b.type, text: b.text })),
          sendable: reasons.length === 0,
          reasons,
        };
      }),
  };
};

// ── recipients ──────────────────────────────────────────────────────────────

const recipientView = (r: any) => ({
  id: String(r._id),
  label: r.label,
  phoneMasked: maskPhone(r.phone),
  consentNote: r.consentNote,
  consentRecordedAt: r.consentRecordedAt,
  status: r.status,
  revokedAt: r.revokedAt ?? null,
});

export const listPocRecipients = async (caller: PocActor) => {
  const actor = await requireActor(caller);
  const filter = actor.role === 'SuperAdmin' ? {} : { ownerId: actor.id };
  const recipients = await PocTestRecipient.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  return { recipients: recipients.map(recipientView), limit: POC_RECIPIENTS_PER_OWNER };
};

export const registerPocRecipient = async (caller: PocActor, input: { phone?: unknown; label?: unknown; consentConfirmed?: unknown; consentNote?: unknown }, deps: PocTestDeps = {}) => {
  const actor = await requireActor(caller);
  if (input.consentConfirmed !== true) {
    throw new PocTestError('CONSENT_REQUIRED', 'Confirm that this person agreed to receive WhatsApp test messages.', 400, { field: 'consentConfirmed' });
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 100) throw new PocTestError('VALIDATION_ERROR', 'Enter a name for this person (up to 100 characters).', 400, { field: 'label' });
  const consentNote = typeof input.consentNote === 'string' ? input.consentNote.trim() : '';
  if (consentNote.length < 3 || consentNote.length > 300) {
    throw new PocTestError('VALIDATION_ERROR', 'Say how they agreed, in 3 to 300 characters (for example "agreed by message on 12 Oct").', 400, { field: 'consentNote' });
  }
  const phone = normalizeIndianPhone(input.phone);
  if (!phone.ok) throw new PocTestError('VALIDATION_ERROR', `Invalid phone number: ${phone.reason}`, 400, { field: 'phone' });

  const existing = await PocTestRecipient.findOne({ ownerId: actor.id, phone: phone.e164 });
  if (existing) {
    if (existing.status === 'active') throw new PocTestError('ALREADY_REGISTERED', 'This number is already registered.', 409, { field: 'phone' });
    throw new PocTestError('REVOKED_RECIPIENT', 'This number was removed earlier and cannot be added again here. Ask a Super Admin if it needs to be restored.', 409, { field: 'phone' });
  }
  const active = await PocTestRecipient.countDocuments({ ownerId: actor.id, status: 'active' });
  if (active >= POC_RECIPIENTS_PER_OWNER) {
    throw new PocTestError('LIMIT_REACHED', `At most ${POC_RECIPIENTS_PER_OWNER} test recipients can be active. Remove one first.`, 409);
  }

  const created = await PocTestRecipient.create({ ownerId: actor.id, phone: phone.e164, label, consentNote, consentRecordedAt: nowOf(deps) });
  await AuditService.log({
    action: 'POC_TEST_RECIPIENT_REGISTERED',
    collectionName: 'poc_test_recipients',
    documentId: String(created._id),
    actor: auditActor(actor),
    request: deps.auditContext?.request ?? null,
    description: `Registered a POC test recipient (${maskPhone(phone.e164)}) with recorded consent`,
    metadata: { recipientId: String(created._id), recipientMasked: maskPhone(phone.e164) },
  });
  return recipientView(created);
};

export const revokePocRecipient = async (caller: PocActor, id: unknown, deps: PocTestDeps = {}) => {
  const actor = await requireActor(caller);
  if (!validObjectId(id)) throw new PocTestError('VALIDATION_ERROR', 'A valid recipient is required.', 400);
  const filter: Record<string, unknown> = { _id: id, status: 'active', ...(actor.role === 'SuperAdmin' ? {} : { ownerId: actor.id }) };
  const revoked = await PocTestRecipient.findOneAndUpdate(filter, { $set: { status: 'revoked', revokedAt: nowOf(deps) } }, { new: true });
  if (!revoked) throw new PocTestError('RECIPIENT_NOT_FOUND', 'Recipient not found.', 404);
  await AuditService.log({
    action: 'POC_TEST_RECIPIENT_REVOKED',
    collectionName: 'poc_test_recipients',
    documentId: String(revoked._id),
    actor: auditActor(actor),
    request: deps.auditContext?.request ?? null,
    description: `Removed a POC test recipient (${maskPhone(revoked.phone)})`,
    metadata: { recipientId: String(revoked._id), recipientMasked: maskPhone(revoked.phone) },
  });
  return recipientView(revoked);
};

// ── preparing a send (shared by preview and send) ───────────────────────────

export interface TestSendInput {
  senderId?: unknown;
  templateId?: unknown;
  recipientId?: unknown;
  variables?: unknown;
}

const contentHashOf = (parts: { senderId: string; phoneNumberId: string; templateId: string; templateVersion: unknown; recipientId: string; variables: string[] }) =>
  // Keyed, so the stored fingerprint cannot be used to guess a short variable such as a first name.
  crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'eventreach-poc-test-send')
    .update(JSON.stringify([parts.senderId, parts.phoneNumberId, parts.templateId, String(parts.templateVersion ?? ''), parts.recipientId, parts.variables]))
    .digest('hex');

const render = (body: string, variables: string[]) => body.replace(/\{\{(\d+)\}\}/g, (_m, n) => variables[Number(n) - 1] ?? `{{${n}}}`);

interface Prepared {
  actor: PocActor & { role: 'SuperAdmin' | 'Admin' };
  sender: any;
  template: any;
  recipient: any;
  variables: string[];
  contentHash: string;
  wabaId: string;
}

const prepare = async (caller: PocActor, input: TestSendInput, deps: PocTestDeps): Promise<Prepared> => {
  const actor = await requireActor(caller);
  const wabaId = requireConfigured();

  for (const field of ['senderId', 'templateId', 'recipientId'] as const) {
    if (!validObjectId(input[field])) throw new PocTestError('VALIDATION_ERROR', `Choose a valid ${field.replace('Id', '')}.`, 400, { field });
  }
  if (!Array.isArray(input.variables)) throw new PocTestError('VALIDATION_ERROR', 'Variables must be a list of values in {{1}}, {{2}}, … order.', 400, { field: 'variables' });

  const sender: any = await WhatsAppSender.findById(input.senderId);
  if (!sender) throw new PocTestError('SENDER_NOT_FOUND', `Sender not found. ${NOTHING_SENT}`, 404);
  const senderProblems = senderReasons(sender, actor, wabaId);
  if (senderProblems.some((r) => r.includes('allowed list'))) throw new PocTestError('SENDER_NOT_FOUND', `Sender not found. ${NOTHING_SENT}`, 404);
  if (senderProblems.length > 0) throw new PocTestError('SENDER_UNAVAILABLE', `${senderProblems[0]} ${NOTHING_SENT}`, 409, { details: { reasons: senderProblems } });

  // The status is checked with Meta if the stored one is older than 15 minutes.
  let status: string | null;
  try {
    status = await refreshSenderStatusIfStale(sender, deps.client, nowOf(deps).getTime());
  } catch {
    throw new PocTestError('SENDER_STATUS_UNVERIFIED', `The sender's status could not be verified with WhatsApp. ${NOTHING_SENT} Try again shortly.`, 502);
  }
  if (status !== 'CONNECTED') {
    throw new PocTestError('SENDER_UNAVAILABLE', `This sender is not connected (WhatsApp reports ${status ?? 'no status'}). ${NOTHING_SENT}`, 409);
  }

  const template: any = await WhatsAppTemplate.findById(input.templateId);
  if (!template || !canViewTemplate(actor, template)) throw new PocTestError('TEMPLATE_NOT_FOUND', `Template not found. ${NOTHING_SENT}`, 404);
  const templateProblems = templateReasons(template, actor, sender);
  if (templateProblems.length > 0) throw new PocTestError('TEMPLATE_NOT_SENDABLE', `${templateProblems[0]} ${NOTHING_SENT}`, 409, { details: { reasons: templateProblems } });

  const recipient: any = await PocTestRecipient.findById(input.recipientId);
  if (!recipient || (actor.role !== 'SuperAdmin' && recipient.ownerId !== actor.id)) {
    throw new PocTestError('RECIPIENT_NOT_FOUND', `Recipient not found. ${NOTHING_SENT}`, 404);
  }
  if (recipient.status !== 'active') throw new PocTestError('RECIPIENT_NOT_ALLOWED', `This recipient was removed and cannot be sent to. ${NOTHING_SENT}`, 409);

  const expected = (template.variables || []).length;
  if (input.variables.length !== expected) {
    throw new PocTestError('VALIDATION_ERROR', `This template needs ${expected} value${expected === 1 ? '' : 's'}, but ${input.variables.length} ${input.variables.length === 1 ? 'was' : 'were'} given. ${NOTHING_SENT}`, 400, { field: 'variables' });
  }
  let variables: string[];
  try {
    // The same rules every template send is held to (text, not empty, no line breaks, length).
    variables = validateTemplateMessage({ to: recipient.phone, templateName: template.name, languageCode: template.language, variables: input.variables }).variables;
  } catch (error) {
    if (error instanceof WhatsAppTemplateError) throw new PocTestError('VALIDATION_ERROR', `${error.message} ${NOTHING_SENT}`, 400, { field: error.field });
    throw error;
  }

  const contentHash = contentHashOf({
    senderId: String(sender._id),
    phoneNumberId: String(sender.phoneNumberId),
    templateId: String(template._id),
    templateVersion: template.version,
    recipientId: String(recipient._id),
    variables,
  });
  return { actor, sender, template, recipient, variables, contentHash, wabaId };
};

export const previewTestSend = async (caller: PocActor, input: TestSendInput, deps: PocTestDeps = {}) => {
  const p = await prepare(caller, input, deps);
  await settleStaleClaims(deps);
  const risk = await findDuplicateRisk(p.actor.id, p.contentHash, deps);
  return {
    preview: {
      sender: { id: String(p.sender._id), label: p.sender.label || p.sender.verifiedName, numberMasked: maskPhone(String(p.sender.displayPhoneNumber).replace(/[\s()-]/g, '')), status: 'CONNECTED' },
      template: { id: String(p.template._id), name: p.template.name, language: p.template.language, category: p.template.category, status: p.template.metaStatus },
      recipient: { id: String(p.recipient._id), label: p.recipient.label, numberMasked: maskPhone(p.recipient.phone), consent: p.recipient.consentNote },
      renderedBody: render(p.template.body, p.variables),
      footer: p.template.footer ?? null,
      buttons: (p.template.buttons || []).map((b: any) => ({ type: b.type, text: b.text })),
      variableCount: p.variables.length,
    },
    /** What `send` must carry back: it changes if anything above changes. */
    confirmation: { previewHash: p.contentHash, idempotencyKey: crypto.randomUUID() },
    duplicateRisk: risk ? { sendId: String(risk._id), state: risk.state, claimedAt: risk.claimedAt } : null,
    notice: 'Nothing has been sent. Sending needs your explicit confirmation.',
  };
};

// ── duplicate guard ─────────────────────────────────────────────────────────

const findDuplicateRisk = async (actorId: string, contentHash: string, deps: PocTestDeps) => {
  const now = nowOf(deps).getTime();
  const candidates: any[] = await TemplateTestSend.find({
    actorId,
    contentHash,
    state: { $in: ['Claimed', 'Accepted', 'Unknown'] },
    claimedAt: { $gte: new Date(now - UNCERTAIN_WINDOW_MS) },
  }).sort({ claimedAt: -1 }).limit(5).lean();
  return candidates.find((c) => c.state !== 'Accepted' || new Date(c.claimedAt).getTime() >= now - RECENT_ACCEPTED_WINDOW_MS) ?? null;
};

/** A claim whose process is gone is Unknown: it may have reached Meta. */
export const settleStaleClaims = async (deps: PocTestDeps = {}) => {
  const now = nowOf(deps);
  await TemplateTestSend.updateMany(
    { state: 'Claimed', claimedAt: { $lt: new Date(now.getTime() - TEST_SEND_LEASE_MS) } },
    { $set: { state: 'Unknown', outcomeCode: 'STALE_CLAIM', completedAt: now } }
  );
};

// ── views ───────────────────────────────────────────────────────────────────

export type TestSendOutcome = 'accepted' | 'failed' | 'unknown' | 'in_progress' | 'confirmed_received' | 'confirmed_not_received';

const OUTCOME_OF: Record<string, TestSendOutcome> = {
  Claimed: 'in_progress',
  Accepted: 'accepted',
  Failed: 'failed',
  Unknown: 'unknown',
  ConfirmedReceived: 'confirmed_received',
  ConfirmedNotReceived: 'confirmed_not_received',
};

const MESSAGE_OF: Record<TestSendOutcome, string> = {
  in_progress: 'The message is being sent. Its result is not known yet.',
  accepted: 'WhatsApp accepted the message. That is not proof it was delivered: delivery status arrives separately.',
  failed: 'WhatsApp refused the message. It was not sent.',
  unknown: 'There was no clear answer from WhatsApp. The message may or may not have been sent. Check the recipient\'s phone, then record what you found.',
  confirmed_received: 'Someone confirmed the message arrived.',
  confirmed_not_received: 'Someone confirmed the message did not arrive.',
};

export const testSendView = (s: ITemplateTestSend | any) => {
  const o = typeof s.toObject === 'function' ? s.toObject() : s;
  const outcome = OUTCOME_OF[o.state] ?? 'unknown';
  // Sending again is safe only when it is certain nothing was sent.
  const retry =
    o.state === 'Failed' || o.state === 'ConfirmedNotReceived'
      ? { safe: true, reason: 'The message was not sent. Preview it again to send.' }
      : { safe: false, reason: o.state === 'Accepted' ? 'WhatsApp already accepted this message.' : 'The earlier attempt may have been sent, so sending again could deliver it twice.' };
  return {
    id: String(o._id),
    outcome,
    state: o.state,
    message: MESSAGE_OF[outcome],
    template: { id: o.templateId, name: o.templateName, language: o.templateLanguage },
    senderId: o.senderId,
    recipient: { id: o.recipientId, numberMasked: o.recipientMasked },
    variableCount: o.variableCount,
    messageId: o.wamid ?? null,
    delivery: o.delivery ?? null,
    deliveryUpdatedAt: o.deliveryUpdatedAt ?? null,
    errorCategory: o.errorCategory ?? null,
    metaErrorCode: o.metaErrorCode ?? null,
    outcomeCode: o.outcomeCode ?? null,
    claimedAt: o.claimedAt,
    completedAt: o.completedAt ?? null,
    reconciledAt: o.reconciledAt ?? null,
    retry,
  };
};

// ── send ────────────────────────────────────────────────────────────────────

export interface SendTestInput extends TestSendInput {
  confirmed?: unknown;
  previewHash?: unknown;
  idempotencyKey?: unknown;
  /** The person accepts that an earlier, uncertain or very recent send of this message may already have arrived. */
  acknowledgeDuplicateRisk?: unknown;
}

const KEY_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

const outcomeOfError = (error: unknown): { state: 'Failed' | 'Unknown'; code: string; category: string | null; metaCode: number | null } => {
  if (!(error instanceof WhatsAppTemplateError)) return { state: 'Unknown', code: 'INTERNAL_ERROR', category: null, metaCode: null };
  const metaCode = error.meta?.code ?? null;
  if (error.category === 'NETWORK_ERROR') return { state: 'Unknown', code: 'NO_ANSWER', category: error.category, metaCode };
  if (error.category === 'META_API_ERROR' && (metaCode === null || AMBIGUOUS_META_CODES.has(metaCode))) {
    return { state: 'Unknown', code: metaCode === null ? 'NO_MESSAGE_ID' : 'META_AMBIGUOUS', category: error.category, metaCode };
  }
  return { state: 'Failed', code: error.category, category: error.category, metaCode };
};

export const sendTestMessage = async (caller: PocActor, input: SendTestInput, deps: PocTestDeps = {}) => {
  const actor = await requireActor(caller);

  if (input.confirmed !== true) {
    throw new PocTestError('CONFIRMATION_REQUIRED', `Review the preview and confirm before sending. ${NOTHING_SENT}`, 400, { field: 'confirmed' });
  }
  if (typeof input.idempotencyKey !== 'string' || !KEY_PATTERN.test(input.idempotencyKey)) {
    throw new PocTestError('CONFIRMATION_REQUIRED', `Preview the message first: sending needs the key the preview returned. ${NOTHING_SENT}`, 400, { field: 'idempotencyKey' });
  }
  if (typeof input.previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.previewHash)) {
    throw new PocTestError('CONFIRMATION_REQUIRED', `Preview the message first: sending needs the hash the preview returned. ${NOTHING_SENT}`, 400, { field: 'previewHash' });
  }
  const key = input.idempotencyKey;

  // The same intended send, submitted again: report what happened, never send again.
  await settleStaleClaims(deps);
  const earlier = await TemplateTestSend.findOne({ actorId: actor.id, idempotencyKey: key });
  if (earlier) return { replayed: true, outcome: testSendView(earlier).outcome, message: testSendView(earlier).message, send: testSendView(earlier), audit: { claimed: true, completed: true } };

  const p = await prepare(caller, input, deps);
  if (p.contentHash !== input.previewHash) {
    throw new PocTestError('PREVIEW_CHANGED', `Something changed after the preview (the sender, template, recipient or values). Preview it again. ${NOTHING_SENT}`, 409);
  }

  const risk = await findDuplicateRisk(actor.id, p.contentHash, deps);
  if (risk && input.acknowledgeDuplicateRisk !== true) {
    throw new PocTestError(
      'DUPLICATE_RISK',
      risk.state === 'Accepted'
        ? `This message was accepted by WhatsApp a few minutes ago. ${NOTHING_SENT} Confirm again, acknowledging the duplicate, to send it once more.`
        : `An earlier attempt at this message has no clear result and may have arrived. ${NOTHING_SENT} Reconcile it first, or confirm again, acknowledging the risk of a duplicate.`,
      409,
      { details: { sendId: String(risk._id), state: risk.state } }
    );
  }

  const now = nowOf(deps);
  const sentLastHour = await TemplateTestSend.countDocuments({ actorId: actor.id, claimedAt: { $gte: new Date(now.getTime() - 60 * 60 * 1000) } });
  if (sentLastHour >= TEST_SENDS_PER_HOUR) {
    throw new PocTestError('RATE_LIMITED', `At most ${TEST_SENDS_PER_HOUR} test messages can be sent per hour. ${NOTHING_SENT} Try again later.`, 429);
  }

  // The claim. A second request with this key hits the unique index and sends nothing.
  let record: any;
  try {
    record = await TemplateTestSend.create({
      actorId: actor.id,
      idempotencyKey: key,
      senderId: String(p.sender._id),
      phoneNumberId: String(p.sender.phoneNumberId),
      wabaId: p.wabaId,
      templateId: String(p.template._id),
      templateName: p.template.name,
      templateLanguage: p.template.language,
      recipientId: String(p.recipient._id),
      recipientMasked: maskPhone(p.recipient.phone),
      variableCount: p.variables.length,
      contentHash: p.contentHash,
      state: 'Claimed',
      claimedAt: now,
      expiresAt: new Date(now.getTime() + TEST_SEND_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await TemplateTestSend.findOne({ actorId: actor.id, idempotencyKey: key });
      if (existing) return { replayed: true, outcome: testSendView(existing).outcome, message: testSendView(existing).message, send: testSendView(existing), audit: { claimed: true, completed: true } };
    }
    throw error;
  }

  const base = {
    collectionName: 'template_test_sends',
    documentId: String(record._id),
    actor: auditActor(actor),
    request: deps.auditContext?.request ?? null,
  };
  const target = {
    testSendId: String(record._id),
    senderId: String(p.sender._id),
    templateId: String(p.template._id),
    templateName: p.template.name,
    templateLanguage: p.template.language,
    recipientId: String(p.recipient._id),
    recipientMasked: maskPhone(p.recipient.phone),
    variableCount: p.variables.length,
  };

  // Written before anything is sent: if it cannot be saved, nothing is sent.
  const claimedAudit = await AuditService.log({ ...base, action: 'POC_TEST_SEND_CLAIMED', description: `About to send template "${p.template.name}" from the POC sender to ${target.recipientMasked}`, metadata: target });
  if (!claimedAudit) {
    await TemplateTestSend.updateOne({ _id: record._id, state: 'Claimed' }, { $set: { state: 'Failed', outcomeCode: 'AUDIT_UNAVAILABLE', completedAt: nowOf(deps) } });
    throw new PocTestError('AUDIT_UNAVAILABLE', `The audit record could not be saved, so the message was not sent. ${NOTHING_SENT}`, 503);
  }

  // The ONLY number used is this sender's own phone number id.
  const config = { ...readTemplateConfig(), phoneNumberId: String(p.sender.phoneNumberId) };
  let result: { state: 'Accepted' | 'Failed' | 'Unknown'; set: Record<string, unknown> };
  try {
    const sent = await sendTemplateMessage(
      { to: p.recipient.phone, templateName: p.template.name, languageCode: p.template.language, variables: p.variables },
      { post: deps.post, config }
    );
    result = { state: 'Accepted', set: { state: 'Accepted', wamid: sent.messageId, outcomeCode: 'ACCEPTED' } };
  } catch (error) {
    const mapped = outcomeOfError(error);
    result = { state: mapped.state, set: { state: mapped.state, outcomeCode: mapped.code, errorCategory: mapped.category, metaErrorCode: mapped.metaCode } };
  }

  // Conditional on still being Claimed, so a late answer never overwrites a settled record.
  const completedAt = nowOf(deps);
  await TemplateTestSend.updateOne({ _id: record._id, state: 'Claimed' }, { $set: { ...result.set, completedAt } });
  const settled = await TemplateTestSend.findById(record._id);

  const outcomeAudit = await AuditService.log({
    ...base,
    action: 'POC_TEST_SEND_OUTCOME',
    success: result.state !== 'Failed',
    description: `POC test send ${result.state === 'Accepted' ? 'accepted by WhatsApp' : result.state === 'Failed' ? 'refused' : 'has no clear result'}`,
    metadata: { ...target, state: settled?.state ?? result.state, outcomeCode: settled?.outcomeCode ?? null, messageId: settled?.wamid ?? null, metaErrorCode: settled?.metaErrorCode ?? null },
  });

  const view = testSendView(settled);
  return { replayed: false, outcome: view.outcome, message: view.message, send: view, audit: { claimed: true, completed: outcomeAudit } };
};

// ── history, reconciliation, delivery status ────────────────────────────────

export const listTestSends = async (caller: PocActor, query: { limit?: unknown } = {}, deps: PocTestDeps = {}) => {
  const actor = await requireActor(caller);
  await settleStaleClaims(deps);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const sends = await TemplateTestSend.find(actor.role === 'SuperAdmin' ? {} : { actorId: actor.id }).sort({ claimedAt: -1 }).limit(limit).lean();
  return { sends: sends.map(testSendView) };
};

const loadVisibleSend = async (actor: PocActor, id: unknown) => {
  if (!validObjectId(id)) throw new PocTestError('VALIDATION_ERROR', 'A valid test send is required.', 400);
  const send = await TemplateTestSend.findById(id);
  if (!send || (actor.role !== 'SuperAdmin' && send.actorId !== actor.id)) throw new PocTestError('TEST_SEND_NOT_FOUND', 'Test send not found.', 404);
  return send;
};

/** One test send with its audit trail. Reading it never changes anything at Meta. */
export const getTestSend = async (caller: PocActor, id: unknown, deps: PocTestDeps = {}) => {
  const actor = await requireActor(caller);
  await settleStaleClaims(deps);
  const send = await loadVisibleSend(actor, id);
  const entries: any[] = await AuditLog.find({ 'metadata.testSendId': String(send._id) }).sort({ timestamp: 1 }).select('timestamp action description success actor.name actor.role').lean();
  return {
    send: testSendView(send),
    audit: entries.map((e) => ({ at: e.timestamp, action: e.action, description: e.description, success: e.success, by: typeof e.actor?.name === 'string' && !e.actor.name.includes('@') ? e.actor.name : null, role: e.actor?.role ?? null })),
  };
};

/**
 * A person records what they found out about an Unknown send. Only an Unknown
 * one can be reconciled, once; it never sends anything.
 */
export const reconcileTestSend = async (caller: PocActor, id: unknown, resolution: unknown, deps: PocTestDeps = {}) => {
  const actor = await requireActor(caller);
  if (resolution !== 'received' && resolution !== 'not_received') {
    throw new PocTestError('VALIDATION_ERROR', 'Say whether the message arrived or did not.', 400, { field: 'resolution' });
  }
  await settleStaleClaims(deps);
  const send = await loadVisibleSend(actor, id);
  const now = nowOf(deps);
  const updated = await TemplateTestSend.findOneAndUpdate(
    { _id: send._id, state: 'Unknown' },
    { $set: { state: resolution === 'received' ? 'ConfirmedReceived' : 'ConfirmedNotReceived', reconciledBy: actor.id, reconciledAt: now } },
    { new: true }
  );
  if (!updated) throw new PocTestError('NOT_RECONCILABLE', `Only a send with no clear result can be reconciled. This one is ${send.state}.`, 409);
  await AuditService.log({
    action: 'POC_TEST_SEND_RECONCILED',
    collectionName: 'template_test_sends',
    documentId: String(updated._id),
    actor: auditActor(actor),
    request: deps.auditContext?.request ?? null,
    description: `Recorded that an uncertain POC test send ${resolution === 'received' ? 'arrived' : 'did not arrive'}`,
    metadata: { testSendId: String(updated._id), resolution, recipientMasked: updated.recipientMasked },
  });
  return { send: testSendView(updated) };
};

const DELIVERY_RANK: Record<TestSendDelivery, number> = { sent: 1, delivered: 2, read: 3, failed: 0 };

/**
 * Applies one delivery status from the webhook to the test send that owns the
 * message id. Statuses only move forward; a failure after delivery is ignored.
 * Returns whether a test send was updated.
 */
export const applyPocDeliveryStatus = async (wamid: string, metaStatus: string, at: Date, errors?: any[]): Promise<boolean> => {
  if (!wamid || !['sent', 'delivered', 'read', 'failed'].includes(metaStatus)) return false;
  const send = await TemplateTestSend.findOne({ wamid });
  if (!send) return false;
  const next = metaStatus as TestSendDelivery;
  const current = send.delivery;
  if (next === 'failed') {
    if (current === 'delivered' || current === 'read') return false;
  } else if (current && current !== 'failed' && DELIVERY_RANK[next] <= DELIVERY_RANK[current]) {
    return false;
  }
  if (current === next) return false;
  const code = next === 'failed' && Array.isArray(errors) && typeof errors[0]?.code === 'number' ? errors[0].code : null;
  await TemplateTestSend.updateOne({ _id: send._id }, { $set: { delivery: next, deliveryUpdatedAt: at, deliveryErrorCode: code } });
  return true;
};
