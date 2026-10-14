import { EventTemplateError, formatEventDate, formatEventTime, type ContactLike } from './eventTemplateMessage';
import { LIMITS, type VariableSource } from './templateDefinition';

/**
 * Fills a template's placeholders for one guest of one event, from the stored
 * mapping. Values come only from the selected event and that guest - nothing
 * from the request - so one event's details can never reach another's guests.
 */

/** What a blank guest name becomes, so a greeting reads "Dear Guest,". */
export const GUEST_NAME_FALLBACK = 'Guest';

export interface MappedVariable {
  position: number;
  label: string;
  source: VariableSource;
  fixedValue?: string;
  fallback?: string;
}

export interface TemplateEventLike {
  eventName?: unknown;
  eventDate?: unknown;
  eventTime?: unknown;
  eventVenue?: unknown;
  eventType?: unknown;
  organizerName?: unknown;
  eventDescription?: unknown;
}

export interface ResolvedVariable {
  position: number;
  label: string;
  source: VariableSource;
  value: string;
  usedFallback: boolean;
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

const sourceValue = (source: VariableSource, event: TemplateEventLike, contact: ContactLike, fixedValue?: string): string => {
  switch (source) {
    case 'guest.name':
      return clean(contact.fullName);
    case 'event.name':
      return clean(event.eventName);
    case 'event.date':
      return clean(formatEventDate(event.eventDate));
    case 'event.time':
      return clean(formatEventTime(event.eventTime));
    case 'event.venue':
      return clean(event.eventVenue);
    case 'event.type':
      return clean(event.eventType);
    case 'event.organizer':
      return clean(event.organizerName);
    case 'event.description':
      return clean(event.eventDescription);
    case 'fixed':
      return clean(fixedValue);
    default:
      return '';
  }
};

/**
 * One value per placeholder, in {{1}}, {{2}}, … order.
 *
 * An empty source uses the mapping's fallback; a blank guest name always has
 * one ("Guest"). Anything else that is empty stops the send for this guest
 * with the placeholder named - a template is never sent with a gap.
 */
export const resolveTemplateVariables = (
  mapping: readonly MappedVariable[],
  event: TemplateEventLike,
  contact: ContactLike
): ResolvedVariable[] =>
  [...mapping]
    .sort((a, b) => a.position - b.position)
    .map((variable) => {
      const raw = sourceValue(variable.source, event, contact, variable.fixedValue);
      const fallback = clean(variable.fallback) || (variable.source === 'guest.name' ? GUEST_NAME_FALLBACK : '');
      const value = raw || fallback;

      if (!value) {
        throw new EventTemplateError(
          'INCOMPLETE_EVENT_DATA',
          `Cannot build the message: "${variable.label}" ({{${variable.position}}}) has no value for the selected event or guest.`,
          400,
          `variables.${variable.position}`
        );
      }
      if (value.length > LIMITS.variableValue) {
        throw new EventTemplateError(
          'TEMPLATE_PARAMETER_TOO_LONG',
          `"${variable.label}" ({{${variable.position}}}) is longer than ${LIMITS.variableValue} characters.`,
          400,
          `variables.${variable.position}`
        );
      }
      return { position: variable.position, label: variable.label, source: variable.source, value, usedFallback: !raw };
    });
