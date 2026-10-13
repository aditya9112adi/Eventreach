import {
  COMMON_TEMPLATE_LANGUAGES,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_EDITABLE_STATES,
  WHATSAPP_TEMPLATE_LIMITS,
  WHATSAPP_TEMPLATE_STATES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
  scanTemplatePlaceholders,
  validateTemplateDraft,
  type TemplateFieldError,
  type WhatsAppTemplateState,
  type WhatsAppTemplateVariableSource,
} from '@eventreach/shared';

/**
 * WhatsApp template management - the page logic, kept free of React so it can
 * be tested without a browser. Validation itself is the shared
 * validateTemplateDraft the API runs too; nothing here re-implements a rule.
 *
 * The server decides every permission. What this module says a viewer "can"
 * do only decides which controls to draw.
 */

export {
  COMMON_TEMPLATE_LANGUAGES,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_LIMITS,
  WHATSAPP_TEMPLATE_STATES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS,
};

export const TEMPLATES_API = '/whatsapp/templates';
export const templateAccessUrl = (adminId: string) => `/admin/admins/${adminId}/whatsapp-template-access`;

// ── shapes the API returns ──────────────────────────────────────────────────

export interface TemplateVariableView {
  position: number;
  label: string;
  source: WhatsAppTemplateVariableSource;
  fixedValue?: string;
  fallback?: string;
  sample: string;
}

export interface TemplateHistoryView {
  at: string;
  type: string;
  actorId: string | null;
  metaStatus: string | null;
  code: number | string | null;
  message: string | null;
}

