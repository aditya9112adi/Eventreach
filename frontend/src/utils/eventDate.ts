import { z } from 'zod';

/**
 * The Create Event form's date and time rules.
 *
 * A date typed into a browser date field is reported after EVERY digit of the
 * year: typing 2026 gives 0002-MM-DD, 0020-MM-DD, 0202-MM-DD and only then
 * 2026-MM-DD. Each of the first three is, taken at face value, a date in the past.
 * The form therefore never changes the date for the user. A past date is reported
 * as a validation message on the field and left as typed, and the message is
 * worked out only once the year has four plausible digits.
 *
 * Today's date is the user's LOCAL calendar date, worked out by shifting the
 * instant by the local UTC offset - not by reading the UTC date, which is the
 * previous or next day for part of every day outside UTC.
 *
 * Pure functions with the clock and offset passed in, so every boundary can be tested.
 */

export const PAST_DATE_MESSAGE = 'Event Date cannot be in the past';
export const PAST_TIME_MESSAGE = 'Event Time cannot be in the past';
export const PAST_TIME_ADJUSTED_TOAST = 'Past time selected. Automatically adjusted to current time.';

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The local calendar date, YYYY-MM-DD. `offsetMinutes` is Date#getTimezoneOffset() (minutes behind UTC). */
export const localDateString = (now: Date = new Date(), offsetMinutes: number = now.getTimezoneOffset()): string =>
  new Date(now.getTime() - offsetMinutes * 60_000).toISOString().slice(0, 10);

/** The local time of day, HH:MM. */
export const localTimeString = (now: Date = new Date(), offsetMinutes: number = now.getTimezoneOffset()): string =>
  new Date(now.getTime() - offsetMinutes * 60_000).toISOString().slice(11, 16);

/** True only for a well-formed YYYY-MM-DD that is before `today`. Anything else is the format rule's business. */
export const isPastDate = (date: string | undefined, today: string = localDateString()): boolean =>
  typeof date === 'string' && DATE_FORMAT.test(date) && date < today;

/** True when the date is today and the time has already gone by. */
export const isPastTime = (
  date: string | undefined,
  time: string | undefined,
  now: Date = new Date(),
  offsetMinutes: number = now.getTimezoneOffset()
): boolean =>
  typeof date === 'string' && typeof time === 'string' && TIME_FORMAT.test(time) &&
  date === localDateString(now, offsetMinutes) && time < localTimeString(now, offsetMinutes);

/**
 * Whether a date is finished enough to be judged: four digits of year, and a
 * real one. The first three years passed through while typing 2026 (0002, 0020,
 * 0202) are not, so they are never reported as "in the past".
 */
export const isCompleteDate = (value: string | undefined): boolean =>
  typeof value === 'string' && DATE_FORMAT.test(value) && Number(value.slice(0, 4)) >= 1000;

/**
 * The Event Date field: required, YYYY-MM-DD (the format the backend takes), and not
 * in the past. The past-date rule is on the field itself so that its message shows
 * with the other field errors and can be checked as soon as the date is complete.
 */
export const createEventDateField = (today: () => string = localDateString) =>
  z
    .string()
    .min(1, 'Event Date is required')
    .regex(DATE_FORMAT, 'Event Date must be YYYY-MM-DD')
    .refine((value) => !isPastDate(value, today()), { message: PAST_DATE_MESSAGE });

/** The field as the form uses it: "today" is read from the clock each time it validates. */
export const eventDateField = createEventDateField();

/**
 * When the date is today and the chosen time has passed, the time to use instead
 * (the current time); otherwise null. This is the only automatic change the form
 * makes, and it never touches the date.
 */
export const pastTimeAdjustment = (
  selectedDate: string | undefined,
  selectedTime: string | undefined,
  todayStr: string,
  minTime: string | undefined
): string | null =>
  selectedDate === todayStr && selectedTime && minTime && selectedTime < minTime ? minTime : null;
