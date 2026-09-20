/**
 * Turns an event and ONE of its contacts into the positional variables of an
 * approved WhatsApp message template.
 *
 * Deliberately pure and free of Express/Mongoose types: the caller loads the
 * documents and applies the authorization rules, this module only decides what
 * text goes into {{1}}, {{2}}, … so the mapping can be unit tested on plain
 * objects.
 *
 * The values are always derived here from the stored event and contact — never
 * taken from the request body — so a client cannot make the message say
 * something the event does not.
 */

/**
 * A failure that belongs to this flow rather than to Meta: unknown template,
 * event not found, contact not in the event, and so on.
 *
 * Separate from WhatsAppTemplateError on purpose. That error's category union
 * is part of the already-working /test-template contract; widening it here
 * would change an endpoint this task must leave alone. Both types answer with
 * the same { success, error: { code, message } } body.
 */
export class EventTemplateError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly field?: string;

  constructor(code: string, message: string, httpStatus: number, field?: string) {
    super(message);
    this.name = 'EventTemplateError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.field = field;
  }

  toResponse() {
    return {
      success: false as const,
      error: {
        code: this.code,
        message: this.message,
        ...(this.field ? { field: this.field } : {}),
      },
    };
  }
}

export interface EventTemplateSpec {
  /** The language the template was approved in. */
  languageCode: string;
  /** Named sources for {{1}}, {{2}}, … in order. */
  fields: readonly string[];
}

/**
 * Templates this flow may send. An approved template that is not listed here
 * cannot be triggered from the Campaign Composer even if its name is posted,
 * because the variables have to be derived from real fields to be meaningful.
 */
export const EVENT_TEMPLATES: Record<string, EventTemplateSpec> = {
  event_reminder: {
    languageCode: 'en',
    fields: ['recipientName', 'eventName', 'eventDate', 'eventTime', 'eventVenue'],
  },
};

export const resolveEventTemplate = (templateName: unknown): { name: string; spec: EventTemplateSpec } => {
  const name = typeof templateName === 'string' ? templateName.trim() : '';
  if (!name) {
    throw new EventTemplateError('VALIDATION_ERROR', 'Template name is required.', 400, 'templateName');
  }
  const spec = EVENT_TEMPLATES[name];
  if (!spec) {
    throw new EventTemplateError(
      'UNKNOWN_TEMPLATE',
      `"${name}" is not a template this page can send. Available: ${Object.keys(EVENT_TEMPLATES).join(', ')}.`,
      400,
      'templateName'
    );
  }
  return { name, spec };
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * eventTime is stored as the complete event instant in India Standard Time, so
 * the wall-clock time is read the same way the events API serializes it:
 * shift by the offset, then read the UTC time-of-day back off the result.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const twelveHour = (hours: number, minutes: number): string => {
  const suffix = hours < 12 ? 'AM' : 'PM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
};

/**
 * "25 September 2026".
 *
 * eventDate is UTC midnight of the chosen calendar day, so its UTC parts are
 * the day the user picked — shifting it to IST here would move it a day.
 * Documents predating the hardening migration may still hold "YYYY-MM-DD".
 */
export const formatEventDate = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]} ${value.getUTCFullYear()}`;
  }
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (match) {
      const [, year, month, day] = match;
      return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
    }
    return value.trim();
  }
  return '';
};

/** "7:00 PM", from the IST instant (or from a legacy "HH:MM" string). */
export const formatEventTime = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const ist = new Date(value.getTime() + IST_OFFSET_MS);
    return twelveHour(ist.getUTCHours(), ist.getUTCMinutes());
  }
  if (typeof value === 'string') {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match) return twelveHour(Number(match[1]), Number(match[2]));
    return value.trim();
  }
  return '';
};

export interface EventLike {
  eventName?: unknown;
  eventDate?: unknown;
  eventTime?: unknown;
  eventVenue?: unknown;
}

export interface ContactLike {
  fullName?: unknown;
  phoneNumber?: unknown;
}

export interface TemplateVariable {
  /** 1-based: matches {{1}} in the approved template. */
  index: number;
  /** Where the value came from, for the preview. */
  field: string;
  value: string;
}

/**
 * Meta rejects template parameters containing new lines, tabs or five or more
 * consecutive spaces (error 132018). Stored names and venues are free text, so
 * whitespace is collapsed before it can cause a rejected send.
 */
const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export const buildEventTemplateVariables = (
  templateName: string,
  event: EventLike,
  contact: ContactLike
): TemplateVariable[] => {
  const { spec } = resolveEventTemplate(templateName);

  const sources: Record<string, string> = {
    recipientName: clean(contact.fullName),
    eventName: clean(event.eventName),
    eventDate: clean(formatEventDate(event.eventDate)),
    eventTime: clean(formatEventTime(event.eventTime)),
    eventVenue: clean(event.eventVenue),
  };

  return spec.fields.map((field, i) => {
    const value = sources[field];
    if (!value) {
      throw new EventTemplateError(
        'INCOMPLETE_EVENT_DATA',
        `Cannot build the message: ${field} is missing from the selected event or guest.`,
        400,
        field
      );
    }
    return { index: i + 1, field, value };
  });
};
