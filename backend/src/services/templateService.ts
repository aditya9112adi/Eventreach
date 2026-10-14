import crypto from 'crypto';
import mongoose from 'mongoose';
import { WhatsAppTemplate, type IWhatsAppTemplate } from '../models/WhatsAppTemplate';
import { Admin } from '../models/Admin';
import { Event } from '../models/Event';
import { AuditService } from './AuditService';
import { isEventAuthorized, type AuthUserInfo } from './eventAuthService';
import { readWhatsAppConnection, type WhatsAppConnection } from './whatsappConnection';
import { templateManagerRole } from './templatePermission';
import {
  EDITABLE_STATES,
  META_TEMPLATE_STATUSES,
  buildMetaCreatePayload,
  mapMetaStatus,
  validateTemplateDraft,
  type FieldError,
  type TemplateDraftInput,
} from './templateDefinition';
import {
  createMetaTemplate,
  findMetaTemplatesByName,
  getMetaTemplateById,
  listMetaTemplates,
  META_CURSOR_PATTERN,
  META_TEMPLATE_ID_PATTERN,
  MetaTemplateApiError,
  type MetaTemplateApiDeps,
} from './metaTemplateApi';
import { escapeRegex } from '../utils/reportSearch';

/**
 * WhatsApp template management: drafts, submission to Meta, and reconciling
 * an uncertain submission. Authorization is enforced here, on every
 * operation, so a route can never forget it.
 *
 * Who may do what:
 *   SuperAdmin  every template; may create shared templates (no owner) or
 *               templates for a given Admin.
 *   Admin       only with an explicit grant from a Super Admin
 *               (canManageWhatsAppTemplates): their own templates, and read-only
 *               access to shared ones. Never another Admin's.
 *   User        nothing here.
 * The role and the grant are read from the database on every call
 * (templatePermission); the caller's claimed role is never trusted.
 *
 * Submission is a persistent state machine:
 *   Draft | SubmissionFailed --claim--> Submitting --Meta--> Pending | Approved | Rejected …
 *                                                  \-definite error--> SubmissionFailed
 *                                                  \-no answer--> Unknown --reconcile--> found: Meta's status
 *                                                                                      not found: SubmissionFailed
 * SubmissionFailed can be reconciled too: a request that timed out may still
 * complete at Meta after the first lookup found nothing.
 * The claim is one atomic update, so a double click or a second tab cannot
 * submit twice. An uncertain outcome is never resubmitted blindly: Meta is
 * asked whether the template exists first. Approved is only ever Meta's word.
 */

export type TemplateActor = AuthUserInfo & { name?: string };

/** Meta allows 100 template creations per WhatsApp Business Account per hour. */
export const SUBMISSIONS_PER_HOUR = 100;
/** Longer than the 30 s request timeout: a Submitting claim older than this is stale. */
export const SUBMISSION_LEASE_MS = 2 * 60 * 1000;
const HISTORY_LIMIT = 50;

export class TemplateServiceError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly errors?: FieldError[];

  constructor(code: string, message: string, httpStatus: number, errors?: FieldError[]) {
    super(message);
    this.name = 'TemplateServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.errors = errors;
  }

  toResponse() {
    return { success: false as const, error: { code: this.code, message: this.message, ...(this.errors ? { errors: this.errors } : {}) } };
  }
}

export interface TemplateServiceDeps {
  meta?: MetaTemplateApiDeps;
  connection?: WhatsAppConnection;
  now?: () => Date;
}

const nowOf = (deps: TemplateServiceDeps) => (deps.now ? deps.now() : new Date());
const connectionOf = (deps: TemplateServiceDeps) => deps.connection ?? deps.meta?.connection ?? readWhatsAppConnection();
const metaDeps = (deps: TemplateServiceDeps): MetaTemplateApiDeps => ({ ...deps.meta, connection: connectionOf(deps) });

// ── authorization ───────────────────────────────────────────────────────────

const isSuperAdmin = (actor: TemplateActor) => actor?.role === 'SuperAdmin';
const isAdmin = (actor: TemplateActor) => actor?.role === 'Admin';

/**
 * The caller, with the role the database holds - or 403. Everything after this
 * uses the returned actor, never the one passed in.
 */
const requireManager = async (actor: TemplateActor): Promise<TemplateActor> => {
  const role = await templateManagerRole(actor?.id);
  if (!role) {
    throw new TemplateServiceError('ACCESS_DENIED', 'You do not have permission to manage WhatsApp templates.', 403);
  }
  return { ...actor, id: String(actor.id), role };
};

const ownerOf = (template: Pick<IWhatsAppTemplate, 'ownerAdminId'>) => (template.ownerAdminId ? String(template.ownerAdminId) : null);

export const canViewTemplate = (actor: TemplateActor, template: Pick<IWhatsAppTemplate, 'ownerAdminId'>) =>
  isSuperAdmin(actor) || (isAdmin(actor) && (ownerOf(template) === null || ownerOf(template) === String(actor.id)));

export const canManageTemplate = (actor: TemplateActor, template: Pick<IWhatsAppTemplate, 'ownerAdminId'>) =>
  isSuperAdmin(actor) || (isAdmin(actor) && ownerOf(template) === String(actor.id));

const loadManageable = async (caller: TemplateActor, id: unknown): Promise<{ template: IWhatsAppTemplate; actor: TemplateActor }> => {
  const actor = await requireManager(caller);
  if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
    throw new TemplateServiceError('VALIDATION_ERROR', 'A valid template id is required.', 400);
  }
  const template = await WhatsAppTemplate.findById(id);
  // Not found and not yours look the same: no probing of other clients' ids.
  if (!template || !canViewTemplate(actor, template)) throw new TemplateServiceError('TEMPLATE_NOT_FOUND', 'Template not found.', 404);
  if (!canManageTemplate(actor, template)) {
    throw new TemplateServiceError('ACCESS_DENIED', 'This template is shared. Only a Super Admin can change it.', 403);
  }
  return { template, actor };
};

