import {
  WHATSAPP_TEMPLATE_LIMITS,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS,
  checkEventBusinessId,
  scanTemplatePlaceholders,
  type WhatsAppTemplateVariableSource,
} from '@eventreach/shared';
import type { AccountTemplateView } from './whatsappTemplates';

/**
 * Linking a template that already exists, approved, at WhatsApp to an event ("Link to EventReach").
 *
 * What is decided here is only what the page shows and sends: whether to offer the action, what to ask for, and the
 * request body. The server reads the template from WhatsApp by its id, checks it belongs to the configured account and
 * is approved, finds the event from the typed Event ID, and stores everything itself. Nothing here is a permission,
 * and no ObjectId, status, account or template wording ever leaves the browser.
 *
 * Pure functions, so every rule can be tested without a browser.
 */

export const MEDIA_HEADER_FORMATS = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const;
const LINKABLE_BUTTONS = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'];

/** Offered only to a Super Admin, only for a template EventReach does not hold, and only if Meta lists it approved. */
export const canOfferLink = (t: AccountTemplateView, viewer: { role?: string } | null | undefined): boolean =>
  viewer?.role === 'SuperAdmin' && !t.localTemplateId && t.status === 'APPROVED';

/**
 * Parts of a listed template that EventReach cannot send, found from what the listing shows, so the person is told
 * before filling anything in. The server checks again from WhatsApp's own record and is what decides.
 */
export const linkBlockers = (t: AccountTemplateView): string[] => {
  const reasons: string[] = [];
  if (t.category === 'AUTHENTICATION') reasons.push('Authentication (one-time-password) templates cannot be sent from here.');
  const format = t.headerFormat;
  if (format && format !== 'TEXT' && !(MEDIA_HEADER_FORMATS as readonly string[]).includes(format)) {
    reasons.push(`A ${format.toLowerCase()} header cannot be sent from here.`);
  }
  if (t.headerText && t.headerText.includes('{{')) reasons.push('A header with a placeholder cannot be filled from here.');
  if (!t.bodyText) reasons.push('WhatsApp listed no message body for this template.');
  else {
    // The scanner's own wording, so the page says exactly what the server's check would: repeated, gapped, out of order, named or malformed.
    const placeholderProblem = scanTemplatePlaceholders(t.bodyText).error;
    if (placeholderProblem) reasons.push(`This template's placeholders cannot be filled from here. ${placeholderProblem}`);
  }
  for (const button of t.buttons ?? []) {
    if (!LINKABLE_BUTTONS.includes(button.type)) reasons.push(`A ${button.type.toLowerCase().replace(/_/g, ' ')} button cannot be sent from here.`);
  }
  return reasons;
};

/** The placeholder numbers in the body, in order of first appearance, each once. */
export const placeholderPositions = (bodyText: string | null | undefined): number[] =>
  [...new Set(scanTemplatePlaceholders(bodyText ?? '').positions)].sort((a, b) => a - b);

export interface LinkVariableRow {
  position: number;
  label: string;
  source: WhatsAppTemplateVariableSource | '';
  fixedValue: string;
}

export interface LinkForm {
  eventId: string;
  rows: LinkVariableRow[];
}

/** One empty row per placeholder: WhatsApp does not know what fills them, so the person chooses. */
export const initialLinkForm = (t: Pick<AccountTemplateView, 'bodyText'>): LinkForm => ({
  eventId: '',
  rows: placeholderPositions(t.bodyText).map((position) => ({ position, label: '', source: '', fixedValue: '' })),
});

/** Choosing a source names the placeholder after it, unless the person has already named it. */
export const withSource = (row: LinkVariableRow, source: LinkVariableRow['source']): LinkVariableRow => ({
  ...row,
  source,
  label: row.label.trim() === '' && source ? WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS[source] : row.label,
});

/** Problems with the form, keyed like the API's own field errors, so a server refusal lands on the same field. */
export const validateLinkForm = (form: LinkForm): Record<string, string> => {
  const errors: Record<string, string> = {};
  const event = checkEventBusinessId(form.eventId);
  if (!event.ok) errors.eventId = event.message;
  for (const row of form.rows) {
    const key = `variables.${row.position}`;
    if (!(WHATSAPP_TEMPLATE_VARIABLE_SOURCES as readonly string[]).includes(row.source)) errors[`${key}.source`] = `Choose what fills {{${row.position}}}.`;
    else if (row.source === 'fixed' && !row.fixedValue.trim()) errors[`${key}.fixedValue`] = `Enter the fixed text for {{${row.position}}}.`;
    const label = row.label.trim();
    if (!label) errors[`${key}.label`] = `Give {{${row.position}}} a name.`;
    else if (label.length > WHATSAPP_TEMPLATE_LIMITS.variableLabel) errors[`${key}.label`] = `The name must be at most ${WHATSAPP_TEMPLATE_LIMITS.variableLabel} characters.`;
  }
  return errors;
};

/**
 * The request: which WhatsApp template, which event (the typed business ID), and what fills each placeholder.
 * Deliberately nothing else - not the body, status, account, owner or an ObjectId.
 */
export const buildLinkRequest = (t: Pick<AccountTemplateView, 'id'>, form: LinkForm) => ({
  metaTemplateId: t.id,
  eventId: form.eventId.trim(),
  variables: form.rows.map((row) => ({
    position: row.position,
    label: row.label.trim(),
    source: row.source,
    ...(row.source === 'fixed' ? { fixedValue: row.fixedValue.trim() } : {}),
  })),
});

/** What a media header means for the person using the template later. */
export const headerNote = (format: string | null | undefined): string | null => {
  if (!format || !(MEDIA_HEADER_FORMATS as readonly string[]).includes(format)) return null;
  const what = format === 'IMAGE' ? 'an image' : format === 'VIDEO' ? 'a video' : 'a document (PDF)';
  return `This template has a ${format.toLowerCase()} header: ${what} is attached each time it is sent.`;
};

/** The toast after POST /templates/link-meta answers 200 or 201. */
export const linkToast = (
  result: { created?: boolean; changed?: boolean; previousEventId?: string | null; template?: { name?: string; eventId?: string | null } }
): { type: 'success' | 'info'; message: string } => {
  const name = result.template?.name ?? 'The template';
  const event = result.template?.eventId ?? 'the event';
  if (result.created) return { type: 'success', message: `${name} is linked to ${event}. It can now be chosen in the Message tab for that event.` };
  if (result.changed) return { type: 'success', message: `${name} was already in EventReach. It is now linked to ${event}.` };
  return { type: 'info', message: `${name} is already in EventReach and linked to ${event}. Nothing changed.` };
};

/** After linking, the listed row becomes "Open in EventReach" and usable, without asking WhatsApp again. */
export const markLinked = (t: AccountTemplateView, localTemplateId: string): AccountTemplateView => ({
  ...t,
  localTemplateId,
  sendableFromHere: t.status === 'APPROVED',
});

/**
 * Lets one run at a time. State such as "busy" only updates on the next render, so two quick clicks can both pass a
 * check made against it; this flag changes at once. A call made while one is running does nothing and returns undefined.
 */
export const createSingleFlight = () => {
  let running = false;
  return async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      return await run();
    } finally {
      running = false;
    }
  };
};
