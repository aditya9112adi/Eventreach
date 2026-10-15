/**
 * What to tell the person when adding or editing a guest fails - the logic,
 * free of React so it can be tested without a browser.
 *
 * The server answers every refusal with the text to show in `error` and a
 * machine-readable `code` (see backend/src/utils/contactErrors.ts):
 *   409 CONTACT_DUPLICATE   the number is already in this event's guest list
 *   400 INVALID_PHONE       not a usable Indian mobile number
 *   400 (validation)        a field is missing or too long - the field's message
 *   403                     no access to the event
 * so a refusal is shown exactly as the server worded it - a duplicate is never
 * guessed from anything else, and nothing else is ever reported as a duplicate.
 *
 * What the server did NOT word is not shown: no response at all (offline,
 * timeout, server asleep) and any 5xx are both "try again", with a fixed
 * sentence. A raw server error, a status code or an exception text never
 * reaches the person.
 */

export type ContactAction = 'add' | 'update';

export const CONTACT_FALLBACK_MESSAGE: Record<ContactAction, string> = {
  add: 'Unable to add contact right now. Please try again.',
  update: 'Unable to update contact right now. Please try again.',
};

export const contactErrorMessage = (error: any, action: ContactAction): string => {
  const fallback = CONTACT_FALLBACK_MESSAGE[action];
  const response = error?.response;
  if (!response) return fallback; // no answer: offline, timed out, or unreachable
  const status = response.status;
  if (typeof status !== 'number' || status >= 500) return fallback;
  const message = response.data?.error;
  return typeof message === 'string' && message.trim() ? message : fallback;
};

/** The field a refusal is about, when the server says (so it can be focused or marked). */
export const contactErrorField = (error: any): string | null => {
  const field = error?.response?.data?.field;
  return typeof field === 'string' && field ? field : null;
};
