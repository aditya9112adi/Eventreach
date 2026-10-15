import mongoose from 'mongoose';
import { Admin } from '../models/Admin';
import { Event } from '../models/Event';
import { WhatsAppSender, type OnboardingStatus } from '../models/WhatsAppSender';
import { WhatsAppOnboardingSession, ONBOARDING_SESSION_TTL_MS } from '../models/WhatsAppOnboardingSession';
import { AuditService, type AuditParams } from './AuditService';
import { CredentialVaultError, isVaultConfigured, openCredential, sealCredential, CREDENTIAL_KEY_ENV } from './credentialVault';
import { createMetaOnboardingApi, META_ID_PATTERN, MetaOnboardingError, type MetaOnboardingApi, type MetaPhoneNumberNode } from './metaOnboardingApi';
import { embeddedSenderProblems } from './senderEligibility';

/**
 * Connecting a business's own WhatsApp number to EventReach through Meta's
 * Embedded Signup - the server side.
 *
 * THE FLOW
 *  1. start      the signed-in Admin or Super Admin opens an onboarding session
 *                (bound to their account, open 30 minutes). The page then
 *                launches Meta's popup with the public app and configuration ids.
 *  2. the popup  Meta's own screens: business, WhatsApp account, number, code
 *                verification. EventReach sees none of it.
 *  3. complete   the page sends the session id, the one-time code and the ids
 *                the popup reported. The server - never the browser - exchanges
 *                the code for the business's token, confirms that token can see
 *                exactly that WhatsApp account and number (so a client cannot
 *                claim someone else's number), subscribes the app to the
 *                account's webhooks, reads the number's real state from Meta,
 *                and only then stores the sender, token encrypted.
 *     cancel / error: recorded on the session; nothing is created.
 *  4. register   a number not yet on Cloud API needs registering with the
 *                business's six-digit two-step verification PIN. The owner types
 *                it; it is sent to Meta and never stored or logged.
 *  5. verify     re-reads the number's state from Meta at any time.
 *  6. disconnect stops using the number here and erases its stored token.
 *
 * A connected number is NOT usable for events until a Super Admin enables it
 * (the existing rule for every new sender), and then only by its owner's events
 * or Admins a Super Admin allows (senderEligibility). Nothing here sends a
 * message.
 *
 * What is persisted is what the backend verified with Meta - never what the
 * popup said happened.
 */

