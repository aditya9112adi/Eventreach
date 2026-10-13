import type { BadgeVariant } from './whatsappTemplates';

/**
 * Testing an approved template from the POC sender - the page logic, free of
 * React so it can be tested without a browser.
 *
 * Nothing here decides what is allowed: the server checks the sender, the
 * template, the recipient and the values on every preview and again on send.
 * What this module says only decides which controls are drawn and enabled, and
 * it errs towards disabled: a malformed answer from the server never enables
 * sending.
 */

export const POC_API = '/whatsapp/poc-test';
export const TEST_SEND_ROUTE = '/whatsapp/test-send';

// ── shapes the API returns ──────────────────────────────────────────────────

export interface PocSenderView {
  id: string;
  label: string;
  verifiedName: string;
  displayPhoneNumberMasked: string;
  metaStatus: string | null;
  statusCheckedAt: string | null;
  statusFresh: boolean;
  qualityRating: string | null;
  capabilities: {
    pocTestEnabled: boolean;
    enabled: boolean;
    listedInMeta: boolean;
    inConfiguredAccount: boolean;
    allowedForYou: boolean;
    connected: boolean;
  };
  eligible: boolean;
  reasons: string[];
}

export interface PocConfigView {
  tokenConfigured: boolean;
  wabaConfigured: boolean;
  missing: string[];
}

export interface PocTemplateView {
  id: string;
  name: string;
  displayName: string;
  language: string;
  category: string;
  body: string;
  localState: string;
  metaStatus: string | null;
  variables: { position: number; label: string; sample: string }[];
  buttons: { type: string; text: string }[];
  sendable: boolean;
  reasons: string[];
}

export interface PocRecipientView {
  id: string;
  label: string;
  phoneMasked: string;
  consentNote: string;
  consentRecordedAt: string;
  status: 'active' | 'revoked';
}

export type TestSendOutcome = 'accepted' | 'failed' | 'unknown' | 'in_progress' | 'confirmed_received' | 'confirmed_not_received';

export interface TestSendView {
  id: string;
  outcome: TestSendOutcome;
  state: string;
  message: string;
  template: { id: string; name: string; language: string };
  senderId: string;
  recipient: { id: string; numberMasked: string };
  variableCount: number;
  messageId: string | null;
  delivery: 'sent' | 'delivered' | 'read' | 'failed' | null;
  deliveryUpdatedAt: string | null;
  errorCategory: string | null;
  metaErrorCode: number | null;
  outcomeCode: string | null;
  claimedAt: string;
  completedAt: string | null;
  reconciledAt: string | null;
  retry: { safe: boolean; reason: string };
}

export interface AuditEntryView {
  at: string;
  action: string;
  description: string;
  success: boolean;
  by: string | null;
  role: string | null;
}

export interface PreviewView {
  preview: {
    sender: { id: string; label: string; numberMasked: string; status: string };
    template: { id: string; name: string; language: string; category: string; status: string | null };
    recipient: { id: string; label: string; numberMasked: string; consent: string };
    renderedBody: string;
    footer: string | null;
    buttons: { type: string; text: string }[];
    variableCount: number;
  };
  confirmation: { previewHash: string; idempotencyKey: string };
  duplicateRisk: { sendId: string; state: string; claimedAt: string } | null;
  notice: string;
}

const list = <T>(value: unknown, keep: (item: any) => boolean): T[] => (Array.isArray(value) ? (value.filter((item) => item && keep(item)) as T[]) : []);

export const parsePocSenders = (body: any): { senders: PocSenderView[]; config: PocConfigView } => ({
  senders: list<PocSenderView>(body?.senders, (s) => typeof s.id === 'string' && typeof s.capabilities === 'object').map((s) => ({ ...s, reasons: Array.isArray(s.reasons) ? s.reasons : [] })),
  config: {
    tokenConfigured: body?.config?.tokenConfigured === true,
    wabaConfigured: body?.config?.wabaConfigured === true,
    missing: Array.isArray(body?.config?.missing) ? body.config.missing.filter((m: unknown) => typeof m === 'string') : [],
  },
});

export const parsePocTemplates = (body: any): PocTemplateView[] =>
  list<PocTemplateView>(body?.templates, (t) => typeof t.id === 'string' && typeof t.name === 'string').map((t) => ({
    ...t,
    variables: Array.isArray(t.variables) ? [...t.variables].sort((a, b) => a.position - b.position) : [],
    buttons: Array.isArray(t.buttons) ? t.buttons : [],
    reasons: Array.isArray(t.reasons) ? t.reasons : [],
    // Sendable only when the server said so explicitly.
    sendable: t.sendable === true,
  }));

export const parsePocRecipients = (body: any): PocRecipientView[] =>
  list<PocRecipientView>(body?.recipients, (r) => typeof r.id === 'string' && typeof r.phoneMasked === 'string');

export const parseTestSends = (body: any): TestSendView[] => list<TestSendView>(body?.sends, (s) => typeof s.id === 'string' && typeof s.outcome === 'string');

/** A preview the page may act on: it must carry the hash and key the send needs. */
export const parsePreview = (body: any): PreviewView | null => {
  const hash = body?.confirmation?.previewHash;
  const key = body?.confirmation?.idempotencyKey;
  if (!body?.preview || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || typeof key !== 'string' || key.length < 16) return null;
  return body as PreviewView;
};

// ── selection and values ────────────────────────────────────────────────────

export interface Selection {
  senderId: string;
  templateId: string;
  recipientId: string;
  values: string[];
}

