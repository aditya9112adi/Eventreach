/**
 * Event-specific WhatsApp templates in the Message tab (Campaign Composer).
 *
 * A template managed under WhatsApp Templates is tied to one event. The Composer
 * offers only the approved ones for the event that is selected - and none without
 * an event; there are no general templates on the page. The server decides: it lists only this event's approved
 * templates, and checks the event, the association and the approval again on
 * every preview and send. Nothing here is a permission.
 *
 * Pure functions, so each rule can be tested without a browser.
 */

export interface EventTemplateOption {
  id: string;
  name: string;
  displayName: string;
  language: string;
  category: string;
  body: string;
  headerText: string | null;
  footer: string | null;
  variableCount: number;
}

/**
 * The Composer keeps its choice in one string: an event template is this prefix and
 * its id; no choice is the empty string. (A template name can only hold lowercase
 * letters, digits and underscores, so a name can never be mistaken for a choice.)
 */
export const EVENT_TEMPLATE_KEY_PREFIX = 'event-template:';

export const eventTemplateKey = (id: string): string => `${EVENT_TEMPLATE_KEY_PREFIX}${id}`;

export const isEventTemplateKey = (key: string): boolean => key.startsWith(EVENT_TEMPLATE_KEY_PREFIX) && key.length > EVENT_TEMPLATE_KEY_PREFIX.length;

export const eventTemplateIdOf = (key: string): string | null => (isEventTemplateKey(key) ? key.slice(EVENT_TEMPLATE_KEY_PREFIX.length) : null);

/** The request fields that choose the template: an id for an event template, the name for a built-in one. Never both. */
export const templateRequestFields = (key: string): { templateId: string } | { templateName: string } => {
  const id = eventTemplateIdOf(key);
  return id ? { templateId: id } : { templateName: key };
};

/**
 * The choice to keep after the event or its template list changed. Only a template
 * among those of the event now selected can stay chosen; anything else - the
 * previous event's template, one no longer approved, or a stray value - goes back to
 * `fallback` (no choice), so another event's template can never remain selected.
 */
export const reconcileTemplateKey = (key: string, options: readonly EventTemplateOption[], fallback: string): string => {
  const id = eventTemplateIdOf(key);
  return id && options.some((o) => o.id === id) ? key : fallback;
};

/** The templates in the server's answer; anything malformed reads as none. */
export const readEventTemplates = (data: unknown): EventTemplateOption[] => {
  const list = (data as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (t): t is EventTemplateOption => Boolean(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.body === 'string'
  );
};

/** One line under the picker for the chosen event template. */
export const describeEventTemplate = (t: EventTemplateOption): string =>
  `${t.displayName} - ${t.category.charAt(0) + t.category.slice(1).toLowerCase()} template, language ${t.language}. ` +
  'Approved by WhatsApp for this event; its wording cannot be edited here.';

/** What to say when no event is selected: nothing is offered without one. */
export const SELECT_EVENT_FOR_TEMPLATES_TEXT = 'Select an event to see its approved templates.';

/** The picker's empty first option, by what is known about the selected event's templates. */
export const templatePlaceholder = (eventId: string, state: 'idle' | 'loading' | 'ready' | 'error', count: number): string => {
  if (!eventId) return 'Select an event first';
  if (state === 'loading') return 'Loading templates...';
  if (state === 'error') return 'Templates could not be loaded';
  return count === 0 ? 'No approved templates for this event' : 'Select a template';
};

/** What to say when an event has no approved template of its own. */
export const NO_EVENT_TEMPLATES_TEXT =
  'No approved template is tied to this event yet. Create one under WhatsApp Templates using this event\'s Event ID, and submit it for approval.';
