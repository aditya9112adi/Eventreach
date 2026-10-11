/**
 * The Reports tab's "All Fields" search (?q=), shared by the Event, Access and
 * Contact Reports so the three match a typed value the same way:
 * case-insensitively, anywhere in a field, with surrounding spaces ignored.
 *
 * Only stored fields are searched, plus the event's date and time in the forms
 * the reports print them. Each controller applies the search inside the
 * caller's own authorized scope; nothing here widens what anyone can see.
 */

export const REPORT_SEARCH_MAX_LENGTH = 100;

export class ReportSearchError extends Error {}

/** ?q= as typed, trimmed; null when absent or blank. Throws on a malformed value. */
export const readReportSearch = (raw: unknown): string | null => {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') throw new ReportSearchError('Invalid search.');
  const text = raw.trim();
  if (text.length > REPORT_SEARCH_MAX_LENGTH) throw new ReportSearchError('The search is too long.');
  return text || null;
};

/** Escapes user input before it is used inside a RegExp. */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);

/** A case-insensitive "contains" test, for records filtered in memory. */
export const textMatcher = (text: string) => {
  const needle = text.toLowerCase();
  return (...values: unknown[]): boolean =>
    values.some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(needle));
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A computed string, or '' for a document whose field is not a Date (legacy data). */
const ifDate = (field: string, value: unknown) => ({
  $cond: [{ $eq: [{ $type: field }, 'date'] }, value, ''],
});

/**
 * A MongoDB filter for events matching `text` in any searchable field:
 * Event ID, name, type, venue, organizer, mobile, description, status, the
 * event date (as the reports print it - "31 Oct 2026" - and as 2026-10-31,
 * 31/10/2026 and 31-10-2026) and the event time ("10:00", India time, as
 * shown). Combine it with the caller's own scope; it adds none.
 */
export const eventSearchFilter = (text: string): Record<string, unknown> => {
  const regex = escapeRegex(text);
  const contains = { $regex: regex, $options: 'i' };
  const computed = (input: unknown) => ({ $expr: { $regexMatch: { input, regex, options: 'i' } } });
  const dateAs = (format: string) => ifDate('$eventDate', { $dateToString: { date: '$eventDate', format } });

  return {
    $or: [
      { eventId: contains },
      { eventName: contains },
      { eventType: contains },
      { eventVenue: contains },
      { organizerName: contains },
      { eventDescription: contains },
      { eventStatus: contains },
      // Stored as Int64; matched as the digits shown.
      computed({ $toString: '$organizerMobile' }),
      // eventDate is the calendar day at UTC midnight.
      computed(
        ifDate('$eventDate', {
          $concat: [
            { $dateToString: { date: '$eventDate', format: '%d' } },
            ' ',
            { $arrayElemAt: [MONTHS, { $subtract: [{ $month: '$eventDate' }, 1] }] },
            ' ',
            { $dateToString: { date: '$eventDate', format: '%Y' } },
          ],
        })
      ),
      computed(dateAs('%Y-%m-%d')),
      computed(dateAs('%d/%m/%Y')),
      computed(dateAs('%d-%m-%Y')),
      // eventTime is the full instant; shown as the India-time HH:MM.
      computed(ifDate('$eventTime', { $dateToString: { date: '$eventTime', format: '%H:%M', timezone: '+05:30' } })),
    ],
  };
};