/** The owner a new template gets: an Admin always owns their own. */
const resolveOwner = async (actor: TemplateActor, requested: unknown): Promise<string | null> => {
  if (isAdmin(actor)) return String(actor.id);
  if (requested === undefined || requested === null || requested === '') return null;
  if (typeof requested !== 'string' || !mongoose.Types.ObjectId.isValid(requested)) {
    throw new TemplateServiceError('VALIDATION_ERROR', 'ownerAdminId must be an Admin id.', 400, [{ field: 'ownerAdminId', message: 'Choose a valid Admin.' }]);
  }
  const admin = await Admin.findById(requested).select('role').lean();
  if (!admin || (admin as any).role !== 'Admin') {
    throw new TemplateServiceError('VALIDATION_ERROR', 'ownerAdminId must be an Admin id.', 400, [{ field: 'ownerAdminId', message: 'Choose a valid Admin.' }]);
  }
  return requested;
};

/** An event-specific template: the event must be one the actor can manage, and the owner's. */
const resolveEvent = async (actor: TemplateActor, requested: unknown, ownerAdminId: string | null): Promise<string | null> => {
  if (requested === undefined || requested === null || requested === '') return null;
  if (typeof requested !== 'string' || !mongoose.Types.ObjectId.isValid(requested)) {
    throw new TemplateServiceError('VALIDATION_ERROR', 'eventId must be an event id.', 400, [{ field: 'eventId', message: 'Choose a valid event.' }]);
  }
  if (!(await isEventAuthorized(actor, requested))) {
    throw new TemplateServiceError('ACCESS_DENIED', 'You do not have access to that event.', 403);
  }
  const event: any = await Event.findById(requested).select('adminId createdBy').lean();
  if (!event) throw new TemplateServiceError('EVENT_NOT_FOUND', 'Event not found.', 404);
  const eventOwner = String(event.adminId ?? event.createdBy ?? '');
  if (ownerAdminId && eventOwner !== ownerAdminId) {
    throw new TemplateServiceError('VALIDATION_ERROR', "The event must belong to the template's owner.", 400, [{ field: 'eventId', message: "Choose one of the owner's events." }]);
  }
  return requested;
};

// ── helpers ─────────────────────────────────────────────────────────────────

const historyEntry = (type: string, actor: TemplateActor | null, extra: { metaStatus?: string | null; code?: number | string | null; message?: string | null } = {}, at = new Date()) => ({
  at,
  type,
  actorId: actor?.id && mongoose.Types.ObjectId.isValid(actor.id) ? new mongoose.Types.ObjectId(actor.id) : null,
  metaStatus: extra.metaStatus ?? null,
  code: extra.code ?? null,
  message: extra.message ? extra.message.slice(0, 500) : null,
});

const pushHistory = (entry: ReturnType<typeof historyEntry>) => ({ history: { $each: [entry], $slice: -HISTORY_LIMIT } });

const audit = (action: string, actor: TemplateActor | null, template: { _id: any; name: string; language: string }, description: string) =>
  AuditService.log({
    action,
    collectionName: 'whatsapptemplates',
    documentId: String(template._id),
    actor: actor ? { userId: actor.id, email: actor.email ?? null, name: actor.name ?? actor.email ?? null, role: actor.role } : null,
    description: `${description}: ${template.name} (${template.language})`,
  });

const definitionOf = (t: IWhatsAppTemplate): TemplateDraftInput => ({
  displayName: t.displayName,
  name: t.name,
  language: t.language,
  category: t.category,
  // Not read back: category changes are never offered, whatever is stored.
  headerText: t.headerText,
  body: t.body,
  footer: t.footer,
  variables: (t.variables || []).map((v: any) => ({ ...(v.toObject ? v.toObject() : v) })),
  buttons: (t.buttons || []).map((b: any) => ({ ...(b.toObject ? b.toObject() : b) })),
});

/** Meta's error, as a sentence a client can act on. Already scrubbed of the token. */
const reasonFrom = (error: MetaTemplateApiError) =>
  [error.message, error.meta?.details].filter((s, i, all) => s && all.indexOf(s) === i).join(' - ').slice(0, 1000);

/**
 * The template as the API returns it. The WhatsApp Business Account id is not
 * secret, but only a Super Admin needs it, so only a Super Admin sees it.
 */