export class OnboardingError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, httpStatus: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
  toResponse() {
    return { success: false as const, error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export interface OnboardingActor {
  id: string;
  email?: string;
  name?: string;
  role?: string;
}

export interface OnboardingDeps {
  /** Meta calls; tests inject a fake. Built from the environment otherwise. */
  api?: MetaOnboardingApi;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  auditContext?: { request?: AuditParams['request'] };
}

const SESSIONS_PER_HOUR = 10;
const VERIFY_COOLDOWN_MS = 30 * 1000;
const nowOf = (deps: OnboardingDeps) => (deps.now ? deps.now() : new Date());

// ── configuration ───────────────────────────────────────────────────────────

/**
 * What onboarding needs from the server environment. The app id, configuration
 * id and API version are public (the browser's SDK needs them); the app secret
 * and the credential key never leave the server.
 */
export const readOnboardingConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const appId = env.META_APP_ID?.trim() || '';
  // The app a business connects to through Embedded Signup is the app its
  // WhatsApp account's webhooks are delivered to - and those are signed with
  // that app's secret, WHATSAPP_APP_SECRET. So the two must be the same app:
  // META_APP_SECRET may be left unset (WHATSAPP_APP_SECRET is used), and a
  // different value is a configuration error, not a second app.
  const ownSecret = env.META_APP_SECRET?.trim() || '';
  const webhookSecret = env.WHATSAPP_APP_SECRET?.trim() || '';
  const appSecret = ownSecret || webhookSecret;
  const secretsDisagree = Boolean(ownSecret && webhookSecret && ownSecret !== webhookSecret);
  const configId = env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim() || '';
  const apiVersion = env.WHATSAPP_API_VERSION?.trim() || 'v22.0';
  const missing = [
    !appId ? 'META_APP_ID' : null,
    !appSecret ? 'META_APP_SECRET (or WHATSAPP_APP_SECRET)' : null,
    secretsDisagree ? 'META_APP_SECRET must be the same app secret as WHATSAPP_APP_SECRET' : null,
    !configId ? 'META_EMBEDDED_SIGNUP_CONFIG_ID' : null,
    !isVaultConfigured(env) ? CREDENTIAL_KEY_ENV : null,
  ].filter(Boolean) as string[];
  return { appId, appSecret, configId, apiVersion, missing, configured: missing.length === 0 };
};

const apiOf = (deps: OnboardingDeps): MetaOnboardingApi => {
  if (deps.api) return deps.api;
  const config = readOnboardingConfig(deps.env);
  return createMetaOnboardingApi({ appId: config.appId, appSecret: config.appSecret, apiVersion: config.apiVersion });
};

const requireConfigured = (deps: OnboardingDeps) => {
  const config = readOnboardingConfig(deps.env);
  if (!config.configured) {
    throw new OnboardingError('NOT_CONFIGURED', `WhatsApp onboarding is not configured on the server (missing ${config.missing.join(', ')}). Ask a Super Admin.`, 503);
  }
  return config;
};

// ── who ─────────────────────────────────────────────────────────────────────

/** Admins and Super Admins with an active account, read from the database. Users never. */
const requireAccount = async (actor: OnboardingActor) => {
  if (!actor?.id || !mongoose.isValidObjectId(actor.id)) throw new OnboardingError('ACCESS_DENIED', 'Sign in to connect a WhatsApp number.', 401);
  const account: any = await Admin.findById(actor.id).select('role status isAccessCancelled').lean();
  if (!account || !['Admin', 'SuperAdmin'].includes(account.role)) {
    throw new OnboardingError('ACCESS_DENIED', 'Only Admins and Super Admins can connect a WhatsApp number.', 403);
  }
  if (account.role !== 'SuperAdmin' && (account.status !== 'Active' || account.isAccessCancelled)) {
    throw new OnboardingError('ACCESS_DENIED', 'Your account is not active.', 403);
  }
  return { ...actor, id: String(actor.id), role: account.role as 'Admin' | 'SuperAdmin' };
};

const audit = (action: string, actor: OnboardingActor, deps: OnboardingDeps, description: string, metadata: Record<string, unknown>, success = true) =>
  AuditService.log({
    action,
    collectionName: 'whatsapp_senders',
    documentId: (metadata.senderId as string) ?? null,
    actor: { userId: actor.id, email: actor.email ?? null, name: actor.name ?? null, role: actor.role ?? null } as any,
    request: deps.auditContext?.request ?? null,
    description,
    metadata,
    success,
  });

// ── views ───────────────────────────────────────────────────────────────────

/** "…4786": enough to recognise a Meta id, not to use it. */
export const maskId = (value: unknown) => {
  const s = String(value ?? '');
  return s.length > 4 ? `…${s.slice(-4)}` : '…';
};

/**
 * A connected number as its owner (or a Super Admin) sees it. Never the token;
 * the phone number id is masked; the business display number is shown because it
 * is the business's public WhatsApp number.
 */
export const senderOnboardingView = (sender: any) => {
  const hasCredential = Boolean(sender.credential?.ciphertext) || sender.hasCredential === true;
  const problems = embeddedSenderProblems(sender, hasCredential);
  return {
    id: String(sender._id),
    source: sender.source ?? 'inventory',
    displayPhoneNumber: sender.displayPhoneNumber,
    verifiedName: sender.verifiedName,
    phoneNumberIdMasked: maskId(sender.phoneNumberId),
    onboardingStatus: sender.onboardingStatus ?? null,
    metaStatus: sender.metaStatus ?? null,
    platformType: sender.platformType ?? null,
    qualityRating: sender.qualityRating ?? null,
    nameStatus: sender.nameStatus ?? null,
    nextAction: sender.nextAction ?? null,
    nextActionMessage: sender.nextActionMessage ?? null,
    lastError: sender.lastError?.message ? { message: sender.lastError.message, at: sender.lastError.at ?? null } : null,
    enabled: Boolean(sender.enabled),
    lastVerifiedAt: sender.lastVerifiedAt ?? null,
    connectedAt: sender.connectedAt ?? null,
    disconnectedAt: sender.disconnectedAt ?? null,
    assignment: { available: problems.length === 0, reasons: problems },
  };
};

// ── reading Meta's answer ───────────────────────────────────────────────────

/** Where a number stands, from what Meta reports about it. */
export const statusFromMeta = (node: MetaPhoneNumberNode): { status: OnboardingStatus; nextAction: string | null; nextActionMessage: string | null } => {
  const onCloudApi = node.platformType === 'CLOUD_API';
  if (onCloudApi && node.status === 'CONNECTED') return { status: 'connected', nextAction: null, nextActionMessage: null };
  if (onCloudApi) {
    return {
      status: 'action_required',
      nextAction: 'resolve_at_meta',
      nextActionMessage: `WhatsApp reports this number as ${node.status ?? 'unknown'}. Resolve it in WhatsApp Manager, then check its status again.`,
    };
  }
  return {
    status: 'pending_registration',
    nextAction: 'register',
    nextActionMessage: 'Finish registration: enter the six-digit two-step verification PIN for this number (or choose a new one if it has none).',
  };
};

const metaFields = (node: MetaPhoneNumberNode, at: Date) => ({
  ...(node.displayPhoneNumber ? { displayPhoneNumber: node.displayPhoneNumber } : {}),
  ...(node.verifiedName ? { verifiedName: node.verifiedName } : {}),
  metaStatus: node.status,
  qualityRating: node.qualityRating,
  platformType: node.platformType,
  codeVerificationStatus: node.codeVerificationStatus,
  nameStatus: node.nameStatus,
  statusCheckedAt: at,
  lastVerifiedAt: at,
});

const toOnboardingError = (error: unknown): OnboardingError => {
  if (error instanceof OnboardingError) return error;
  if (error instanceof CredentialVaultError) return new OnboardingError('CREDENTIAL_UNAVAILABLE', error.message, error.code === 'NOT_CONFIGURED' ? 503 : 409);
  if (error instanceof MetaOnboardingError) {
    switch (error.kind) {
      case 'AUTHENTICATION':
        return new OnboardingError('META_AUTH_FAILED', 'Meta did not accept the authorization (it may have expired). Start the connection again.', 400);
      case 'RATE_LIMITED':
        return new OnboardingError('RATE_LIMITED', error.message, 429);
      case 'REJECTED':
        return new OnboardingError('META_REJECTED', `WhatsApp refused: ${error.message}`, 422, error.meta?.code !== undefined ? { metaCode: error.meta.code } : undefined);
      default:
        return new OnboardingError('META_UNAVAILABLE', error.message, 502);
    }
  }
  return new OnboardingError('INTERNAL_ERROR', 'Something went wrong. Nothing was connected. Please try again.', 500);
};

// ── 1. start ────────────────────────────────────────────────────────────────

/** The public ids the page needs, and whether onboarding is configured. Names only for what is missing. */
export const getOnboardingConfig = async (caller: OnboardingActor, deps: OnboardingDeps = {}) => {
  await requireAccount(caller);
  const config = readOnboardingConfig(deps.env);
  return config.configured
    ? { configured: true, appId: config.appId, configId: config.configId, apiVersion: config.apiVersion, missing: [] as string[] }
    : { configured: false, appId: null, configId: null, apiVersion: config.apiVersion, missing: config.missing };
};

export const startOnboarding = async (caller: OnboardingActor, deps: OnboardingDeps = {}) => {
  const actor = await requireAccount(caller);
  const config = requireConfigured(deps);
  const now = nowOf(deps);
  const recent = await WhatsAppOnboardingSession.countDocuments({ accountId: actor.id, startedAt: { $gte: new Date(now.getTime() - 60 * 60 * 1000) } });
  if (recent >= SESSIONS_PER_HOUR) throw new OnboardingError('RATE_LIMITED', 'Too many connection attempts. Try again in an hour.', 429);

  const session = await WhatsAppOnboardingSession.create({
    accountId: actor.id,
    status: 'started',
    startedAt: now,
    openUntil: new Date(now.getTime() + ONBOARDING_SESSION_TTL_MS),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
  await audit('WHATSAPP_ONBOARDING_STARTED', actor, deps, 'Started connecting a WhatsApp number', { sessionId: String(session._id) });
  return { sessionId: String(session._id), openUntil: session.openUntil, appId: config.appId, configId: config.configId, apiVersion: config.apiVersion };
};

// ── cancel / error from the popup ───────────────────────────────────────────

const ownSession = async (actor: OnboardingActor, sessionId: unknown) => {
  if (typeof sessionId !== 'string' || !mongoose.isValidObjectId(sessionId)) throw new OnboardingError('VALIDATION_ERROR', 'A valid onboarding session is required.', 400);
  const session = await WhatsAppOnboardingSession.findOne({ _id: sessionId, accountId: actor.id });
  // Not found and not yours look the same.
  if (!session) throw new OnboardingError('SESSION_NOT_FOUND', 'Onboarding session not found.', 404);
  return session;
};

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,60}$/;

export const cancelOnboarding = async (caller: OnboardingActor, sessionId: unknown, input: { currentStep?: unknown } = {}, deps: OnboardingDeps = {}) => {
  const actor = await requireAccount(caller);
  const session = await ownSession(actor, sessionId);
  const step = typeof input.currentStep === 'string' && SAFE_TOKEN.test(input.currentStep) ? input.currentStep : null;
  const updated = await WhatsAppOnboardingSession.findOneAndUpdate(
    { _id: session._id, status: 'started' },
    { $set: { status: 'cancelled', cancelledAtStep: step, finishedAt: nowOf(deps) } },
    { new: true }
  );
  if (!updated) throw new OnboardingError('SESSION_NOT_OPEN', `This connection attempt is already ${session.status}.`, 409);
  await audit('WHATSAPP_ONBOARDING_CANCELLED', actor, deps, 'Cancelled connecting a WhatsApp number', { sessionId: String(session._id), step });
  return { status: 'cancelled' as const, message: 'The connection was cancelled. Nothing was connected.' };
};

export const reportOnboardingError = async (caller: OnboardingActor, sessionId: unknown, input: { errorId?: unknown } = {}, deps: OnboardingDeps = {}) => {
  const actor = await requireAccount(caller);
  const session = await ownSession(actor, sessionId);
  // Only Meta's error id is kept, and only if it looks like one: popup text is never trusted or stored.
  const errorId = typeof input.errorId === 'string' || typeof input.errorId === 'number' ? String(input.errorId) : '';
  const code = SAFE_TOKEN.test(errorId) ? `META_${errorId}` : 'META_POPUP_ERROR';
  const updated = await WhatsAppOnboardingSession.findOneAndUpdate(
    { _id: session._id, status: 'started' },
    { $set: { status: 'error', errorCode: code, finishedAt: nowOf(deps) } },
    { new: true }
  );
  if (!updated) throw new OnboardingError('SESSION_NOT_OPEN', `This connection attempt is already ${session.status}.`, 409);
  await audit('WHATSAPP_ONBOARDING_ERROR', actor, deps, 'Meta reported an error while connecting a WhatsApp number', { sessionId: String(session._id), errorCode: code }, false);
  return { status: 'error' as const, message: 'Meta reported a problem and nothing was connected. You can try again.' };
};

// ── 3. complete ─────────────────────────────────────────────────────────────

export interface CompleteInput {
  code?: unknown;
  wabaId?: unknown;
  phoneNumberId?: unknown;
  businessId?: unknown;
}

const validateComplete = (input: CompleteInput) => {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!code || code.length > 2048 || /\s/.test(code)) throw new OnboardingError('VALIDATION_ERROR', 'The authorization from Meta is missing or malformed. Start the connection again.', 400);
  const wabaId = typeof input.wabaId === 'string' ? input.wabaId.trim() : '';
  const phoneNumberId = typeof input.phoneNumberId === 'string' ? input.phoneNumberId.trim() : '';
  if (!META_ID_PATTERN.test(wabaId)) throw new OnboardingError('VALIDATION_ERROR', 'Meta did not report a valid WhatsApp Business Account. Start the connection again.', 400);
  if (!META_ID_PATTERN.test(phoneNumberId)) {
    throw new OnboardingError('VALIDATION_ERROR', 'Meta did not report a phone number. Choose or add a number during the connection, then try again.', 400);
  }
  const businessId = typeof input.businessId === 'string' && META_ID_PATTERN.test(input.businessId.trim()) ? input.businessId.trim() : null;
  return { code, wabaId, phoneNumberId, businessId };
};

/**
 * Refuses a number that is already someone else's here, before anything is
 * asked of Meta. A number may be reconnected by its owner at any time; a
 * number another account connected can be taken over only once it has been
 * disconnected (by its owner or a Super Admin).
 */
const checkExistingClaim = async (actor: OnboardingActor, phoneNumberId: string, wabaId: string) => {
  const existing: any = await WhatsAppSender.findOne({ phoneNumberId }).lean();
  if (!existing) return null;
  if (existing.source !== 'embedded_signup') {
    throw new OnboardingError('NUMBER_MANAGED_CENTRALLY', 'This number is already managed by EventReach centrally. Ask a Super Admin.', 409);
  }
  if (String(existing.wabaId) !== wabaId) {
    throw new OnboardingError('NUMBER_MOVED_ACCOUNT', 'This number is recorded under a different WhatsApp Business Account. Ask a Super Admin.', 409);
  }
  const ownedByOther = existing.ownerAccountId && String(existing.ownerAccountId) !== actor.id;
  if (ownedByOther && existing.onboardingStatus !== 'disconnected') {
    throw new OnboardingError('NUMBER_OWNED_BY_ANOTHER_ACCOUNT', 'This number is connected to another EventReach account. It must be disconnected there (or by a Super Admin) first.', 409);
  }
  return existing;
};

export const completeOnboarding = async (caller: OnboardingActor, sessionId: unknown, input: CompleteInput, deps: OnboardingDeps = {}) => {
  const actor = await requireAccount(caller);
  const session = await ownSession(actor, sessionId);
  const { code, wabaId, phoneNumberId, businessId } = validateComplete(input);
  requireConfigured(deps);
  const now = nowOf(deps);

  // Exactly one completion per session, and only while it is open.
  const claimed = await WhatsAppOnboardingSession.findOneAndUpdate(
    { _id: session._id, status: 'started', openUntil: { $gt: now } },
    { $set: { status: 'completing' } },
    { new: true }
  );
  if (!claimed) {
    throw new OnboardingError('SESSION_NOT_OPEN', session.status === 'started' ? 'This connection attempt has expired. Start again.' : `This connection attempt is already ${session.status}.`, 409);
  }

  const fail = async (error: unknown) => {
    const mapped = toOnboardingError(error);
    await WhatsAppOnboardingSession.updateOne({ _id: session._id, status: 'completing' }, { $set: { status: 'failed', errorCode: mapped.code, finishedAt: nowOf(deps) } });
    await audit('WHATSAPP_ONBOARDING_FAILED', actor, deps, `Connecting a WhatsApp number failed (${mapped.code})`, { sessionId: String(session._id), errorCode: mapped.code, phoneNumberIdMasked: maskId(phoneNumberId) }, false);
    if (!(error instanceof OnboardingError) && !(error instanceof MetaOnboardingError) && !(error instanceof CredentialVaultError)) {
      console.error('WhatsApp onboarding failed:', (error as any)?.message || error);
    }
    return mapped;
  };

  let existing: any;
  let node: MetaPhoneNumberNode | undefined;
  let token: string;
  try {
    const api = apiOf(deps);
    // First, and at once: Meta's code lives about 30 seconds.
    token = await api.exchangeCodeForToken(code);
    // The token must see exactly this account and number: the popup's ids are
    // only trusted once Meta confirms them for this business's token.
    const numbers = await api.listWabaPhoneNumbers(token, wabaId);
    node = numbers.find((n) => n.id === phoneNumberId);
    if (!node) {
      throw new OnboardingError('ASSET_NOT_GRANTED', 'The WhatsApp account and number reported by the popup were not granted to EventReach. Start the connection again and select that number.', 400);
    }
    // Only now - once Meta has confirmed this business controls the number - is
    // it compared with what EventReach already holds, so nobody can probe
    // whether another account's number is connected here.
    existing = await checkExistingClaim(actor, phoneNumberId, wabaId);
    await api.subscribeAppToWaba(token, wabaId);
  } catch (error) {
    throw await fail(error);
  }

  const at = nowOf(deps);
  const state = statusFromMeta(node);
  const takeover = existing && existing.ownerAccountId && String(existing.ownerAccountId) !== actor.id;
  const set: Record<string, unknown> = {
    ...metaFields(node, at),
    ownerAccountId: actor.id,
    businessId,
    onboardingStatus: state.status,
    nextAction: state.nextAction,
    nextActionMessage: state.nextActionMessage,
    lastError: null,
    listedInMeta: true,
    credential: sealCredential(token),
    connectedAt: state.status === 'connected' ? at : (existing?.connectedAt ?? null),
    disconnectedAt: null,
    // A number changing hands starts over: the new owner's use needs a Super Admin again.
    ...(takeover ? { enabled: false, allowedAdminIds: [], pocTestEnabled: false } : {}),
  };

  let saved: any;
  try {
    if (existing) {
      saved = await WhatsAppSender.findOneAndUpdate({ _id: existing._id }, { $set: set }, { new: true });
    } else {
      saved = await WhatsAppSender.create({
        phoneNumberId,
        wabaId,
        displayPhoneNumber: node.displayPhoneNumber || 'Unknown number',
        verifiedName: node.verifiedName || 'Unnamed business',
        source: 'embedded_signup',
        enabled: false,
        allowedAdminIds: [],
        ...set,
      });
    }
  } catch (error: any) {
    if (error?.code === 11000) throw await fail(new OnboardingError('ALREADY_CONNECTING', 'This number was just connected by another request. Refresh to see it.', 409));
    throw await fail(error);
  }

  await WhatsAppOnboardingSession.updateOne({ _id: session._id }, { $set: { status: 'completed', senderId: saved._id, finishedAt: nowOf(deps) } });
  await audit(
    'WHATSAPP_SENDER_ONBOARDED',
    actor,
    deps,
    `Connected WhatsApp number ${saved.displayPhoneNumber}${takeover ? ' (taken over from a disconnected owner)' : existing ? ' (reconnected)' : ''}`,
    { senderId: String(saved._id), sessionId: String(session._id), phoneNumberIdMasked: maskId(phoneNumberId), onboardingStatus: state.status, reconnected: Boolean(existing), takeover: Boolean(takeover) }
  );
  return { sender: senderOnboardingView({ ...saved.toObject(), hasCredential: true }), message: messageFor(state.status) };
};

const messageFor = (status: OnboardingStatus) => {
  switch (status) {
    case 'connected':
      return 'Your WhatsApp number is connected. A Super Admin must enable it before it can be used for events.';
    case 'pending_registration':
      return 'Almost done: finish registration with the number\'s two-step verification PIN.';
    case 'action_required':
      return 'Your number was added, but WhatsApp reports an action is required. See the details below.';
    default:
      return 'Your number was added.';
  }
};

// ── owner / Super Admin actions on a connected number ───────────────────────

const loadManaged = async (actor: OnboardingActor & { role: string }, senderId: unknown, options: { ownerOnly?: boolean } = {}) => {
  if (typeof senderId !== 'string' || !mongoose.isValidObjectId(senderId)) throw new OnboardingError('VALIDATION_ERROR', 'A valid sender is required.', 400);
  const sender: any = await WhatsAppSender.findById(senderId).select('+credential');
  const isOwner = sender && sender.ownerAccountId && String(sender.ownerAccountId) === actor.id;
  const allowed = sender && sender.source === 'embedded_signup' && (isOwner || (!options.ownerOnly && actor.role === 'SuperAdmin'));
  // Not found and not yours look the same.
  if (!allowed) throw new OnboardingError('SENDER_NOT_FOUND', 'Sender not found.', 404);
  return sender;
};

const tokenOf = (sender: any): string => openCredential(sender.credential);

/**
 * Registers the number with Cloud API using the two-step verification PIN the
 * owner typed. Owner only: the PIN is the business's. The PIN is passed to Meta
 * and dropped - never stored, logged or returned.
 */
export const registerSender = async (caller: OnboardingActor, senderId: unknown, input: { pin?: unknown }, deps: OnboardingDeps = {}) => {
  const actor = await requireAccount(caller);
  const pin = typeof input.pin === 'string' ? input.pin.trim() : '';
  if (!/^\d{6}$/.test(pin)) throw new OnboardingError('VALIDATION_ERROR', 'Enter the six-digit two-step verification PIN.', 400);
  requireConfigured(deps);
  const sender = await loadManaged(actor, senderId, { ownerOnly: true });
  if (!['pending_registration', 'action_required'].includes(sender.onboardingStatus)) {
    throw new OnboardingError('NOT_REGISTRABLE', `This number cannot be registered now (it is ${sender.onboardingStatus ?? 'not onboarded'}).`, 409);
  }
  const previous = sender.onboardingStatus;
  const claimed = await WhatsAppSender.findOneAndUpdate({ _id: sender._id, onboardingStatus: previous }, { $set: { onboardingStatus: 'registering' } }, { new: true });
  if (!claimed) throw new OnboardingError('NOT_REGISTRABLE', 'This number is already being registered.', 409);

  try {
    const api = apiOf(deps);
    const token = tokenOf(sender);
    await api.registerPhoneNumber(token, sender.phoneNumberId, pin);
    const node = await api.getPhoneNumber(token, sender.phoneNumberId);
    const at = nowOf(deps);
    const state = statusFromMeta(node);
    const updated = await WhatsAppSender.findOneAndUpdate(
      { _id: sender._id, onboardingStatus: 'registering' },
      {
        $set: {
          ...metaFields(node, at),
          onboardingStatus: state.status,
          nextAction: state.nextAction,
          nextActionMessage: state.status === 'pending_registration' ? 'WhatsApp accepted the PIN but the number is not on Cloud API yet. Check its status again in a minute.' : state.nextActionMessage,
          lastError: null,
          ...(state.status === 'connected' ? { connectedAt: at } : {}),
        },
      },
      { new: true }
    );
    await audit('WHATSAPP_SENDER_REGISTERED', actor, deps, `Registered WhatsApp number ${sender.displayPhoneNumber} (${state.status})`, { senderId: String(sender._id), onboardingStatus: state.status });
    return { sender: senderOnboardingView({ ...(updated ?? sender).toObject(), hasCredential: true }), message: messageFor(state.status) };
  } catch (error) {
    const mapped = toOnboardingError(error);
    await WhatsAppSender.updateOne(
      { _id: sender._id, onboardingStatus: 'registering' },
      { $set: { onboardingStatus: previous, lastError: { code: mapped.code, message: mapped.message.slice(0, 500), at: nowOf(deps) } } }
    );
    await audit('WHATSAPP_SENDER_REGISTRATION_FAILED', actor, deps, `Registering WhatsApp number ${sender.displayPhoneNumber} failed (${mapped.code})`, { senderId: String(sender._id), errorCode: mapped.code }, false);
    throw mapped;
  }
};

/** Re-reads the number's state from Meta (owner or Super Admin). Never sends anything. */
export const verifySender = async (caller: OnboardingActor, senderId: unknown, deps: OnboardingDeps = {}) => {
  const actor = await requireAccount(caller);
  requireConfigured(deps);
  const sender = await loadManaged(actor, senderId);
  if (sender.onboardingStatus === 'disconnected') throw new OnboardingError('DISCONNECTED', 'This number is disconnected. Connect it again first.', 409);
  if (sender.onboardingStatus === 'registering') throw new OnboardingError('NOT_VERIFIABLE', 'This number is being registered. Check again in a moment.', 409);
  const now = nowOf(deps);
  if (sender.lastVerifiedAt && now.getTime() - new Date(sender.lastVerifiedAt).getTime() < VERIFY_COOLDOWN_MS) {
    throw new OnboardingError('RATE_LIMITED', 'Checked moments ago. Try again in 30 seconds.', 429);
  }
  try {
    const node = await apiOf(deps).getPhoneNumber(tokenOf(sender), sender.phoneNumberId);
    const state = statusFromMeta(node);
    const updated = await WhatsAppSender.findOneAndUpdate(
      { _id: sender._id, onboardingStatus: sender.onboardingStatus },
      { $set: { ...metaFields(node, now), onboardingStatus: state.status, nextAction: state.nextAction, nextActionMessage: state.nextActionMessage, ...(state.status === 'connected' && !sender.connectedAt ? { connectedAt: now } : {}) } },
      { new: true }
    );
    if (state.status !== sender.onboardingStatus) {
      await audit('WHATSAPP_SENDER_STATUS_CHANGED', actor, deps, `WhatsApp number ${sender.displayPhoneNumber} is now ${state.status}`, { senderId: String(sender._id), from: sender.onboardingStatus, to: state.status });
    }
    return { sender: senderOnboardingView({ ...(updated ?? sender).toObject(), hasCredential: true }) };
  } catch (error) {
    const mapped = toOnboardingError(error);
    // Meta no longer accepts the stored authorization (revoked, expired, or the
    // business removed EventReach's access): the number needs reconnecting. It
    // stops being usable now rather than at the next failed send.
    const revoked = error instanceof MetaOnboardingError && error.kind === 'AUTHENTICATION';
    await WhatsAppSender.updateOne(
      { _id: sender._id },
      {
        $set: {
          lastError: { code: mapped.code, message: mapped.message.slice(0, 500), at: now },
          ...(revoked ? { onboardingStatus: 'action_required', nextAction: 'reconnect', nextActionMessage: 'Meta no longer accepts this number\'s authorization. Connect it again.' } : {}),
        },
      }
    );
    if (revoked) {
      await audit('WHATSAPP_SENDER_AUTH_REVOKED', actor, deps, `Meta no longer accepts the authorization for WhatsApp number ${sender.displayPhoneNumber}`, { senderId: String(sender._id) }, false);
    }
    throw mapped;
  }
};

/**
 * Stops using the number here: disabled, marked disconnected, and its stored
 * token erased. Events assigned to it then refuse to send (never falling back
 * to the default sender) until it is reconnected or reassigned. Nothing is
 * changed at Meta.
 */
export const disconnectSender = async (caller: OnboardingActor, senderId: unknown, deps: OnboardingDeps = {}) => {
  const actor = await requireAccount(caller);
  const sender = await loadManaged(actor, senderId);
  if (sender.onboardingStatus === 'disconnected') return { sender: senderOnboardingView(sender.toObject()) };
  const at = nowOf(deps);
  const updated = await WhatsAppSender.findOneAndUpdate(
    { _id: sender._id },
    { $set: { onboardingStatus: 'disconnected', enabled: false, pocTestEnabled: false, nextAction: 'reconnect', nextActionMessage: 'Disconnected. Connect the number again to use it.', disconnectedAt: at }, $unset: { credential: 1 } },
    { new: true }
  );
  // Assignments are kept on purpose (removing them would silently move those
  // events to the default sender); they refuse to send until reconnected or
  // reassigned. The count lets the page say so.
  const assignedEvents = await Event.countDocuments({ whatsappSenderId: sender._id });
  await audit('WHATSAPP_SENDER_DISCONNECTED', actor, deps, `Disconnected WhatsApp number ${sender.displayPhoneNumber}`, { senderId: String(sender._id), byOwner: String(sender.ownerAccountId) === actor.id, assignedEvents });
  return { sender: senderOnboardingView(updated!.toObject()), assignedEvents };
};

/** The numbers this account connected. */
export const listMySenders = async (caller: OnboardingActor) => {
  const actor = await requireAccount(caller);
  const senders: any[] = await WhatsAppSender.find({ source: 'embedded_signup', ownerAccountId: actor.id }).select('+credential').sort({ createdAt: -1 }).lean();
  return { senders: senders.map((s) => senderOnboardingView({ ...s, hasCredential: Boolean(s.credential?.ciphertext), credential: undefined })) };
};

/** For the send path: the decrypted business token of a connected number. Throws if unusable. */
export const readSenderAccessToken = async (senderId: string): Promise<string> => {
  const sender: any = await WhatsAppSender.findById(senderId).select('+credential source onboardingStatus').lean();
  if (!sender || sender.source !== 'embedded_signup' || sender.onboardingStatus !== 'connected' || !sender.credential) {
    throw new CredentialVaultError('CORRUPT', 'This WhatsApp number has no usable stored authorization.');
  }
  return openCredential(sender.credential);
};
