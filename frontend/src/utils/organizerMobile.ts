import { MOBILE_TOO_LONG, insertMobileText, limitMobileTyping } from './mobileDigits';

/**
 * The Organizer Mobile Number field of the Create Event form: at most 10 digits,
 * and a "limit reached" warning only when the user tries to go past 10 - not
 * merely because the field holds 10.
 *
 * The digit rules (caret, selection, paste, non-digits) are those of the Manual
 * Guest Add field, reused from mobileDigits.ts. What is added here is the
 * warning flag: set by an attempt to add an 11th digit, cleared by any accepted
 * edit (deleting a digit, replacing the number), left alone by a refused
 * non-digit. Pure functions, so the whole behaviour can be tested without a browser.
 */

export interface OrganizerMobileState {
  /** The field's text now. */
  value: string;
  /** True from an attempt to add a digit beyond the limit until the next accepted edit. */
  limitAttempted: boolean;
}

export interface OrganizerMobileResult extends OrganizerMobileState {
  /** Where the cursor belongs afterwards. */
  caret: number;
}

/** The flag after an edit: an over-long attempt sets it, an accepted edit clears it, a refused non-digit leaves it. */
export const nextLimitAttempt = (previous: boolean, problem: string | null): boolean =>
  problem === MOBILE_TOO_LONG ? true : problem === null ? false : previous;

/**
 * A keystroke or paste at the field's selection. `accepted` says whether the
 * browser may go on to insert it; when it is false the field must stay exactly as it is.
 */
export const applyOrganizerMobileInput = (
  state: OrganizerMobileState,
  input: { start: number; end: number; text: string; isPaste?: boolean }
): OrganizerMobileResult & { accepted: boolean } => {
  const edit = insertMobileText(state.value, input.start, input.end, input.text, input.isPaste ?? false);
  return { accepted: edit.accepted, value: edit.value, caret: edit.caret, limitAttempted: nextLimitAttempt(state.limitAttempted, edit.problem) };
};

/**
 * The fallback for input the key handler never saw (a phone's on-screen keyboard):
 * `next` is the field after the browser changed it. Too many digits puts the
 * previous value back; other characters are removed.
 */
export const reconcileOrganizerMobileChange = (state: OrganizerMobileState, next: string, caret: number): OrganizerMobileResult => {
  const typed = limitMobileTyping(next, state.value, caret);
  return { value: typed.value, caret: typed.caret, limitAttempted: nextLimitAttempt(state.limitAttempted, typed.problem) };
};

/**
 * The counter under a field, "n/max". With `limitAttempted` given, "— limit
 * reached" shows only after an attempt to go past the limit (and while the field
 * is full); without it - every other field - it shows whenever the field is full,
 * as before.
 */
export const counterLabel = (length: number, max: number, limitAttempted?: boolean): { text: string; atLimit: boolean } => {
  const atLimit = limitAttempted === undefined ? length >= max : limitAttempted && length >= max;
  return { text: `${length}/${max}${atLimit ? ' — limit reached' : ''}`, atLimit };
};