export const toTemplateView = (t: IWhatsAppTemplate | any, viewer?: TemplateActor) => {
  const o = typeof t.toObject === 'function' ? t.toObject() : t;
  return {
    id: String(o._id),
    ...(viewer?.role === 'SuperAdmin' ? { wabaId: o.wabaId } : {}),
    ownerAdminId: o.ownerAdminId ? String(o.ownerAdminId) : null,
    createdBy: o.createdBy ? String(o.createdBy) : null,
    displayName: o.displayName,
    name: o.name,
    language: o.language,
    category: o.category,
    allowCategoryChange: o.allowCategoryChange,
    eventId: o.eventId ? String(o.eventId) : null,
    headerText: o.headerText ?? null,
    body: o.body,
    footer: o.footer ?? null,
    variables: o.variables ?? [],
    buttons: o.buttons ?? [],
    localState: o.localState,
    metaTemplateId: o.metaTemplateId ?? null,
    metaStatus: o.metaStatus ?? null,
    metaCategory: o.metaCategory ?? null,
    rejectionReason: o.rejectionReason ?? null,
    lastSyncedAt: o.lastSyncedAt ?? null,
    submissionAttempts: o.submission?.attempts ?? 0,
    history: (o.history ?? []).map((h: any) => ({ ...h, actorId: h.actorId ? String(h.actorId) : null })),
    version: o.version,
    replacesTemplateId: o.replacesTemplateId ? String(o.replacesTemplateId) : null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
};

const requireValid = (input: TemplateDraftInput) => {
  const { value, errors } = validateTemplateDraft(input);
  if (!value) throw new TemplateServiceError('VALIDATION_ERROR', 'The template has problems to fix.', 400, errors);
  return value;
};

const duplicateName = (error: any) => error?.code === 11000;

// ── drafts ──────────────────────────────────────────────────────────────────

export interface TemplateDraftRequest extends TemplateDraftInput {
  eventId?: unknown;
  ownerAdminId?: unknown;
}

export const createTemplateDraft = async (caller: TemplateActor, input: TemplateDraftRequest, deps: TemplateServiceDeps = {}) => {
  const actor = await requireManager(caller);
  const wabaId = connectionOf(deps).wabaId;
  if (!wabaId) {
    throw new TemplateServiceError('CONFIGURATION_ERROR', 'WhatsApp template management is not configured on the server (missing WHATSAPP_WABA_ID).', 503);
  }
  const value = requireValid(input);
  const ownerAdminId = await resolveOwner(actor, input.ownerAdminId);
  const eventId = await resolveEvent(actor, input.eventId, ownerAdminId);

  try {
    const template = await WhatsAppTemplate.create({
      ...value,
      wabaId,
      ownerAdminId,
      eventId,
      createdBy: actor.id,
      updatedBy: actor.id,
      localState: 'Draft',
      history: [historyEntry('created', actor, {}, nowOf(deps))],
    });
    await audit('WHATSAPP_TEMPLATE_CREATED', actor, template, 'Created WhatsApp template');
    return toTemplateView(template, actor);
  } catch (error: any) {
    if (duplicateName(error)) {
      throw new TemplateServiceError('TEMPLATE_NAME_TAKEN', `A template named "${value.name}" in ${value.language} already exists.`, 409, [{ field: 'name', message: 'Choose another name.' }]);
    }
    throw error;
  }
};

/** Edits a template that has not been accepted by Meta (Draft or SubmissionFailed). */
export const updateTemplateDraft = async (caller: TemplateActor, id: unknown, input: TemplateDraftRequest, deps: TemplateServiceDeps = {}) => {
  const { template: existing, actor } = await loadManageable(caller, id);
  if (!EDITABLE_STATES.includes(existing.localState)) {
    throw new TemplateServiceError('TEMPLATE_LOCKED', `A template that is ${existing.localState} cannot be edited here.`, 409);
  }

  const merged: TemplateDraftInput = { ...definitionOf(existing) };
  for (const key of ['displayName', 'name', 'language', 'category', 'allowCategoryChange', 'headerText', 'body', 'footer', 'variables', 'buttons'] as const) {
    if (input[key] !== undefined) (merged as any)[key] = input[key];
  }
  const value = requireValid(merged);
  const eventId = input.eventId !== undefined ? await resolveEvent(actor, input.eventId, ownerOf(existing)) : existing.eventId ? String(existing.eventId) : null;

  try {
    // Conditional on the state, so an edit can never land on a template that
    // was submitted between the read above and this write.
    const updated = await WhatsAppTemplate.findOneAndUpdate(
      { _id: existing._id, localState: { $in: EDITABLE_STATES } },
      { $set: { ...value, eventId, updatedBy: actor.id }, $push: pushHistory(historyEntry('updated', actor, {}, nowOf(deps))) },
      { new: true, runValidators: true }
    );
    if (!updated) throw new TemplateServiceError('TEMPLATE_LOCKED', 'The template was submitted while you were editing it.', 409);
    return toTemplateView(updated, actor);
  } catch (error: any) {
    if (duplicateName(error)) {
      throw new TemplateServiceError('TEMPLATE_NAME_TAKEN', `A template named "${value.name}" in ${value.language} already exists.`, 409, [{ field: 'name', message: 'Choose another name.' }]);
    }
    throw error;
  }
};

export const getTemplate = async (caller: TemplateActor, id: unknown) => {
  const actor = await requireManager(caller);
  if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
    throw new TemplateServiceError('VALIDATION_ERROR', 'A valid template id is required.', 400);
  }
  const template = await WhatsAppTemplate.findById(id);
  if (!template || !canViewTemplate(actor, template)) throw new TemplateServiceError('TEMPLATE_NOT_FOUND', 'Template not found.', 404);
  return toTemplateView(template, actor);
};

/**
 * Deletes a draft that was never sent to Meta. Local only: nothing is ever
 * deleted from Meta. Anything that reached Meta - or might have - is kept.
 */
export const deleteTemplateDraft = async (caller: TemplateActor, id: unknown) => {
  const { template, actor } = await loadManageable(caller, id);
  const neverSubmitted = { localState: 'Draft', 'submission.attempts': { $in: [0, null] }, metaTemplateId: null };
  const result = await WhatsAppTemplate.deleteOne({ _id: template._id, ...neverSubmitted });
  if (result.deletedCount === 0) {
    throw new TemplateServiceError('TEMPLATE_LOCKED', 'Only a draft that was never submitted to WhatsApp can be deleted.', 409);
  }
  await audit('WHATSAPP_TEMPLATE_DELETED', actor, template, 'Deleted WhatsApp template draft');
};

export interface TemplateListFilters {
  q?: unknown;
  category?: unknown;
  language?: unknown;
  eventId?: unknown;
  state?: unknown;
  page?: unknown;
  limit?: unknown;
}

