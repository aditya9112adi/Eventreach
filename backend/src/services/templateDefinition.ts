import {
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATES,
  WHATSAPP_TEMPLATE_EDITABLE_STATES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_LIMITS,
  scanTemplatePlaceholders,
  validateTemplateDraft,
  type WhatsAppTemplateCategory,
  type WhatsAppTemplateState,
  type WhatsAppTemplateVariableSource,
  type TemplateFieldError,
  type TemplateVariableInput,
  type TemplateDraftInput,
  type ValidatedTemplateVariable,
  type ValidatedTemplate,
  type TemplatePlaceholderScan,
} from '@eventreach/shared';

/**
 * WhatsApp template definitions on the server.
 *
 * Validation - categories, states, variable sources, Meta's limits, the
 * placeholder rules and validateTemplateDraft itself - lives in
 * @eventreach/shared, so the editor and the API apply exactly the same rules.
 * It is re-exported here under the names the backend already uses.
 *
 * What stays here is server-only: the payload sent to Meta and the reading of
 * Meta's statuses.
 */

export {
  WHATSAPP_TEMPLATE_CATEGORIES as TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATES as TEMPLATE_LOCAL_STATES,
  WHATSAPP_TEMPLATE_EDITABLE_STATES as EDITABLE_STATES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES as VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_LIMITS as LIMITS,
  scanTemplatePlaceholders as scanPlaceholders,
  validateTemplateDraft,
};
export type TemplateCategory = WhatsAppTemplateCategory;
export type TemplateLocalState = WhatsAppTemplateState;
export type VariableSource = WhatsAppTemplateVariableSource;
export type FieldError = TemplateFieldError;
export type ValidatedVariable = ValidatedTemplateVariable;
export type PlaceholderScan = TemplatePlaceholderScan;
export type { TemplateVariableInput, TemplateDraftInput, ValidatedTemplate };

// ── Meta payload ────────────────────────────────────────────────────────────

/**
 * The body of `POST /{WABA_ID}/message_templates` [Meta].
 *
 * parameter_format is omitted: Meta treats an omitted format as positional,
 * which is what EventReach uses, and omitting it keeps the request valid on
 * the Graph API version configured today.
 *
 * allow_category_change is always false: Meta may not move a template to
 * another category (and price) without the client choosing it.
 */
export const buildMetaCreatePayload = (template: ValidatedTemplate) => {
  const components: any[] = [];
  if (template.headerText) components.push({ type: 'HEADER', format: 'TEXT', text: template.headerText });

  const samples = [...template.variables].sort((a, b) => a.position - b.position).map((v) => v.sample);
  components.push({
    type: 'BODY',
    text: template.body,
    ...(samples.length > 0 ? { example: { body_text: [samples] } } : {}),
  });

  if (template.footer) components.push({ type: 'FOOTER', text: template.footer });

  // [Meta: components - BUTTONS] one component holding the buttons, after the
  // footer. Only fields Meta documents for these types are sent: no example,
  // because the links here are fixed and have no variable.
  if (template.buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: template.buttons.map((b) =>
        b.type === 'URL'
          ? { type: 'URL', text: b.text, url: b.url }
          : b.type === 'PHONE_NUMBER'
            ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phoneNumber }
            : { type: 'QUICK_REPLY', text: b.text }
      ),
    });
  }

  return {
    name: template.name,
    language: template.language,
    category: template.category,
    allow_category_change: false,
    components,
  };
};

// ── Meta status ─────────────────────────────────────────────────────────────

/**
 * Meta's template status [Meta: APPROVED, IN_APPEAL, PENDING, REJECTED,
 * PENDING_DELETION, DELETED, DISABLED, PAUSED, LIMIT_EXCEEDED, ARCHIVED] as a
 * local state. The raw value is always stored alongside; anything not listed
 * here is Unknown rather than guessed.
 */
export const mapMetaStatus = (metaStatus: unknown): TemplateLocalState => {
  switch (typeof metaStatus === 'string' ? metaStatus.toUpperCase() : '') {
    case 'APPROVED':
      return 'Approved';
    case 'PENDING':
    case 'IN_APPEAL':
      return 'Pending';
    case 'REJECTED':
      return 'Rejected';
    case 'PAUSED':
    // [Meta] "paused due to template pacing" - a pause, not a rejection.
    case 'LIMIT_EXCEEDED':
      return 'Paused';
    case 'DISABLED':
      return 'Disabled';
    case 'ARCHIVED':
      return 'Archived';
    case 'PENDING_DELETION':
    case 'DELETED':
      return 'Deleted';
    default:
      return 'Unknown';
  }
};

/**
 * The statuses a template can have, as Meta's template node documents them
 * (GET /{template-id}). A status lookup that answers anything else is not
 * trusted.
 */
export const META_TEMPLATE_STATUSES = [
  'APPROVED', 'IN_APPEAL', 'PENDING', 'REJECTED', 'PENDING_DELETION', 'DELETED', 'DISABLED', 'PAUSED', 'LIMIT_EXCEEDED',
] as const;

/** Only a template Meta has confirmed as approved can be sent. */
export const isTemplateSendable = (template: { localState?: string; metaStatus?: string | null }): boolean =>
  template.localState === 'Approved' && template.metaStatus === 'APPROVED';
