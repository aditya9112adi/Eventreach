/**
 * Event Type display formatting.
 *
 * eventType is free text (1–20 characters), not an enum, so the database holds
 * whatever casing was typed: "farewell", "Farewell" and "FAREWELL" are all
 * real values in existing records. Normalising at render time makes every
 * screen agree without rewriting stored data.
 *
 * Only the first letter is capitalised, so a multi-word type reads
 * "Birthday party" rather than "Birthday Party". Title-casing every word would
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
  return value
    .trim()
    .toLowerCase()
    .replace(/^./, (char) => char.toUpperCase());
};