export const TEMPLATE_PAGE_SIZE_DEFAULT = 20;
export const TEMPLATE_PAGE_SIZE_MAX = 100;

const positiveInt = (value: unknown, fallback: number) => {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const listTemplates = async (caller: TemplateActor, filters: TemplateListFilters = {}) => {
  const actor = await requireManager(caller);
  const query: any = isSuperAdmin(actor) ? {} : { $or: [{ ownerAdminId: new mongoose.Types.ObjectId(actor.id) }, { ownerAdminId: null }] };

  const q = typeof filters.q === 'string' ? filters.q.trim().slice(0, 100) : '';
  if (q) {
    const pattern = { $regex: escapeRegex(q), $options: 'i' };
    query.$and = [{ $or: [{ displayName: pattern }, { name: pattern }] }];
  }
  if (typeof filters.category === 'string' && filters.category) query.category = filters.category.toUpperCase();
  if (typeof filters.language === 'string' && filters.language) query.language = filters.language;
  if (typeof filters.state === 'string' && filters.state) query.localState = filters.state;
  if (typeof filters.eventId === 'string' && filters.eventId) {
    if (!mongoose.Types.ObjectId.isValid(filters.eventId)) throw new TemplateServiceError('VALIDATION_ERROR', 'eventId must be an event id.', 400);
    query.eventId = new mongoose.Types.ObjectId(filters.eventId);
  }

  const page = positiveInt(filters.page, 1);
  const limit = Math.min(TEMPLATE_PAGE_SIZE_MAX, positiveInt(filters.limit, TEMPLATE_PAGE_SIZE_DEFAULT));
  const [templates, total] = await Promise.all([
    // _id breaks ties so pages never overlap or skip a template.
    WhatsAppTemplate.find(query).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    WhatsAppTemplate.countDocuments(query),
  ]);
  return {
    data: templates.map((t) => toTemplateView(t, actor)),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
};

// ── submission ──────────────────────────────────────────────────────────────

export type SubmissionOutcome = 'submitted' | 'rejected' | 'uncertain' | 'reconciled' | 'superseded';

export interface SubmissionResult {
  outcome: SubmissionOutcome;
  message: string;
  template: ReturnType<typeof toTemplateView>;
}

/** The stored template as a view - after a write the caller was already allowed to make. */
const viewOf = async (id: any, viewer?: TemplateActor) => toTemplateView(await WhatsAppTemplate.findById(id), viewer);

/** Applies a write only if this attempt still holds the Submitting claim. */
const finishAttempt = (id: any, attemptId: string, set: Record<string, any>, entry: ReturnType<typeof historyEntry>) =>
  WhatsAppTemplate.updateOne({ _id: id, localState: 'Submitting', 'submission.attemptId': attemptId }, { $set: set, $push: pushHistory(entry) });

/**
 * The hash of exactly what would be sent to Meta. The review shows it with the
 * payload; a submission that carries it can only send that payload, so what
 * the person reviewed is what is sent.
 */
export const payloadHashOf = (payload: unknown) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export interface SubmissionReview {
  template: ReturnType<typeof toTemplateView>;
  /** The request body, exactly as it would be POSTed to Meta. Contains no credentials. */
  payload: ReturnType<typeof buildMetaCreatePayload> | null;
  payloadHash: string | null;
  canSubmit: boolean;
  blockers: string[];
  errors?: FieldError[];
}

/**
 * What submitting this template would send, built on the server from the
 * stored definition. Read only: nothing is sent, claimed or changed. A
 * template that cannot be submitted comes back with the reasons.
 */
export const reviewTemplateSubmission = async (caller: TemplateActor, id: unknown, deps: TemplateServiceDeps = {}): Promise<SubmissionReview> => {
  const { template, actor } = await loadManageable(caller, id);
  const view = toTemplateView(template, actor);
  const blockers: string[] = [];

  if (!EDITABLE_STATES.includes(template.localState)) {
    blockers.push(
      template.localState === 'Unknown'
        ? 'The last submission had no clear answer from WhatsApp. Check its status before submitting again.'
        : `This template has already been submitted (${template.localState}).`
    );
  }
  const connection = connectionOf(deps);
  if (!connection.accessToken || !connection.wabaId) blockers.push('WhatsApp template management is not configured on the server.');
  else if (connection.wabaId !== template.wabaId) blockers.push('This template belongs to a different WhatsApp Business Account than the one configured.');

  const { value, errors } = validateTemplateDraft(definitionOf(template));
  if (!value) {
    blockers.push('The template has problems that must be fixed first.');
    return { template: view, payload: null, payloadHash: null, canSubmit: false, blockers, errors };
  }
  const payload = buildMetaCreatePayload(value);
  return { template: view, payload, payloadHash: payloadHashOf(payload), canSubmit: blockers.length === 0, blockers };
};

export interface SubmitOptions {
  /** The hash from the review. When given it must match what would be sent. */
  confirmPayloadHash?: string;
  /** The HTTP route sets this: a submission without a reviewed hash is refused. */
  requireConfirmation?: boolean;
}

export const submitTemplate = async (
  caller: TemplateActor,
  id: unknown,
  deps: TemplateServiceDeps = {},
  options: SubmitOptions = {}
): Promise<SubmissionResult> => {
  const { template, actor } = await loadManageable(caller, id);

  if (!EDITABLE_STATES.includes(template.localState)) {
    if (template.localState === 'Submitting') {
      throw new TemplateServiceError('SUBMISSION_IN_PROGRESS', 'This template is already being submitted.', 409);
    }
    if (template.localState === 'Unknown') {
      throw new TemplateServiceError('RECONCILE_REQUIRED', 'The last submission had no clear answer from WhatsApp. Check its status before submitting again.', 409);
    }
    throw new TemplateServiceError('ALREADY_SUBMITTED', `This template has already been submitted (${template.localState}).`, 409);
  }

  const value = requireValid(definitionOf(template));
  const connection = connectionOf(deps);
  if (!connection.accessToken || !connection.wabaId) {
    throw new TemplateServiceError('CONFIGURATION_ERROR', 'WhatsApp template management is not configured on the server.', 503);
  }
  if (connection.wabaId !== template.wabaId) {
    throw new TemplateServiceError('ACCOUNT_MISMATCH', 'This template belongs to a different WhatsApp Business Account than the one configured.', 409);
  }
  const payload = buildMetaCreatePayload(value);
  if (options.requireConfirmation && !options.confirmPayloadHash) {
    throw new TemplateServiceError('CONFIRMATION_REQUIRED', 'Review the payload and confirm it before submitting.', 400);
  }
  if (options.confirmPayloadHash && options.confirmPayloadHash !== payloadHashOf(payload)) {
    throw new TemplateServiceError('PAYLOAD_CHANGED', 'The template changed after it was reviewed. Review the payload again before submitting.', 409);
  }

  const now = nowOf(deps);
  const recent = await WhatsAppTemplate.countDocuments({
    wabaId: template.wabaId,
    'submission.startedAt': { $gte: new Date(now.getTime() - 60 * 60 * 1000) },
  });
  if (recent >= SUBMISSIONS_PER_HOUR) {
    throw new TemplateServiceError('RATE_LIMITED', `WhatsApp allows ${SUBMISSIONS_PER_HOUR} new templates per hour. Try again later.`, 429);
  }

  // The claim: exactly one request can move the template to Submitting.
  const attemptId = crypto.randomUUID();
  const claimed = await WhatsAppTemplate.findOneAndUpdate(
    { _id: template._id, localState: { $in: EDITABLE_STATES } },
    {
      $set: { localState: 'Submitting', 'submission.attemptId': attemptId, 'submission.startedAt': now, rejectionReason: null, updatedBy: actor.id },
      $inc: { 'submission.attempts': 1 },
      $push: pushHistory(historyEntry('submitting', actor, {}, now)),
    },
    { new: true }
  );
  if (!claimed) throw new TemplateServiceError('SUBMISSION_IN_PROGRESS', 'This template is already being submitted.', 409);

  try {
    const created = await createMetaTemplate(payload, metaDeps(deps));
    const localState = mapMetaStatus(created.status);
    await finishAttempt(
      claimed._id,
      attemptId,
      { localState, metaTemplateId: created.id, metaStatus: created.status, metaCategory: created.category, lastSyncedAt: nowOf(deps), 'submission.attemptId': null },
      historyEntry('submitted', actor, { metaStatus: created.status }, nowOf(deps))
    );
    await audit('WHATSAPP_TEMPLATE_SUBMITTED', actor, claimed, 'Submitted WhatsApp template to Meta');
    return {
      outcome: 'submitted',
      message: localState === 'Approved' ? 'WhatsApp approved the template.' : 'Submitted to WhatsApp for review. Approval is decided by Meta.',
      template: await viewOf(claimed._id, actor),
    };
  } catch (error: any) {
    if (!(error instanceof MetaTemplateApiError)) {
      // Our own failure after the claim: Meta's answer is not known.
      await finishAttempt(claimed._id, attemptId, { localState: 'Unknown' }, historyEntry('uncertain', actor, { message: 'Internal error during submission' }, nowOf(deps)));
      throw error;
    }

    if (error.kind === 'AMBIGUOUS') {
      await finishAttempt(
        claimed._id,
        attemptId,
        { localState: 'Unknown' },
        historyEntry('uncertain', actor, { code: error.meta?.code ?? null, message: error.message }, nowOf(deps))
      );
      await audit('WHATSAPP_TEMPLATE_SUBMISSION_UNCERTAIN', actor, claimed, 'WhatsApp template submission had no clear answer');
      // Ask Meta once, straight away. If that fails too, the template stays
      // Unknown and can be reconciled later - it is never resubmitted blindly.
      try {
        const observed = await WhatsAppTemplate.findById(claimed._id);
        if (observed && observed.localState === 'Unknown' && observed.submission?.attemptId === attemptId) {
          return await reconcileInternal(actor, observed, deps);
        }
        throw new Error('moved on');
      } catch {
        return {
          outcome: 'uncertain',
          message: 'WhatsApp did not confirm the submission. Check its status before submitting again.',
          template: await viewOf(claimed._id, actor),
        };
      }
    }

    // Meta answered with an error, or refused the credentials or the rate:
    // nothing was created, so the template can be fixed and submitted again.
    const reason = reasonFrom(error);
    await finishAttempt(
      claimed._id,
      attemptId,
      { localState: 'SubmissionFailed', rejectionReason: reason, 'submission.attemptId': null },
      historyEntry('submission_failed', actor, { code: error.meta?.code ?? error.kind, message: reason }, nowOf(deps))
    );
    await audit('WHATSAPP_TEMPLATE_SUBMISSION_FAILED', actor, claimed, 'WhatsApp template submission failed');
    return { outcome: 'rejected', message: reason, template: await viewOf(claimed._id, actor) };
  }
};

// ── reconciliation ──────────────────────────────────────────────────────────

/**
 * Asks Meta about the template exactly as the caller observed it. Every write
 * is guarded on that observed state and attempt, so if anything moved on
 * meanwhile - a new submission claimed it - nothing here overwrites it.
 */
const reconcileInternal = async (actor: TemplateActor | null, template: IWhatsAppTemplate, deps: TemplateServiceDeps): Promise<SubmissionResult> => {
  const id = String(template._id);

  // A lookup failure propagates: the template stays as it is.
  const nodes = await findMetaTemplatesByName(template.name, metaDeps(deps));
  const match = nodes.find((n) => n.language === template.language);
  const now = nowOf(deps);
  const guard = { _id: template._id, localState: template.localState, 'submission.attemptId': template.submission?.attemptId ?? null };
  const superseded = async (): Promise<SubmissionResult> => ({
    outcome: 'superseded',
    message: 'The template changed while it was being checked. Its current state is shown.',
    template: toTemplateView(await WhatsAppTemplate.findById(id), actor ?? undefined),
  });

  if (match) {
    const localState = mapMetaStatus(match.status);
    const written = await WhatsAppTemplate.updateOne(guard, {
      $set: { localState, metaTemplateId: match.id, metaStatus: match.status, metaCategory: match.category, rejectionReason: null, lastSyncedAt: now, 'submission.attemptId': null },
      $push: pushHistory(historyEntry('reconciled_found', actor, { metaStatus: match.status }, now)),
    });
    if (written.modifiedCount === 0) return superseded();
    await audit('WHATSAPP_TEMPLATE_RECONCILED', actor, template, 'WhatsApp template found on Meta after an uncertain submission');
    return {
      outcome: 'reconciled',
      message: 'WhatsApp has the template. Its status has been updated.',
      template: toTemplateView(await WhatsAppTemplate.findById(id), actor ?? undefined),
    };
  }

  const reason = 'WhatsApp has no record of this template, so it was not created. You can submit it again.';
  if (template.localState === 'SubmissionFailed') {
    // Still not there: it stays as it was, with the time it was checked.
    const written = await WhatsAppTemplate.updateOne(guard, { $set: { lastSyncedAt: now }, $push: pushHistory(historyEntry('reconciled_absent', actor, { message: reason }, now)) });
    if (written.modifiedCount === 0) return superseded();
    return { outcome: 'reconciled', message: reason, template: toTemplateView(await WhatsAppTemplate.findById(id), actor ?? undefined) };
  }
  const written = await WhatsAppTemplate.updateOne(guard, {
    $set: { localState: 'SubmissionFailed', rejectionReason: reason, lastSyncedAt: now, 'submission.attemptId': null },
    $push: pushHistory(historyEntry('reconciled_absent', actor, { message: reason }, now)),
  });
  if (written.modifiedCount === 0) return superseded();
  await audit('WHATSAPP_TEMPLATE_RECONCILED', actor, template, 'WhatsApp template not found on Meta after an uncertain submission');
  return { outcome: 'reconciled', message: reason, template: toTemplateView(await WhatsAppTemplate.findById(id), actor ?? undefined) };
};

/**
 * Settles a template whose submission had no clear answer (Unknown), whose
 * Submitting claim has gone stale (the process stopped mid-request), or that
 * failed (SubmissionFailed) but may exist at Meta after all, by asking Meta
 * whether it exists.
 */
export const reconcileTemplate = async (caller: TemplateActor, id: unknown, deps: TemplateServiceDeps = {}): Promise<SubmissionResult> => {
  const { template, actor } = await loadManageable(caller, id);
  const now = nowOf(deps).getTime();
  const startedAt = template.submission?.startedAt ? new Date(template.submission.startedAt).getTime() : 0;

  if (template.localState === 'Submitting' && now - startedAt < SUBMISSION_LEASE_MS) {
    throw new TemplateServiceError('SUBMISSION_IN_PROGRESS', 'This template is still being submitted.', 409);
  }
  if (!['Unknown', 'Submitting', 'SubmissionFailed'].includes(template.localState)) {
    throw new TemplateServiceError('NOTHING_TO_RECONCILE', `This template is ${template.localState}; there is no uncertain submission to check.`, 409);
  }

  try {
    return await reconcileInternal(actor, template, deps);
  } catch (error: any) {
    if (error instanceof MetaTemplateApiError) {
      if (template.localState === 'Submitting') {
        // The stale claim becomes Unknown, which is what it is.
        await WhatsAppTemplate.updateOne(
          { _id: template._id, localState: 'Submitting', 'submission.attemptId': template.submission.attemptId },
          { $set: { localState: 'Unknown' }, $push: pushHistory(historyEntry('uncertain', actor, { message: 'Stale submission could not be checked' }, nowOf(deps))) }
        );
      }
      throw new TemplateServiceError(
        error.kind === 'CONFIGURATION' ? 'CONFIGURATION_ERROR' : 'META_UNAVAILABLE',
        `Could not check the template with WhatsApp: ${error.message}`,
        error.kind === 'CONFIGURATION' ? 503 : 502
      );
    }
    throw error;
  }
};

// ── the account's templates, as Meta lists them ─────────────────────────────

/** A Meta failure while listing, as this API's error. Nothing is stored either way. */
const listError = (error: MetaTemplateApiError): TemplateServiceError => {
  switch (error.kind) {
    case 'CONFIGURATION':
      return new TemplateServiceError('CONFIGURATION_ERROR', error.message, 503);
    case 'AUTHENTICATION':
      return new TemplateServiceError('META_AUTH_ERROR', error.message, 502);
    case 'RATE_LIMITED':
      return new TemplateServiceError('RATE_LIMITED', "WhatsApp's rate limit was reached. Try again later.", 429);
    case 'AMBIGUOUS':
      return new TemplateServiceError('META_UNAVAILABLE', error.message, 502);
    default:
      return new TemplateServiceError('META_ERROR', `WhatsApp refused the request: ${error.message}`, 502);
  }
};

export interface AccountTemplateListing {
  templates: Array<Awaited<ReturnType<typeof listMetaTemplates>>['templates'][number] & { localTemplateId: string | null; sendableFromHere: boolean }>;
  nextCursor: string | null;
  skipped: number;
  fetchedAt: string;
}

/**
 * One page of the whole WhatsApp Business Account's templates, read from Meta
 * on request - never on a timer. The account's templates are not all this
 * person's, so only a Super Admin may see the list. Nothing is written: a
 * listed status never changes a stored template. `sendableFromHere` is true
 * only for a template EventReach also holds, in the Approved state, with
 * Meta's own listed status APPROVED - the listing alone sends nothing.
 */
export const listAccountTemplates = async (
  caller: TemplateActor,
  query: { after?: unknown; limit?: unknown } = {},
  deps: TemplateServiceDeps = {}
): Promise<AccountTemplateListing> => {
  const actor = await requireManager(caller);
  if (!isSuperAdmin(actor)) {
    throw new TemplateServiceError('ACCESS_DENIED', 'Only a Super Admin can browse every template of the WhatsApp Business Account.', 403);
  }
  if (query.after !== undefined && (typeof query.after !== 'string' || !META_CURSOR_PATTERN.test(query.after))) {
    throw new TemplateServiceError('VALIDATION_ERROR', 'The page cursor is not valid.', 400);
  }
  const limit = query.limit === undefined ? undefined : Number(query.limit);
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new TemplateServiceError('VALIDATION_ERROR', 'The page size must be a positive number.', 400);
  }
  const connection = connectionOf(deps);
  if (!connection.accessToken || !connection.wabaId) {
    throw new TemplateServiceError('CONFIGURATION_ERROR', 'WhatsApp template management is not configured on the server.', 503);
  }

  let page;
  try {
    page = await listMetaTemplates({ after: query.after as string | undefined, limit }, metaDeps(deps));
  } catch (error: any) {
    if (error instanceof MetaTemplateApiError) throw listError(error);
    throw error;
  }

  const local = await WhatsAppTemplate.find({ wabaId: connection.wabaId, metaTemplateId: { $in: page.templates.map((t) => t.id) } })
    .select('_id metaTemplateId localState')
    .lean();
  const byMetaId = new Map(local.map((l: any) => [String(l.metaTemplateId), l]));

  return {
    templates: page.templates.map((t) => {
      const match: any = byMetaId.get(t.id);
      return { ...t, localTemplateId: match ? String(match._id) : null, sendableFromHere: Boolean(match && match.localState === 'Approved' && t.status === 'APPROVED') };
    }),
    nextCursor: page.nextCursor,
    skipped: page.skipped,
    fetchedAt: nowOf(deps).toISOString(),
  };
};

// ── manual status refresh ───────────────────────────────────────────────────

/** A template's status is asked of Meta at most this often, per template. */
export const REFRESH_COOLDOWN_MS = 30 * 1000;
const META_STATUS_SET = new Set<string>(META_TEMPLATE_STATUSES);

export type RefreshOutcome = 'approved' | 'rejected' | 'pending' | 'updated' | 'not_found' | 'superseded';

export interface RefreshResult {
  outcome: RefreshOutcome;
  message: string;
  template: ReturnType<typeof toTemplateView>;
}

/** A Meta failure during a refresh, as this API's error. The status is never changed by one. */
const refreshError = (error: MetaTemplateApiError): TemplateServiceError => {
  const unchanged = 'The status was not changed.';
  switch (error.kind) {
    case 'CONFIGURATION':
      return new TemplateServiceError('CONFIGURATION_ERROR', `${error.message} ${unchanged}`, 503);
    case 'AUTHENTICATION':
      // 502, never 401/403: the user's session is fine; the server's credentials are not.
      return new TemplateServiceError('META_AUTH_ERROR', `${error.message} ${unchanged}`, 502);
    case 'RATE_LIMITED':
      return new TemplateServiceError('RATE_LIMITED', `WhatsApp's rate limit was reached. Try again later. ${unchanged}`, 429);
    case 'AMBIGUOUS':
      return new TemplateServiceError('META_UNAVAILABLE', `${error.message} ${unchanged}`, 502);
    default:
      return new TemplateServiceError('META_ERROR', `WhatsApp refused the status lookup: ${error.message} ${unchanged}`, 502);
  }
};

const rejectionText = (reason: string | null) =>
  reason && reason !== 'NONE' ? `Rejected by Meta (reason: ${reason}).` : 'Rejected by Meta.';

/**
 * Asks Meta for a Pending template's current status and records it.
 *
 * [Meta] GET /{template-id} with fields id, name, language, status, category,
 * rejected_reason. Read only: nothing is created, edited, deleted or
 * resubmitted at Meta. The answer is trusted only if it is this template - the
 * stored id, name and language - and a status Meta documents; otherwise
 * nothing changes. Every write is conditional on the template being exactly
 * as it was when the refresh started, so a slow answer can never overwrite a
 * newer state.
 */
export const refreshTemplateStatus = async (caller: TemplateActor, id: unknown, deps: TemplateServiceDeps = {}): Promise<RefreshResult> => {
  const { template, actor } = await loadManageable(caller, id);

  if (template.localState !== 'Pending') {
    throw new TemplateServiceError('NOT_REFRESHABLE', `Only a template pending review can be refreshed. This one is ${template.localState}.`, 409);
  }
  const metaTemplateId = template.metaTemplateId;
  if (!metaTemplateId || !META_TEMPLATE_ID_PATTERN.test(metaTemplateId)) {
    throw new TemplateServiceError('NOT_REFRESHABLE', 'This template has no valid WhatsApp template id, so its status cannot be checked.', 409);
  }
  const connection = connectionOf(deps);
  if (!connection.accessToken || !connection.wabaId) {
    throw new TemplateServiceError('CONFIGURATION_ERROR', 'WhatsApp template management is not configured on the server.', 503);
  }
  if (!template.wabaId || template.wabaId !== connection.wabaId) {
    throw new TemplateServiceError('ACCOUNT_MISMATCH', 'This template belongs to a different WhatsApp Business Account than the one configured.', 409);
  }

  // The claim: at most one lookup per template per cooldown, so double clicks
  // and several tabs reach Meta once.
  const now = nowOf(deps);
  const claimed = await WhatsAppTemplate.findOneAndUpdate(
    {
      _id: template._id,
      localState: 'Pending',
      metaTemplateId,
      $or: [{ refreshRequestedAt: null }, { refreshRequestedAt: { $lte: new Date(now.getTime() - REFRESH_COOLDOWN_MS) } }],
    },
    { $set: { refreshRequestedAt: now } },
    { new: true }
  );
  if (!claimed) {
    const current = await WhatsAppTemplate.findById(template._id);
    if (!current || current.localState !== 'Pending' || current.metaTemplateId !== metaTemplateId) {
      return {
        outcome: 'superseded',
        message: 'The template changed while it was being checked. Its current state is shown.',
        template: toTemplateView(current ?? template, actor),
      };
    }
    const at = current.refreshRequestedAt ? new Date(current.refreshRequestedAt).getTime() : now.getTime();
    const wait = Math.max(1, Math.ceil((at + REFRESH_COOLDOWN_MS - now.getTime()) / 1000));
    throw new TemplateServiceError('REFRESH_TOO_SOON', `The status was checked a moment ago. Try again in ${wait}s.`, 429);
  }

  const guard = { _id: claimed._id, localState: 'Pending', metaTemplateId, 'submission.attemptId': claimed.submission?.attemptId ?? null };
  const superseded = async (): Promise<RefreshResult> => ({
    outcome: 'superseded',
    message: 'The template changed while it was being checked. Its current state is shown.',
    template: await viewOf(claimed._id, actor),
  });

  let node;
  try {
    node = await getMetaTemplateById(metaTemplateId, metaDeps(deps));
  } catch (error: any) {
    if (!(error instanceof MetaTemplateApiError)) throw error;
    // Meta does not document what reading a missing id returns; its read
    // errors list 100 "Invalid parameter". Rather than guess, ask the
    // documented list endpoint whether the template is still there.
    if (error.kind === 'REJECTED' && error.meta?.code === 100) {
      return refreshMissing(actor, claimed, guard, deps, superseded);
    }
    throw refreshError(error);
  }

  if (
    node.id !== metaTemplateId ||
    node.name !== claimed.name ||
    node.language !== claimed.language ||
    !node.status ||
    !META_STATUS_SET.has(node.status)
  ) {
    throw new TemplateServiceError('META_RESPONSE_INVALID', 'WhatsApp answered with something other than this template. The status was not changed.', 502);
  }

  const localState = mapMetaStatus(node.status);
  const checkedAt = nowOf(deps);
  const written = await WhatsAppTemplate.updateOne(guard, {
    $set: {
      localState,
      metaStatus: node.status,
      metaCategory: node.category ?? claimed.metaCategory,
      rejectionReason: node.status === 'REJECTED' ? rejectionText(node.rejectedReason) : null,
      lastSyncedAt: checkedAt,
    },
    $push: pushHistory(historyEntry('refreshed', actor, { metaStatus: node.status }, checkedAt)),
  });
  if (written.matchedCount === 0) return superseded();
  if (localState !== 'Pending') {
    await audit('WHATSAPP_TEMPLATE_STATUS_REFRESHED', actor, claimed, `WhatsApp template status is now ${node.status}`);
  }

  const view = await viewOf(claimed._id, actor);
  switch (node.status) {
    case 'APPROVED':
      return { outcome: 'approved', message: 'WhatsApp approved the template. It can now be used for messages.', template: view };
    case 'REJECTED':
      return { outcome: 'rejected', message: `WhatsApp rejected the template. ${rejectionText(node.rejectedReason)}`, template: view };
    case 'PENDING':
      return { outcome: 'pending', message: 'Still pending review at WhatsApp.', template: view };
    case 'IN_APPEAL':
      return { outcome: 'pending', message: 'A rejection is being appealed. Still pending at WhatsApp.', template: view };
    default:
      return { outcome: 'updated', message: `WhatsApp reports the template as ${node.status}. It cannot be sent.`, template: view };
  }
};

/**
 * The id lookup failed with "invalid parameter". Is the template still listed
 * under its name and language? If not, it is reported as not found and its
 * status left as it was - it is never marked deleted on a guess.
 */
const refreshMissing = async (
  actor: TemplateActor,
  claimed: IWhatsAppTemplate,
  guard: Record<string, any>,
  deps: TemplateServiceDeps,
  superseded: () => Promise<RefreshResult>
): Promise<RefreshResult> => {
  let nodes;
  try {
    nodes = await findMetaTemplatesByName(claimed.name, metaDeps(deps));
  } catch (error: any) {
    if (error instanceof MetaTemplateApiError) throw refreshError(error);
    throw error;
  }
  if (nodes.some((n) => n.language === claimed.language)) {
    throw new TemplateServiceError('META_RESPONSE_INVALID', 'WhatsApp lists this template but could not read it by its id. The status was not changed.', 502);
  }
  const message = 'WhatsApp has no template with this name and language. It may have been deleted there. The status was not changed.';
  const written = await WhatsAppTemplate.updateOne(guard, { $push: pushHistory(historyEntry('refresh_not_found', actor, { message }, nowOf(deps))) });
  if (written.matchedCount === 0) return superseded();
  return { outcome: 'not_found', message, template: await viewOf(claimed._id, actor) };
};
