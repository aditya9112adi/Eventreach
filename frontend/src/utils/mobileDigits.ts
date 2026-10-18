import { INDIA_MOBILE_DIGITS, normalizeIndianMobile } from '@eventreach/shared';

/**
 * The WhatsApp Number field of the Manual Guest Add form: exactly the 10 digits
 * shown beside IN (+91). The country is fixed, so its code is not typed here.
 *
 * Pure functions, so the rules can be tested without a browser. The field uses
 * them while typing and pasting; the form's submit rule uses validateMobileForSave.
 */

export const MOBILE_TOO_LONG = 'Mobile number cannot exceed 10 digits.';
export const MOBILE_DIGITS_ONLY = 'Enter digits only (0–9).';
export const MOBILE_INCOMPLETE = 'Enter a 10-digit WhatsApp number.';

/**
 * Text as typed: digits only, at most 10. A keystroke that would make 11 digits
 * is refused - the field keeps `previous` - rather than trimmed, because a
 * trimmed value can be a valid-looking wrong number (typing "+91" by hand
 * would otherwise leave "9198765432"). `problem` says what was refused.
 */
export const limitMobileTyping = (text: string, previous = ''): { value: string; problem: string | null } => {
  const digits = text.replace(/\D/g, '');
  if (digits.length > INDIA_MOBILE_DIGITS) return { value: previous, problem: MOBILE_TOO_LONG };
  return { value: digits, problem: digits.length !== text.length ? MOBILE_DIGITS_ONLY : null };
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
