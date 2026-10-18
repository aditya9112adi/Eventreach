import { INDIA_MOBILE_DIGITS, normalizeIndianMobile } from '@eventreach/shared';

/**
 * The WhatsApp Number field of the Manual Guest Add form: exactly the 10 digits
 * shown beside IN (+91). The country is fixed, so its code is not typed here.
 *
 * Pure functions, so the rules can be tested without a browser. The field uses
 * them while typing and pasting; the form's submit rule uses validateMobileForSave.
 */

export const MOBILE_TOO_LONG = 'Maximum limit reached. Only 10 digits are allowed.';
export const MOBILE_DIGITS_ONLY = 'Enter digits only (0–9).';
export const MOBILE_INCOMPLETE = 'Enter a 10-digit WhatsApp number.';

/**
 * What a keystroke or paste would do to the field. `current` is the field's text,
 * `start`/`end` the selection (equal for a plain caret), `text` what is inserted.
 *
 * Accepted: the text goes in at the selection (replacing it), so editing in the
 * middle works, and `caret` is where the cursor belongs afterwards. Refused:
 * `value` is `current`, unchanged - never cleared or trimmed - and `problem` says
 * why. A paste that is a whole number with +91, 91 or 0 in front replaces an
 * empty or fully selected field with its 10 digits (the IN (+91) label already
 * shows the country); anywhere else a prefix is just digits and may be too many.
 */
export interface MobileEdit {
  accepted: boolean;
  value: string;
  caret: number;
  problem: string | null;
}

export const insertMobileText = (current: string, start: number, end: number, text: string, isPaste = false): MobileEdit => {
  const from = Math.max(0, Math.min(start, end, current.length));
  const to = Math.min(current.length, Math.max(start, end));
  const refuse = (problem: string): MobileEdit => ({ accepted: false, value: current, caret: from, problem });

  if (isPaste && from === 0 && to === current.length) {
    const whole = mobileFromPaste(text);
    if (whole.value !== null) return { accepted: true, value: whole.value, caret: whole.value.length, problem: null };
  }

  const inserted = isPaste ? text.trim().replace(/[\s-]/g, '') : text;
  if (/\D/.test(inserted)) return refuse(MOBILE_DIGITS_ONLY);
  const value = current.slice(0, from) + inserted + current.slice(to);
  if (value.length > INDIA_MOBILE_DIGITS) return refuse(MOBILE_TOO_LONG);
  return { accepted: true, value, caret: from + inserted.length, problem: null };
};

/**
 * The fallback for input the keyboard handler never saw (a phone's on-screen
 * keyboard, drag and drop). `next` is the field after the browser changed it and
 * `caret` its cursor. Too many digits puts `previous` back, with the cursor where
 * it was; other characters are removed from where they landed.
 */
export const limitMobileTyping = (
  next: string,
  previous = '',
  caret = next.length
): { value: string; caret: number; problem: string | null } => {
  const digits = next.replace(/\D/g, '');
  if (digits.length > INDIA_MOBILE_DIGITS) {
    const back = Math.max(0, Math.min(previous.length, caret - (next.length - previous.length)));
    return { value: previous, caret: back, problem: MOBILE_TOO_LONG };
  }
  if (digits.length === next.length) return { value: next, caret: Math.min(caret, next.length), problem: null };
  const removedBeforeCaret = next.slice(0, caret).replace(/\d/g, '').length;
  return { value: digits, caret: Math.max(0, caret - removedBeforeCaret), problem: MOBILE_DIGITS_ONLY };
};

/**
 * Pasted text. A 10-digit number is accepted; so is one with +91, 91 or 0 in
 * front, because the IN (+91) label shows the country. Anything else is refused
 * whole, so no digits are cut off silently. `value` is null when refused.
 */
export const mobileFromPaste = (text: string): { value: string | null; problem: string | null } => {
  const compact = text.trim().replace(/[\s-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return { value: null, problem: MOBILE_DIGITS_ONLY };
  if (/^\d{10}$/.test(compact)) return { value: compact, problem: null };
  const withCode = compact.match(/^(?:\+91|91|0)(\d{10})$/);
  if (withCode) return { value: withCode[1], problem: null };
  const digitCount = compact.replace(/\D/g, '').length;
  return { value: null, problem: digitCount > INDIA_MOBILE_DIGITS ? MOBILE_TOO_LONG : MOBILE_INCOMPLETE };
};

/** The save-time rule: exactly 10 digits, then the shared Indian mobile rule. Returns the message, or null. */
export const validateMobileForSave = (value: string): string | null => {
  if (/^\d{11,}$/.test(value)) return MOBILE_TOO_LONG;
  if (!/^\d{10}$/.test(value)) return MOBILE_INCOMPLETE;
  const result = normalizeIndianMobile(value);
  return result.ok ? null : result.reason;
};

/**
 * The 10 digits to show when a saved guest is opened for editing. A stored
 * +91 number loses its prefix. A number that cannot be read is shown as stored,
 * so saving it is refused with a clear message rather than changed silently.
 */
export const mobileForEdit = (stored: string | null | undefined): string => {
  const result = normalizeIndianMobile(stored);
  return result.ok ? result.e164.slice(-INDIA_MOBILE_DIGITS) : String(stored ?? '');
};