export interface TemplateView {
  id: string;
  /** Present only for a Super Admin. */
  wabaId?: string;
  ownerAdminId: string | null;
  createdBy: string | null;
  displayName: string;
  name: string;
  language: string;
  category: string;
  eventId: string | null;
  headerText: string | null;
  body: string;
  footer: string | null;
  variables: TemplateVariableView[];
  localState: WhatsAppTemplateState;
  metaTemplateId: string | null;
  metaStatus: string | null;
  metaCategory: string | null;
  rejectionReason: string | null;
  lastSyncedAt: string | null;
  submissionAttempts: number;
  history: TemplateHistoryView[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplatePage {
  data: TemplateView[];
  pagination: { total: number; page: number; limit: number; totalPages: number };
}

/** A list response, read defensively: anything malformed becomes an empty page. */
export const parseTemplatePage = (body: any): TemplatePage => {
  const data = Array.isArray(body?.data) ? body.data : [];
  const p = body?.pagination ?? {};
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  return {
    data,
    pagination: { total: num(p.total, data.length), page: num(p.page, 1) || 1, limit: num(p.limit, 20) || 20, totalPages: num(p.totalPages, 0) },
  };
};

// ── who sees what ───────────────────────────────────────────────────────────

export interface Viewer {
  id?: string;
  role?: string;
  canManageWhatsAppTemplates?: boolean;
}

/** Whether to show the Templates page in the navigation. Not a security check. */
export const canSeeTemplatesPage = (viewer: Viewer | null | undefined): boolean => viewer?.canManageWhatsAppTemplates === true;

/** A shared template (no owner) is read-only for an Admin; a Super Admin manages all. */
export const viewerManages = (viewer: Viewer | null | undefined, t: Pick<TemplateView, 'ownerAdminId'>): boolean =>
  viewer?.role === 'SuperAdmin' || (!!viewer?.id && t.ownerAdminId === viewer.id);

export interface TemplateActions {
  edit: boolean;
  submit: boolean;
  /** "Check status": for an uncertain or failed submission (the API's reconcile). */
  checkStatus: boolean;
  /** "Refresh status": ask Meta about a template pending review (the API's refresh). */
  refresh: boolean;
  delete: boolean;
}

/** The controls the API would accept for this template, matching its rules. */
export const templateActions = (viewer: Viewer | null | undefined, t: TemplateView): TemplateActions => {
  if (!viewerManages(viewer, t)) return { edit: false, submit: false, checkStatus: false, refresh: false, delete: false };
  const editable = (WHATSAPP_TEMPLATE_EDITABLE_STATES as readonly string[]).includes(t.localState);
  return {
    edit: editable,
    submit: editable,
    checkStatus: t.localState === 'Unknown' || t.localState === 'SubmissionFailed',
    refresh: t.localState === 'Pending',
    delete: t.localState === 'Draft' && !t.submissionAttempts && !t.metaTemplateId,
  };
};

// ── status ──────────────────────────────────────────────────────────────────

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

export const TEMPLATE_STATE_DISPLAY: Record<WhatsAppTemplateState, { label: string; variant: BadgeVariant; hint: string }> = {
  Draft: { label: 'Draft', variant: 'default', hint: 'Not submitted to WhatsApp yet.' },
  Submitting: { label: 'Submitting', variant: 'info', hint: 'Being sent to WhatsApp.' },
  Pending: { label: 'Pending review', variant: 'warning', hint: 'Submitted. Meta is reviewing it.' },
  Approved: { label: 'Approved', variant: 'success', hint: 'Meta approved it. It can be used for messages.' },
  Rejected: { label: 'Rejected', variant: 'error', hint: 'Meta rejected it.' },
  SubmissionFailed: { label: 'Submission failed', variant: 'error', hint: 'WhatsApp did not accept the submission. Fix it and submit again.' },
  Paused: { label: 'Paused', variant: 'warning', hint: 'Meta paused it.' },
  Disabled: { label: 'Disabled', variant: 'error', hint: 'Meta disabled it.' },
  Unknown: { label: 'Needs a check', variant: 'warning', hint: 'WhatsApp did not confirm the last submission. Check its status.' },
  Archived: { label: 'Archived', variant: 'default', hint: 'Archived by Meta.' },
  Deleted: { label: 'Deleted', variant: 'default', hint: 'Deleted at Meta.' },
};

export const stateDisplay = (state: string) =>
  TEMPLATE_STATE_DISPLAY[state as WhatsAppTemplateState] ?? { label: state || 'Unknown', variant: 'default' as BadgeVariant, hint: '' };

export const HISTORY_LABELS: Record<string, string> = {
  created: 'Created',
  updated: 'Edited',
  submitting: 'Submitted to WhatsApp',
  submitted: 'Accepted by WhatsApp for review',
  submission_failed: 'Submission failed',
  uncertain: 'No clear answer from WhatsApp',
  reconciled_found: 'Found at WhatsApp',
  reconciled_absent: 'Not found at WhatsApp',
  refreshed: 'Status checked at WhatsApp',
  refresh_not_found: 'Not found at WhatsApp when checked',
};

export const historyLabel = (type: string) => HISTORY_LABELS[type] ?? type;

// ── list page state ─────────────────────────────────────────────────────────

export type ListViewState = 'loading' | 'forbidden' | 'notConfigured' | 'error' | 'empty' | 'noMatches' | 'ready';

export const listViewState = (s: { loading: boolean; error: ApiProblem | null; page: TemplatePage | null; hasFilters: boolean }): ListViewState => {
  if (s.loading && !s.page) return 'loading';
  if (s.error) {
    if (s.error.kind === 'forbidden') return 'forbidden';
    if (s.error.kind === 'notConfigured') return 'notConfigured';
    return 'error';
  }
  if (!s.page) return 'loading';
  if (s.page.data.length === 0) return s.hasFilters ? 'noMatches' : 'empty';
  return 'ready';
};

export interface TemplateFilters {
  q: string;
  category: string;
  language: string;
  eventId: string;
  state: string;
}

export const EMPTY_FILTERS: TemplateFilters = { q: '', category: '', language: '', eventId: '', state: '' };

export const hasActiveFilters = (f: TemplateFilters) => Object.values(f).some((v) => v.trim() !== '');

/** Query parameters for GET /whatsapp/templates - only the filters that are set. */
export const listParams = (f: TemplateFilters, page: number, limit: number) => {
  const params: Record<string, string | number> = { page, limit };
  for (const key of ['q', 'category', 'language', 'eventId', 'state'] as const) {
    const value = f[key].trim();
    if (value) params[key] = value;
  }
  return params;
};

// ── errors ──────────────────────────────────────────────────────────────────

export type ApiProblemKind =
  | 'forbidden'
  | 'notFound'
  | 'validation'
  | 'conflict'
  | 'rateLimited'
  | 'notConfigured'
  | 'unavailable'
  | 'network'
  | 'unknown';

export interface ApiProblem {
  kind: ApiProblemKind;
  status: number | null;
  code: string | null;
  message: string;
  fieldErrors: Record<string, string>;
}

/** Field errors keyed by the field path the API uses ("variables.2.sample"). */
export const fieldErrorMap = (errors: unknown): Record<string, string> => {
  const map: Record<string, string> = {};
  if (!Array.isArray(errors)) return map;
  for (const e of errors as TemplateFieldError[]) {
    if (e && typeof e.field === 'string' && typeof e.message === 'string' && !map[e.field]) map[e.field] = e.message;
  }
  return map;
};

/**
 * An axios error as something the page can act on. A 401 never reaches a page
 * in practice: the API client clears the session and returns to sign-in.
 */
export const toApiProblem = (error: any): ApiProblem => {
  const status: number | null = typeof error?.response?.status === 'number' ? error.response.status : null;
  const body = error?.response?.data;
  const code: string | null = typeof body?.error?.code === 'string' ? body.error.code : null;
  const serverMessage: string | null =
    typeof body?.error?.message === 'string' ? body.error.message : typeof body?.error === 'string' ? body.error : null;
  const fieldErrors = fieldErrorMap(body?.error?.errors);

  const make = (kind: ApiProblemKind, fallback: string): ApiProblem => ({ kind, status, code, message: serverMessage || fallback, fieldErrors });

  if (status === null) return make('network', 'Could not reach the server. Check your connection and try again.');
  if (status === 403) return make('forbidden', 'You do not have permission to manage WhatsApp templates.');
  if (status === 404) return make('notFound', 'Template not found.');
  if (status === 400) return make('validation', 'Please fix the highlighted fields.');
  if (status === 409) return make('conflict', 'This template changed. Reload it and try again.');
  if (status === 429) return make('rateLimited', 'Too many requests. Please wait a moment and try again.');
  if (status === 503) return make('notConfigured', 'WhatsApp template management is not configured on the server.');
  if (status === 502 || status === 504) return make('unavailable', 'WhatsApp could not be reached. Please try again later.');
  return make('unknown', 'Something went wrong. Please try again.');
};

// ── editor ──────────────────────────────────────────────────────────────────

export interface VariableRow {
  position: number;
  label: string;
  source: WhatsAppTemplateVariableSource | '';
  fixedValue: string;
  fallback: string;
  sample: string;
}

export interface TemplateForm {
  displayName: string;
  name: string;
  language: string;
  category: string;
  eventId: string;
  ownerAdminId: string;
  headerText: string;
  body: string;
  footer: string;
  variables: VariableRow[];
}

export const EMPTY_FORM: TemplateForm = {
  displayName: '',
  name: '',
  language: 'en',
  category: 'MARKETING',
  eventId: '',
  ownerAdminId: '',
  headerText: '',
  body: '',
  footer: '',
  variables: [],
};

export const formFromTemplate = (t: TemplateView): TemplateForm => ({
  displayName: t.displayName,
  name: t.name,
  language: t.language,
  category: t.category,
  eventId: t.eventId ?? '',
  ownerAdminId: t.ownerAdminId ?? '',
  headerText: t.headerText ?? '',
  body: t.body,
  footer: t.footer ?? '',
  variables: [...t.variables]
    .sort((a, b) => a.position - b.position)
    .map((v) => ({ position: v.position, label: v.label, source: v.source, fixedValue: v.fixedValue ?? '', fallback: v.fallback ?? '', sample: v.sample })),
});

/** A Meta-style name from a display name: "Wedding Invite!" -> "wedding_invite". */
export const suggestTemplateName = (displayName: string): string =>
  displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, WHATSAPP_TEMPLATE_LIMITS.name);

const newRow = (position: number): VariableRow => ({
  position,
  label: position === 1 ? 'Guest name' : '',
  source: position === 1 ? 'guest.name' : '',
  fixedValue: '',
  fallback: '',
  sample: '',
});

/**
 * One mapping row per {{n}} in the body, keeping what was already typed for a
 * placeholder that is still there. While the body's placeholders are invalid
 * the rows are left as they were, so a half-typed "{{" never wipes them.
 */
export const syncVariableRows = (body: string, rows: VariableRow[]): { rows: VariableRow[]; placeholderError: string | null } => {
  const scan = scanTemplatePlaceholders(body);
  if (scan.error) return { rows, placeholderError: scan.error };
  const byPosition = new Map(rows.map((r) => [r.position, r]));
  return { rows: [...scan.positions].sort((a, b) => a - b).map((p) => byPosition.get(p) ?? newRow(p)), placeholderError: null };
};

/** What a row contributes to a preview. */
const previewValue = (row: VariableRow, blankGuestName: boolean): string => {
  if (row.source === 'fixed') return row.fixedValue.trim() || `[${row.label || `{{${row.position}}}`}]`;
  if (row.source === 'guest.name' && blankGuestName) return row.fallback.trim() || 'Guest';
  return row.sample.trim() || `[${row.label || `{{${row.position}}}`}]`;
};

/**
 * The body with each placeholder filled from its sample (fixed text for a
 * fixed value). With blankGuestName, a guest-name placeholder shows what a
 * guest without a name receives: "Guest", unless a fallback was set.
 */
export const renderPreview = (body: string, rows: VariableRow[], options: { blankGuestName?: boolean } = {}): string => {
  const byPosition = new Map(rows.map((r) => [r.position, r]));
  return body.replace(/\{\{(\d+)\}\}/g, (match, n) => {
    const row = byPosition.get(Number(n));
    return row ? previewValue(row, !!options.blankGuestName) : match;
  });
};

/**
 * The body POST /whatsapp/templates and PATCH accept. Category changes are
 * never requested - the field is not sent at all - and owner is sent only by
 * a Super Admin creating a template.
 */
export const buildTemplatePayload = (form: TemplateForm, options: { includeOwner?: boolean } = {}) => ({
  displayName: form.displayName.trim(),
  name: form.name.trim(),
  language: form.language.trim(),
  category: form.category,
  headerText: form.headerText.trim() || null,
  body: form.body.trim(),
  footer: form.footer.trim() || null,
  eventId: form.eventId || null,
  ...(options.includeOwner ? { ownerAdminId: form.ownerAdminId || null } : {}),
  variables: form.variables.map((v) => ({
    position: v.position,
    label: v.label.trim(),
    source: v.source,
    ...(v.source === 'fixed' ? { fixedValue: v.fixedValue.trim() } : {}),
    ...(v.fallback.trim() ? { fallback: v.fallback.trim() } : {}),
    sample: v.sample.trim(),
  })),
});

/** The shared validation the API runs, applied before sending. */
export const validateForm = (form: TemplateForm): Record<string, string> =>
  fieldErrorMap(validateTemplateDraft(buildTemplatePayload(form)).errors);

export const isFormDirty = (form: TemplateForm, saved: TemplateForm) => JSON.stringify(form) !== JSON.stringify(saved);

export const counter = (value: string, limit: number) => ({ used: value.length, limit, over: value.length > limit });

// ── submission outcomes ─────────────────────────────────────────────────────

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

/** POST /:id/submit, /:id/reconcile and /:id/refresh answer 200 with an outcome. */
export const outcomeToast = (result: { outcome?: string; message?: string }): { type: ToastKind; message: string } => {
  const message = result?.message || 'Done.';
  switch (result?.outcome) {
    case 'submitted':
    case 'reconciled':
    case 'approved':
      return { type: 'success', message };
    case 'rejected':
      return { type: 'error', message };
    case 'pending':
      return { type: 'info', message };
    case 'uncertain':
    case 'superseded':
    case 'updated':
    case 'not_found':
      return { type: 'warning', message };
    default:
      return { type: 'info', message };
  }
};

// ── unsaved changes ─────────────────────────────────────────────────────────

/**
 * Whether a click should ask before leaving the editor: a plain left click on
 * an in-app link to another page. New-tab clicks, downloads and links out of
 * the app leave the editor open, so they are not stopped.
 */
export const shouldConfirmLeaving = (click: {
  dirty: boolean;
  button: number;
  modifier: boolean;
  defaultPrevented: boolean;
  href: string | null;
  target: string | null;
  download: boolean;
  origin: string;
  currentPath: string;
}): boolean => {
  if (!click.dirty || click.defaultPrevented || click.button !== 0 || click.modifier || click.download) return false;
  if (!click.href || (click.target && click.target !== '_self')) return false;
  let url: URL;
  try {
    url = new URL(click.href, click.origin);
  } catch {
    return false;
  }
  return url.origin === click.origin && url.pathname !== click.currentPath;
};

// ── Just Access: the permission toggle ──────────────────────────────────────

export interface AccessRecordLike {
  _id?: string;
  id?: string;
  role?: string;
  type?: string;
  canManageWhatsAppTemplates?: boolean;
}

/** Shown only to a Super Admin, only on Admin rows. The API enforces both. */
export const templateAccessControl = (viewer: Viewer | null | undefined, record: AccessRecordLike) => {
  const visible = viewer?.role === 'SuperAdmin' && record.role === 'Admin';
  const granted = record.canManageWhatsAppTemplates === true;
  return { visible, granted, next: granted ? ('revoke' as const) : ('grant' as const), needsConfirm: granted };
};

/** Applies the API's answer - never the request - to the list of records. */
export const applyTemplateAccess = <T extends AccessRecordLike>(records: T[], response: { id?: string; canManageWhatsAppTemplates?: boolean }): T[] =>
  typeof response?.id === 'string' && typeof response?.canManageWhatsAppTemplates === 'boolean'
    ? records.map((r) => ((r._id ?? r.id) === response.id ? { ...r, canManageWhatsAppTemplates: response.canManageWhatsAppTemplates } : r))
    : records;
