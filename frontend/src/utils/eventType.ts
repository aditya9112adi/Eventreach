import { z, type RefinementCtx } from 'zod';
import { EVENT_TYPE_OPTIONS, EVENT_TYPE_MAX_LENGTH, OTHER_EVENT_TYPE } from '@eventreach/shared';

/**
 * Event Type display formatting.
 *
 * eventType is free text (1–20 characters), not an enum, so the database holds
 * whatever casing was typed: "farewell", "Farewell" and "FAREWELL" are all
 * real values in existing records. Normalising at render time makes every
 * screen agree without rewriting stored data.
 *
 * A type that is one of the predefined options (EVENT_TYPE_OPTIONS), in any
 * casing, reads exactly as the option does: "corporate event" and
 * "Corporate Event" both show "Corporate Event", as the dropdown names it.
 *
 * Any other (custom) type has only its first letter capitalised, so a
 * multi-word custom type reads "Product launch". Title-casing every word would
 * have to guess at words that are deliberately lower case, and the stored value
 * is the single source of truth for the wording itself — this only settles the
 * casing.
 *
 * The result is also the comparison key for grouping and filtering: the
 * function is idempotent and depends only on the trimmed, case-folded input, so
 * two records whose types differ solely in casing format to the same string and
 * therefore collapse into one filter option.
 */
export const formatEventType = (value?: string | null): string => {
  // Records predating a required eventType, and rows built from partial API
  // responses, can arrive with this missing — callers apply their own fallback.
  if (typeof value !== 'string') return '';
  const option = matchEventTypeOption(value);
  if (option) return option;
  return value
    .trim()
    .toLowerCase()
    .replace(/^./, (char) => char.toUpperCase());
};

// ─── The Event Type field of the event forms ─────────────────────────────────

/**
 * The forms offer EVENT_TYPE_OPTIONS (shared with the backend's limit); "Other"
 * reveals a "Specify Event Type" box whose text is what gets saved. eventType
 * itself stays free text, so existing custom types keep working unchanged.
 */
export { EVENT_TYPE_OPTIONS, OTHER_EVENT_TYPE, EVENT_TYPE_MAX_LENGTH };

const fold = (value: string) => value.trim().toLowerCase();

/**
 * The predefined option a stored type is, ignoring casing and padding
 * ("wedding" is Wedding), or null. "Other" is never a match: a type stored as
 * the literal word is shown as a custom value, so it can be kept or replaced.
 */
export const matchEventTypeOption = (value?: string | null): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const found = EVENT_TYPE_OPTIONS.find((option) => option !== OTHER_EVENT_TYPE && fold(option) === fold(value));
  return found ?? null;
};

/** The form's two fields for a stored type: its option, or Other with the type written in. */
export const eventTypeFormValues = (stored?: string | null): { eventType: string; customEventType: string } => {
  const option = matchEventTypeOption(stored);
  if (option) return { eventType: option, customEventType: '' };
  const custom = typeof stored === 'string' ? stored.trim() : '';
  return custom ? { eventType: OTHER_EVENT_TYPE, customEventType: custom } : { eventType: '', customEventType: '' };
};

/** What is wrong with the Event Type fields, and on which field, or null. */
export const eventTypeIssue = (
  selected: string | undefined,
  custom: string | undefined
): { path: 'eventType' | 'customEventType'; message: string } | null => {
  if (!selected) return { path: 'eventType', message: 'Event Type is required' };
  if (!(EVENT_TYPE_OPTIONS as readonly string[]).includes(selected)) {
    return { path: 'eventType', message: 'Choose an Event Type from the list' };
  }
  if (selected !== OTHER_EVENT_TYPE) return null;
  const typed = (custom ?? '').trim();
  if (!typed) return { path: 'customEventType', message: 'Specify the Event Type' };
  if (typed.length > EVENT_TYPE_MAX_LENGTH) {
    return { path: 'customEventType', message: `Event Type max ${EVENT_TYPE_MAX_LENGTH} characters` };
  }
  return null;
};

/** For a form schema's superRefine: reports eventTypeIssue on its field. */
export const refineEventType = (
  data: { eventType?: string; customEventType?: string },
  ctx: RefinementCtx
): void => {
  const issue = eventTypeIssue(data.eventType, data.customEventType);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [issue.path] });
};

/**
 * The eventType to save. Other saves the specified type, trimmed - never the
 * word "Other". A predefined option saves its own wording, except that an
 * event whose stored type already is that option ("wedding") keeps its stored
 * value exactly, so editing other fields never rewrites the type.
 */
export const resolveEventType = (selected: string, custom: string | undefined, original?: string | null): string => {
  if (selected === OTHER_EVENT_TYPE) return (custom ?? '').trim();
  if (original && matchEventTypeOption(original) === selected) return original;
  return selected;
};
