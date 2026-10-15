/**
 * Connecting a WhatsApp number through Meta's Embedded Signup - the page logic,
 * free of React and the DOM so it can be tested without a browser.
 *
 * Meta's popup reports back in two ways, and both are needed:
 *  - FB.login's callback carries a one-time `code` (authResponse.code), which
 *    lives about 30 seconds, so it is sent to the server at once;
 *  - a window `message` event from a facebook.com origin, whose JSON data has
 *    type "WA_EMBEDDED_SIGNUP" and event "FINISH" (with data.phone_number_id and
 *    data.waba_id), "FINISH_ONLY_WABA" (no number), "FINISH_WHATSAPP_BUSINESS_
 *    APP_ONBOARDING" (a WhatsApp Business app number - waba_id only), "CANCEL"
 *    (with data.current_step) or "ERROR".
 * Per Meta's Embedded Signup implementation guide (checked through search
 * excerpts of the official pages - the pages themselves could not be opened from
 * the development machine). data.business_id is read when present but never
 * required: it is not confirmed for Embedded Signup v4.
 *
 * Nothing the popup says is trusted as an outcome: the page only forwards it to
 * the server, which checks every id with Meta itself (services/
 * whatsappOnboardingService). A "connected" state is shown only when the server
 * says so.
 */

export const ONBOARDING_API = '/whatsapp-onboarding';
export const CONNECT_ROUTE = '/whatsapp/connect';

const META_ID = /^\d{5,30}$/;

export type SignupMessage =
  | { type: 'finish'; wabaId: string; phoneNumberId: string; businessId: string | null }
  | { type: 'finish_without_number'; wabaId: string | null }
  | { type: 'coexistence'; wabaId: string | null }
  | { type: 'cancel'; currentStep: string | null }
  | { type: 'error'; errorId: string | null };

/** Only Meta's own pages may speak for the popup: https and a facebook.com host. */
export const isMetaOrigin = (origin: unknown): boolean => {
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'));
  } catch {
    return false;
  }
};

const text = (value: unknown, pattern: RegExp): string | null => {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return pattern.test(s) ? s : null;
};

/**
 * The popup's message, if this event is one - otherwise null. Anything from
 * another origin, anything malformed, anything that is not an Embedded Signup
 * message is ignored.
 */
export const parseSignupMessage = (event: { origin?: unknown; data?: unknown }): SignupMessage | null => {
  if (!isMetaOrigin(event?.origin)) return null;
  let payload: any = event.data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || payload.type !== 'WA_EMBEDDED_SIGNUP') return null;
  const data = payload.data ?? {};
  const kind = typeof payload.event === 'string' ? payload.event : '';
  // A WhatsApp Business app number (coexistence) is a different onboarding with
  // different rules; it is reported as unsupported, never treated as a success.
  if (kind === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') return { type: 'coexistence', wabaId: text(data.waba_id, META_ID) };
  if (kind === 'FINISH') {
    const wabaId = text(data.waba_id, META_ID);
    const phoneNumberId = text(data.phone_number_id, META_ID);
    if (wabaId && phoneNumberId) return { type: 'finish', wabaId, phoneNumberId, businessId: text(data.business_id, META_ID) };
    return { type: 'finish_without_number', wabaId };
  }
  if (kind === 'FINISH_ONLY_WABA') return { type: 'finish_without_number', wabaId: text(data.waba_id, META_ID) };
  if (kind === 'CANCEL') return { type: 'cancel', currentStep: text(data.current_step, /^[A-Za-z0-9_.:-]{1,60}$/) };
  if (kind === 'ERROR') return { type: 'error', errorId: text(data.error_id, /^[A-Za-z0-9_.:-]{1,60}$/) };
  return null;
};

/** The one-time code from FB.login's response, or null (cancelled, closed, or denied). */
export const codeFromLoginResponse = (response: any): string | null => {
  const code = response?.authResponse?.code;
  return typeof code === 'string' && code.trim() && code.length <= 2048 && !/\s/.test(code) ? code : null;
};

