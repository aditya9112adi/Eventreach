import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { normalizeIndianMobile } from '@eventreach/shared';

/**
 * The authoritative phone rule for this India-only system.
 *
 * Two layers, deliberately:
 *
 *  1. normalizeIndianMobile (shared with the browser) decides the shape —
 *     ten digits beginning 6-9, with an optional +91/91/0 prefix accepted and
 *     collapsed to exactly one. It is what rejects a doubled country code
 *     (+91+91…), a non-Indian number, and anything with letters in it.
 *  2. libphonenumber-js then confirms the result is a real, allocated Indian
 *     mobile range rather than merely ten plausible digits.
 *
 * The browser runs layer 1 for instant feedback; the server runs both, so a
 * caller bypassing the form gains nothing. Every path that accepts a number —
 * the manual form, bulk import, the import preview and the update endpoint —
 * goes through this one function, which is what stops a number being accepted
 * on one route and refused on another.
 */
export type IndianPhone =
  | { ok: true; e164: string }
  | { ok: false; reason: string };

export const normalizeIndianPhone = (raw: unknown): IndianPhone => {
  const shaped = normalizeIndianMobile(raw);
  if (!shaped.ok) return shaped;

  try {
    // Parsed from the already-normalised E.164, so the region is unambiguous.
    const parsed = parsePhoneNumberWithError(shaped.e164);
    if (!parsed.isValid() || parsed.country !== 'IN') {
      return { ok: false, reason: 'This is not a valid Indian mobile number.' };
    }
  } catch {
    return { ok: false, reason: 'This is not a valid Indian mobile number.' };
  }

  return { ok: true, e164: shaped.e164 };
};
