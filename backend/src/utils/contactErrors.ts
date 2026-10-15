/**
 * The errors the guest add / edit endpoints answer with.
 *
 * Every one carries a machine-readable `code` next to the human `error` text
 * (the field the client has always read), so the page can tell "this number is
 * already in the list" from "that is not a number" from "the server failed"
 * without guessing from wording. Nothing here carries an exception message, a
 * database detail or another guest's data.
 *
 * Uniqueness is per event and on the normalised number: the database has a
 * unique index on (eventId, phoneNumber), where phoneNumber is E.164
 * ("+919112472833"), so "9112472833", "+91 91124 72833" and "919112472833" are
 * the same guest. Email is NOT unique - two guests may share one - so there is
 * deliberately no duplicate-email error. There is also no limit on how many
 * guests an event may hold, so there is no limit error.
 */

export const CONTACT_ERROR = {
  duplicate: {
    code: 'CONTACT_DUPLICATE',
    status: 409,
    message: "This contact already exists in this event's guest list.",
  },
  invalidPhone: {
    code: 'INVALID_PHONE',
    status: 400,
    message: 'Please enter a valid WhatsApp number.',
  },
  addFailed: {
    code: 'CONTACT_SAVE_FAILED',
    status: 500,
    message: 'Unable to add contact right now. Please try again.',
  },
  updateFailed: {
    code: 'CONTACT_SAVE_FAILED',
    status: 500,
    message: 'Unable to update contact right now. Please try again.',
  },
} as const;

type ContactErrorKind = (typeof CONTACT_ERROR)[keyof typeof CONTACT_ERROR];

export const contactErrorBody = (kind: ContactErrorKind, extra: { field?: string; detail?: string } = {}) => ({
  error: kind.message,
  code: kind.code,
  ...(extra.field ? { field: extra.field } : {}),
  ...(extra.detail ? { detail: extra.detail } : {}),
});

/** MongoDB's duplicate-key error: the unique index refused the write. */
export const isDuplicateKeyError = (error: unknown): boolean => (error as any)?.code === 11000;
