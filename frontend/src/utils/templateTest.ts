/**
 * Single-guest WhatsApp template test: the decisions the Campaign Composer
 * makes around it, kept out of the component so they can be tested.
 *
 * An approved template is filled by Meta, not by this app — the frontend never
 * builds the message text that is sent. It only renders a preview of what the
 * approved body will look like once Meta substitutes the values the backend
 * resolved from the event and the guest.
 */

export interface TemplateVariable {
  /** 1-based: matches {{1}} in the approved template. */
  index: number;
  /** Which event/guest field the value came from. */
  field: string;
  value: string;
}

export interface TemplatePreview {
  templateName: string;
  languageCode: string;
  templateStatus: string | null;
  /** The approved body as Meta holds it, or null when it could not be read. */
  bodyText: string | null;
  bodySource: 'meta' | 'unavailable';
  placeholderMismatch: boolean;
  variables: TemplateVariable[];
  recipient: {
    contactId: string;
    fullName: string;
    phoneNumber: string;
    phoneValid: boolean;
    phoneError?: string;
  };
  event: { eventId: string; eventName: string };
}

/** Friendly names for the template's variable sources. */
export const VARIABLE_LABELS: Record<string, string> = {
  recipientName: 'Guest name',
  eventName: 'Event name',
  eventDate: 'Event date',
  eventTime: 'Event time',
  eventVenue: 'Venue',
};

export const variableLabel = (field: string): string => VARIABLE_LABELS[field] ?? field;

/**
 * Substitutes {{1}}, {{2}}, … in the approved body with the resolved values.
 * A placeholder with no matching value is left exactly as it is rather than
 * blanked, so a mismatch is visible in the preview instead of hidden.
 */
export const renderTemplateBody = (bodyText: string, variables: TemplateVariable[]): string => {
  const byIndex = new Map(variables.map((variable) => [variable.index, variable.value]));
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, digits) => {
    const value = byIndex.get(Number(digits));
    return value === undefined ? match : value;
  });
};

/** Identifies one exact test: the same key twice is the duplicate to prevent. */
export const selectionKey = (
  eventId: string,
  contactId: string,
  templateName: string
): string => `${eventId}:${contactId}:${templateName}`;

export interface SendGateState {
  eventId: string;
  contactId: string;
  templateName: string;
  preview: TemplatePreview | null;
  isSending: boolean;
  /** The selection already sent, from the previous successful send. */
  lastSentKey: string | null;
  /** Completed or cancelled events cannot be messaged. */
  eventSendable: boolean;
}

/**
 * Whether the Send button may fire. Exactly one guest, a preview that loaded,
 * a usable phone number, no send in flight, and never the same selection
 * twice — that last rule is what a double click runs into.
 */
export const canSendTemplate = (state: SendGateState): boolean => {
  if (!state.eventId || !state.contactId || !state.templateName) return false;
  if (!state.eventSendable || state.isSending) return false;
  const { preview } = state;
  if (!preview) return false;
  if (preview.recipient.contactId !== state.contactId) return false; // stale preview
  if (!preview.recipient.phoneValid || preview.placeholderMismatch) return false;
  return state.lastSentKey !== selectionKey(state.eventId, state.contactId, state.templateName);
};

/** Why the button is disabled, for the hint under it. '' when it is enabled. */
export const sendBlockedReason = (state: SendGateState): string => {
  if (!state.eventId) return 'Select an event.';
  if (!state.eventSendable) return 'This event is no longer accepting messages.';
  if (!state.contactId) return 'Select exactly one guest.';
  if (state.isSending) return 'Sending…';
  if (!state.preview) return 'Loading the template preview…';
  if (state.preview.recipient.contactId !== state.contactId) return 'Loading the template preview…';
  if (!state.preview.recipient.phoneValid) {
    return state.preview.recipient.phoneError
      ? `This guest's phone number cannot be used: ${state.preview.recipient.phoneError}`
      : "This guest's phone number cannot be used.";
  }
  if (state.preview.placeholderMismatch) {
    return 'The approved template expects a different number of values than this page fills.';
  }
  if (state.lastSentKey === selectionKey(state.eventId, state.contactId, state.templateName)) {
    return 'Already sent to this guest. Choose another guest, or use Send again.';
  }
  return '';
};

/**
 * A readable line from a failed request. The backend already returns messages
 * meant for a person, including Meta's rejection reason; the Meta error code
 * is appended when there is one, because that is what a Meta support page or
 * the template manager is searched by.
 */
export const describeSendError = (error: any): string => {
  const payload = error?.response?.data?.error;
  const message =
    (typeof payload?.message === 'string' && payload.message) ||
    (typeof error?.response?.data?.error === 'string' && error.response.data.error) ||
    (typeof error?.message === 'string' && error.message) ||
    'Failed to send the template message.';

  const code = payload?.meta?.code;
  return typeof code === 'number' ? `${message} (Meta error ${code})` : message;
};