/** What to send the server once the popup has closed. */
export type SignupOutcome =
  | { kind: 'complete'; body: { code: string; wabaId: string; phoneNumberId: string; businessId?: string } }
  | { kind: 'cancel'; body: { currentStep?: string } }
  | { kind: 'error'; body: { errorId?: string } }
  | { kind: 'no_number' }
  | { kind: 'coexistence_unsupported' };

/**
 * Combines the code and the popup's message into one action. Completion needs
 * both a code and a FINISH with a number; a missing code (the window was closed,
 * or permission was refused) is a cancellation, never a success.
 */
export const decideSignupOutcome = (code: string | null, message: SignupMessage | null): SignupOutcome => {
  if (message?.type === 'error') return { kind: 'error', body: message.errorId ? { errorId: message.errorId } : {} };
  if (message?.type === 'finish_without_number') return { kind: 'no_number' };
  if (message?.type === 'coexistence') return { kind: 'coexistence_unsupported' };
  if (message?.type === 'finish' && code) {
    return { kind: 'complete', body: { code, wabaId: message.wabaId, phoneNumberId: message.phoneNumberId, ...(message.businessId ? { businessId: message.businessId } : {}) } };
  }
  return { kind: 'cancel', body: message?.type === 'cancel' && message.currentStep ? { currentStep: message.currentStep } : {} };
};

/**
 * The options FB.login is called with for Embedded Signup - only public ids.
 *
 * Embedded Signup v4 (Meta deprecated v2 and v3 on 15 October 2026): the flow's
 * version and products come from the Facebook Login for Business configuration
 * behind `config_id`, and Meta's v4 sample passes only `extras: { setup: {} }` -
 * no featureType and no sessionInfoVersion. The configuration must be a v4 one.
 */
export const embeddedSignupLoginOptions = (configId: string) => ({
  config_id: configId,
  response_type: 'code',
  override_default_response_type: true,
  extras: { setup: {} },
});

// ── states shown on the page ────────────────────────────────────────────────

export type FlowState = 'idle' | 'starting' | 'authorizing' | 'finishing' | 'registering';

export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';

export const SENDER_STATUS_DISPLAY: Record<string, { label: string; tone: Tone; description: string }> = {
  pending_registration: { label: 'Waiting for registration', tone: 'warning', description: 'Your number was verified with Meta. Finish by registering it with its two-step verification PIN.' },
  registering: { label: 'Registration in progress', tone: 'info', description: 'WhatsApp is registering your number. Check its status in a moment.' },
  connected: { label: 'Connected', tone: 'success', description: 'Your number is registered with WhatsApp Cloud API and connected.' },
  action_required: { label: 'Action required', tone: 'warning', description: 'WhatsApp reports something that must be fixed before this number can send.' },
  disconnected: { label: 'Disconnected', tone: 'error', description: 'This number is disconnected from EventReach. Connect it again to use it.' },
};

export const senderStatusDisplay = (status: string | null | undefined) =>
  (status && SENDER_STATUS_DISPLAY[status]) || { label: 'Status unknown', tone: 'default' as Tone, description: 'EventReach does not know this number\'s state yet.' };

export const FLOW_DISPLAY: Record<FlowState, string> = {
  idle: '',
  starting: 'Preparing a secure connection…',
  authorizing: 'Complete the steps in the Meta window. Keep this page open.',
  finishing: 'Checking your number with Meta…',
  registering: 'Registering your number with WhatsApp…',
};

/** A six-digit PIN, digits only - checked again by the server. */
export const isValidPin = (pin: string) => /^\d{6}$/.test(pin.trim());

/** What the page says about assignment, from the server's reasons. */
export const assignmentNote = (sender: { onboardingStatus?: string | null; assignment?: { available?: boolean; reasons?: string[] } }) => {
  if (sender.assignment?.available) return 'Available for your events.';
  return sender.assignment?.reasons?.[0] ?? 'Not available for events yet.';
};

/** An API error as a sentence. A refusal always says nothing was connected. */
export const onboardingErrorMessage = (error: any): string => {
  const message = error?.response?.data?.error?.message ?? error?.response?.data?.error;
  if (typeof message === 'string' && message) return message;
  if (!error?.response) return 'Could not reach EventReach. Nothing was connected. Check your connection and try again.';
  return 'Something went wrong. Nothing was connected. Please try again.';
};
