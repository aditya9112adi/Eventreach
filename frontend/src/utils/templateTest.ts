/**
 * WhatsApp template send from the Campaign Composer: the decisions around it,
 * kept out of the component so they can be tested.
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

// ── guest picker ─────────────────────────────────────────────────────────────

export interface GuestOption {
  _id: string;
  fullName: string;
  phoneNumber: string;
}

/**
 * Filters the visible guests by name or number. Selection lives outside this
 * list, so narrowing the search never changes who is selected.
 */
export const filterGuests = <T extends GuestOption>(guests: readonly T[], query: string): T[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [...guests];
  // Digits typed without the country code should still find "+9198…".
  const digits = q.replace(/\D/g, '');
  return guests.filter(
    (guest) =>
      guest.fullName.toLowerCase().includes(q) ||
      guest.phoneNumber.toLowerCase().includes(q) ||
      (digits.length > 0 && guest.phoneNumber.replace(/\D/g, '').includes(digits))
  );
};

/** What the closed selector shows — a count, never a list of names. */
export const guestSelectionLabel = (count: number): string => {
  if (count <= 0) return 'Select guests...';
  return count === 1 ? '1 guest selected' : `${count} guests selected`;
};

/**
 * Adds or removes one guest. Ids are a set: ticking a guest never disturbs the
 * ones already ticked, and the same guest can never appear twice.
 */
export const toggleGuest = (selected: readonly string[], guestId: string): string[] => {
  const next = new Set(selected);
  if (next.has(guestId)) next.delete(guestId);
  else next.add(guestId);
  return [...next];
};

/**
 * Select All applies to the guests currently listed, so it means what it says
 * while a search is narrowing the list — and it keeps selections the search is
 * hiding rather than silently dropping them.
 */
export const selectAllGuests = (
  selected: readonly string[],
  visible: readonly GuestOption[]
): string[] => [...new Set([...selected, ...visible.map((guest) => guest._id)])];

// ── sending ──────────────────────────────────────────────────────────────────

/** Identifies one exact send: the same key twice is the duplicate to prevent. */
export const selectionKey = (
  eventId: string,
  contactIds: readonly string[],
  templateName: string
): string => `${eventId}:${[...contactIds].sort().join(',')}:${templateName}`;

export interface SendGateState {
  eventId: string;
  contactIds: readonly string[];
  templateName: string;
  preview: TemplatePreview | null;
  isSending: boolean;
  /** The selection already sent, from the previous successful send. */
  lastSentKey: string | null;
  /** Completed or cancelled events cannot be messaged. */
  eventSendable: boolean;
}

/**
 * Whether the Send button may fire: at least one guest, a preview that loaded
 * for the first of them, no send in flight, and never the same selection twice
 * — that last rule is what a double click runs into.
 *
 * A phone number that cannot be used only blocks the send when it is the only
 * recipient; in a batch the server reports that guest as a failure and still
 * messages the others.
 */
export const canSendTemplate = (state: SendGateState): boolean => {
  if (!state.eventId || state.contactIds.length === 0 || !state.templateName) return false;
  if (!state.eventSendable || state.isSending) return false;
  const { preview } = state;
  if (!preview) return false;
  if (preview.recipient.contactId !== state.contactIds[0]) return false; // stale preview
  if (preview.placeholderMismatch) return false;
  if (!preview.recipient.phoneValid && state.contactIds.length === 1) return false;
  return state.lastSentKey !== selectionKey(state.eventId, state.contactIds, state.templateName);
};

/** Why the button is disabled, for the hint under it. '' when it is enabled. */
export const sendBlockedReason = (state: SendGateState): string => {
  if (!state.eventId) return 'Select an event.';
  if (!state.eventSendable) return 'This event is no longer accepting messages.';
  if (state.contactIds.length === 0) return 'Select at least one guest.';
  if (state.isSending) return 'Sending…';
  if (!state.preview) return 'Loading the template preview…';
  if (state.preview.recipient.contactId !== state.contactIds[0]) return 'Loading the template preview…';
  if (!state.preview.recipient.phoneValid && state.contactIds.length === 1) {
    return state.preview.recipient.phoneError
      ? `This guest's phone number cannot be used: ${state.preview.recipient.phoneError}`
      : "This guest's phone number cannot be used.";
  }
  if (state.preview.placeholderMismatch) {
    return 'The approved template expects a different number of values than this page fills.';
  }
  if (state.lastSentKey === selectionKey(state.eventId, state.contactIds, state.templateName)) {
    return 'Already sent to this selection. Change the guests, or use Send again.';
  }
  return '';
};

export interface SentRecipient {
  contactId: string;
  fullName: string;
  messageId: string;
  status: string;
}

export interface FailedRecipient {
  contactId: string;
  fullName: string | null;
  reason: string;
  code: string;
  /** Meta's own error number, when the rejection came from Meta. */
  metaCode?: number;
}

export interface SendSummary {
  tone: 'success' | 'partial' | 'error';
  headline: string;
  sent: SentRecipient[];
  failed: FailedRecipient[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Turns the endpoint's per-recipient result into what the panel shows.
 *
 * A batch where some recipients failed is never reported as a success: the
 * headline states both counts and every failure is listed with its reason.
 */
export const summarizeSendResult = (data: any): SendSummary => {
  const sent: SentRecipient[] = Array.isArray(data?.sent) ? data.sent : [];
  const rawFailed: FailedRecipient[] = Array.isArray(data?.failed) ? data.failed : [];
  // Meta's number is what a support page or the template manager is searched
  // by, so it is shown with the reason rather than dropped.
  const failed = rawFailed.map((recipient) =>
    typeof recipient.metaCode === 'number'
      ? { ...recipient, reason: `${recipient.reason} (Meta error ${recipient.metaCode})` }
      : recipient
  );
  const total = sent.length + failed.length;

  if (failed.length === 0) {
    return {
      tone: 'success',
      headline:
        sent.length === 1
          ? `WhatsApp accepted the message for ${sent[0].fullName}.`
          : `WhatsApp accepted all ${plural(sent.length, 'message')}.`,
      sent,
      failed,
    };
  }

  if (sent.length === 0) {
    return {
      tone: 'error',
      headline: `No messages were sent — ${plural(failed.length, 'guest')} failed.`,
      sent,
      failed,
    };
  }

  return {
    tone: 'partial',
    headline: `${sent.length} of ${total} messages sent — ${plural(failed.length, 'guest')} failed.`,
    sent,
    failed,
  };
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