export const EMPTY_SELECTION: Selection = { senderId: '', templateId: '', recipientId: '', values: [] };

/** Only a template the server marked sendable can be chosen. */
export const selectableTemplates = (templates: PocTemplateView[]) => templates.filter((t) => t.sendable);

/** Whether a sender can be chosen, from what is stored. The server re-checks with Meta. */
export const senderSelectable = (sender: PocSenderView) => sender.eligible === true;

export const activeRecipients = (recipients: PocRecipientView[]) => recipients.filter((r) => r.status === 'active');

/** Per-placeholder problems, by index, using the same rules Meta and the server apply. */
export const valueErrors = (template: PocTemplateView | null, values: string[]): Record<number, string> => {
  const errors: Record<number, string> = {};
  if (!template) return errors;
  template.variables.forEach((v, i) => {
    const raw = values[i] ?? '';
    const text = raw.trim();
    if (!text) errors[i] = `Enter a value for {{${v.position}}} (${v.label}).`;
    else if (text.length > 1024) errors[i] = 'At most 1024 characters.';
    else if (/[\n\r\t]/.test(raw) || / {5,}/.test(raw)) errors[i] = 'No line breaks, tabs or more than four spaces in a row.';
  });
  return errors;
};

/** The selection is complete enough to ask the server for a preview. */
export const canPreview = (selection: Selection, template: PocTemplateView | null, busy: boolean) =>
  !busy && !!selection.senderId && !!selection.templateId && !!selection.recipientId && !!template && template.sendable && Object.keys(valueErrors(template, selection.values)).length === 0;

/** A fingerprint of the inputs: a preview is only good for the selection it was made from. */
export const selectionKey = (s: Selection) => JSON.stringify([s.senderId, s.templateId, s.recipientId, s.values.map((v) => v.trim())]);

export const previewRequest = (s: Selection) => ({ senderId: s.senderId, templateId: s.templateId, recipientId: s.recipientId, variables: s.values.map((v) => v.trim()) });

// ── confirming ──────────────────────────────────────────────────────────────

export interface SendReadiness {
  preview: PreviewView | null;
  /** The selection the preview was made from, and the one on screen now. */
  previewKey: string | null;
  currentKey: string;
  confirmed: boolean;
  acknowledgedDuplicate: boolean;
  busy: boolean;
}

/** Sending is possible only for a fresh preview of the current selection, explicitly confirmed. */
export const canSend = (r: SendReadiness): boolean =>
  !!r.preview &&
  r.previewKey === r.currentKey &&
  r.confirmed &&
  !r.busy &&
  (!r.preview.duplicateRisk || r.acknowledgedDuplicate);

export const sendRequest = (s: Selection, preview: PreviewView, acknowledgedDuplicate: boolean) => ({
  ...previewRequest(s),
  confirmed: true,
  previewHash: preview.confirmation.previewHash,
  idempotencyKey: preview.confirmation.idempotencyKey,
  ...(acknowledgedDuplicate ? { acknowledgeDuplicateRisk: true } : {}),
});

// ── results ─────────────────────────────────────────────────────────────────

export const OUTCOME_DISPLAY: Record<TestSendOutcome, { label: string; variant: BadgeVariant; tone: 'success' | 'error' | 'warning' | 'info' }> = {
  accepted: { label: 'Accepted by WhatsApp', variant: 'info', tone: 'info' },
  failed: { label: 'Not sent', variant: 'error', tone: 'error' },
  unknown: { label: 'Result unknown', variant: 'warning', tone: 'warning' },
  in_progress: { label: 'Sending', variant: 'info', tone: 'info' },
  confirmed_received: { label: 'Confirmed received', variant: 'success', tone: 'success' },
  confirmed_not_received: { label: 'Confirmed not received', variant: 'error', tone: 'error' },
};

export const outcomeDisplay = (outcome: string) => OUTCOME_DISPLAY[outcome as TestSendOutcome] ?? { label: 'Result unknown', variant: 'warning' as BadgeVariant, tone: 'warning' as const };

/** Delivery is reported by WhatsApp later and only ever shown as reported. */
export const deliveryDisplay = (delivery: TestSendView['delivery']): { label: string; variant: BadgeVariant } => {
  switch (delivery) {
    case 'sent': return { label: 'Sent to the recipient\'s phone network', variant: 'info' };
    case 'delivered': return { label: 'Delivered', variant: 'success' };
    case 'read': return { label: 'Read', variant: 'success' };
    case 'failed': return { label: 'Delivery failed', variant: 'error' };
    default: return { label: 'No delivery report yet', variant: 'default' };
  }
};

/** Only an Unknown send is reconciled by a person; it sends nothing. */
export const canReconcile = (send: TestSendView) => send.outcome === 'unknown';

/** Whether to offer starting over for this send, and what to say. */
export const retryAdvice = (send: TestSendView) =>
  send.retry?.safe === true ? { offer: true, text: send.retry.reason } : { offer: false, text: send.retry?.reason ?? 'Sending again could deliver it twice.' };

/** An API error as a sentence for the page. A refused request always says nothing was sent. */
export const problemText = (error: any): string => {
  const message = error?.response?.data?.error?.message;
  if (typeof message === 'string' && message) return message;
  if (error?.response?.status === undefined) return 'Could not reach the server. The message may or may not have been sent: check the history before trying again.';
  return 'Something went wrong. Please try again.';
};

/** A send request that got no answer at all is unknown, not failed: the history is the source of truth. */
export const sendNoAnswer = (error: any) => error?.response?.status === undefined;
