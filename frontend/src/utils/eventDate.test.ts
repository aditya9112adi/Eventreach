/**
 * The Create Event form's Event Date: a date the user types or picks is kept exactly,
 * a past date is a message and not a replacement, and no date change shows a warning twice.
 *
 * The page's behaviour is replayed from the values a browser date field really emits. Those
 * were recorded in Chromium: typing 10/20/2026 reports 0002-10-20, 0020-10-20, 0202-10-20 and
 * only then 2026-10-20 (an input and a change event each time). There is no DOM test runner here,
 * so how the page uses the helpers is checked in its source, as the other component tests do.
 *
 * Run: npx tsx --test frontend/src/utils/eventDate.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  PAST_DATE_MESSAGE,
  PAST_TIME_ADJUSTED_TOAST,
  PAST_TIME_MESSAGE,
  createEventDateField,
  eventDateField,
  isCompleteDate,
  isPastDate,
  isPastTime,
  localDateString,
  localTimeString,
  pastTimeAdjustment,
} from './eventDate.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

// "Now" for these tests: 2026-10-20 10:30 in India (UTC+5:30, offset -330), i.e. 05:00 UTC.
const NOW = new Date('2026-10-20T05:00:00Z');
const IST = -330;
const TODAY = '2026-10-20';

/** What the browser reports while a year is typed, digit by digit (recorded in Chromium). */
const typedYear = (monthDay: string, year: string): string[] =>
  [...year].map((_, i) => `${year.slice(0, i + 1).padStart(4, '0')}-${monthDay}`);

/** The field's verdict on a date, with "today" fixed so the sequences below do not depend on the real date. */
const fieldAt = createEventDateField(() => TODAY);
const message = (date: string, field = fieldAt): string | null => {
  const r = field.safeParse(date);
  return r.success ? null : r.error.issues[0].message;
};

interface Page { date: string; time: string; toasts: string[]; messages: (string | null)[] }
const start = (time = '10:00'): Page => ({ date: '', time, toasts: [], messages: [] });

/** The page after the fix: the only automatic change is to a past TIME; the date is never touched. */
const runFixed = (emitted: string[], page: Page = start(), now = NOW, offset = IST): Page => {
  for (const value of emitted) {
    page.date = value;
    for (let pass = 0; pass < 4; pass++) {
      const todayStr = localDateString(now, offset);
      const minTime = page.date === todayStr ? localTimeString(now, offset) : undefined;
      const adjusted = pastTimeAdjustment(page.date, page.time, todayStr, minTime);
      if (!adjusted) break;
      page.time = adjusted;
      page.toasts.push(PAST_TIME_ADJUSTED_TOAST);
    }
    page.messages.push(isCompleteDate(value) ? message(value) : null);
  }
  return page;
};

/** The page before the fix, as it was: any date before today is replaced by today, with a toast. */
const LEGACY_TOAST = 'Past date selected. Automatically adjusted to today.';
const runLegacy = (emitted: string[], page: Page = start(), now = NOW, offset = IST): Page => {
  for (const value of emitted) {
    page.date = value;
    for (let pass = 0; pass < 4; pass++) {
      const todayStr = localDateString(now, offset);
      const minTime = page.date === todayStr ? localTimeString(now, offset) : undefined;
      if (page.date === todayStr && page.time && minTime && page.time < minTime) {
        page.time = minTime;
        page.toasts.push(PAST_TIME_ADJUSTED_TOAST);
      } else if (page.date && page.date < todayStr) {
        page.date = todayStr;
        page.toasts.push(LEGACY_TOAST);
      } else break;
    }
  }
  return page;
};

describe('the original problem, reproduced', () => {
  test('typing a year passes through years that look like the past', () => {
    assert.deepEqual(typedYear('10-20', '2026'), ['0002-10-20', '0020-10-20', '0202-10-20', '2026-10-20']);
    assert.ok(typedYear('12-25', '2027').slice(0, 3).every((v) => isPastDate(v, TODAY)), 'each intermediate year is "before today"');
  });

  test('the old behaviour: one warning per digit, and the date the user typed is lost', () => {
    const page = runLegacy(typedYear('12-25', '2026'));
    assert.equal(page.toasts.filter((t) => t === LEGACY_TOAST).length, 3, 'the same warning three times');
    assert.ok(page.toasts.length >= 3);
    // After the first replacement the field shows today, not the date being typed.
    assert.equal(runLegacy(['0002-12-25']).date, TODAY);
  });

  test('the same typing now keeps the date, with no warning at all', () => {
    const page = runFixed(typedYear('12-25', '2026'));
    assert.equal(page.date, '2026-12-25');
    assert.deepEqual(page.toasts, []);
    assert.deepEqual(page.messages, [null, null, null, null], 'and no message while the year is incomplete, nor once it is valid');
  });
});

describe('a valid date is kept exactly', () => {
  const upcoming = ['2026-10-21', '2026-12-25', '2027-02-28', '2028-02-29', '2026-12-31', '2027-01-01', '2099-06-15'];

  test('typed by hand, each date is preserved exactly with no warning or message', () => {
    for (const date of upcoming) {
      const page = runFixed(typedYear(date.slice(5), date.slice(0, 4)));
      assert.equal(page.date, date, date);
      assert.deepEqual(page.toasts, [], date);
      assert.equal(page.messages[page.messages.length - 1], null, date);
    }
  });

  test('picked from the calendar (one complete value in a single change), it is preserved exactly', () => {
    for (const date of upcoming) {
      const page = runFixed([date]);
      assert.equal(page.date, date);
      assert.deepEqual(page.toasts, []);
      assert.deepEqual(page.messages, [null]);
    }
  });

  test('today itself is acceptable', () => {
    assert.equal(isPastDate(TODAY, localDateString(NOW, IST)), false);
    assert.equal(message(TODAY), null);
    assert.equal(message(localDateString(), eventDateField), null, 'with the real clock: the real today');
  });

  test('the field accepts the value unchanged: what is typed is what the form holds', () => {
    for (const date of upcoming) {
      const parsed = fieldAt.safeParse(date);
      assert.equal(parsed.success && parsed.data, date);
    }
  });
});

describe('editing the segments of a date', () => {
  test('editing the year of an existing date: nothing resets, and the end result is the typed date', () => {
    const page = runFixed(typedYear('12-25', '2027'), (() => { const p = start(); p.date = '2026-12-25'; return p; })());
    assert.equal(page.date, '2027-12-25');
    assert.deepEqual(page.toasts, []);
    assert.deepEqual(page.messages, [null, null, null, null]);
  });

  test('editing the month or the day passes through other dates, and none is replaced', () => {
    for (const sequence of [['2026-01-25', '2026-12-25'], ['2026-12-02', '2026-12-25'], ['2026-12-25', '2026-11-25', '2026-11-05']]) {
      const page = runFixed(sequence);
      assert.equal(page.date, sequence[sequence.length - 1]);
      assert.deepEqual(page.toasts, []);
    }
  });

  test('a past date reached part-way through an edit is reported on the field and left as typed', () => {
    const page = runFixed(['2026-01-25']);
    assert.equal(page.date, '2026-01-25', 'not replaced with today');
    assert.deepEqual(page.toasts, []);
    assert.deepEqual(page.messages, [PAST_DATE_MESSAGE]);
  });

  test('picking a good date after a bad one clears the problem', () => {
    const page = runFixed(['2026-01-25', '2026-12-25']);
    assert.deepEqual(page.messages, [PAST_DATE_MESSAGE, null]);
    assert.equal(page.date, '2026-12-25');
  });

  test('an emptied field (a segment cleared) is the required-field rule, not a past date', () => {
    assert.equal(isPastDate('', TODAY), false);
    assert.equal(isCompleteDate(''), false);
    assert.equal(message(''), 'Event Date is required');
    assert.equal(runFixed(['2026-12-25', '']).date, '');
  });
});

describe('a past date', () => {
  test('is a single validation message, and the date stays as the user typed it', () => {
    const page = runFixed(typedYear('03-15', '2024'));
    assert.equal(page.date, '2024-03-15');
    assert.deepEqual(page.toasts, [], 'no notification at all');
    assert.deepEqual(page.messages, [null, null, null, PAST_DATE_MESSAGE], 'one message, only once the year is complete');
    assert.equal(PAST_DATE_MESSAGE, 'Event Date cannot be in the past');
  });

  test('the same rule is applied when the form is submitted, against the real clock', () => {
    assert.equal(message('2000-01-01', eventDateField), PAST_DATE_MESSAGE);
    assert.equal(message('2099-01-01', eventDateField), null);
    assert.equal(message('2024-03-15'), PAST_DATE_MESSAGE);
  });

  test('yesterday is past and today is not, at the boundary', () => {
    const today = localDateString(NOW, IST);
    assert.equal(isPastDate('2026-10-19', today), true);
    assert.equal(isPastDate('2026-10-20', today), false);
    assert.equal(isPastDate('2026-10-21', today), false);
  });

  test('a malformed date is the format rule, not reported twice', () => {
    for (const bad of ['12/25/2026', '2026-1-5', 'tomorrow', '26-12-25']) {
      assert.equal(isPastDate(bad, TODAY), false, bad);
      assert.equal(message(bad), 'Event Date must be YYYY-MM-DD', bad);
    }
  });

  test('only a complete year is judged', () => {
    for (const early of ['0002-10-20', '0020-10-20', '0202-10-20', '0999-01-01']) assert.equal(isCompleteDate(early), false, early);
    for (const done of ['1000-01-01', '2026-10-20', '2099-12-31']) assert.equal(isCompleteDate(done), true, done);
    assert.equal(isCompleteDate(undefined), false);
  });
});

describe('notifications are not repeated', () => {
  test('no date change at all produces a notification, however many digits it takes', () => {
    for (const sequence of [typedYear('12-25', '2026'), typedYear('03-15', '2024'), ['2026-01-25', '2026-12-25'], ['2030-05-05']]) {
      assert.deepEqual(runFixed(sequence).toasts, [], sequence.join(','));
    }
  });

  test('the one automatic change left - a time that has passed today - is announced exactly once', () => {
    const page = runFixed([TODAY], start('08:00'));
    assert.equal(page.time, localTimeString(NOW, IST), 'moved to the current time');
    assert.deepEqual(page.toasts, [PAST_TIME_ADJUSTED_TOAST], 'one notification');
    // Running the effect again with the adjusted time changes nothing and says nothing.
    assert.equal(pastTimeAdjustment(TODAY, page.time, TODAY, localTimeString(NOW, IST)), null);
  });

  test('a time that has not passed, or another day, is left alone', () => {
    assert.deepEqual(runFixed([TODAY], start('18:00')).toasts, []);
    assert.deepEqual(runFixed(['2026-10-21'], start('08:00')).toasts, []);
    assert.equal(pastTimeAdjustment('2026-10-21', '08:00', TODAY, undefined), null);
  });

  test('the time rule itself is unchanged', () => {
    assert.equal(isPastTime(TODAY, '08:00', NOW, IST), true);
    assert.equal(isPastTime(TODAY, '10:30', NOW, IST), false, 'the current minute is not past');
    assert.equal(isPastTime(TODAY, '23:59', NOW, IST), false);
    assert.equal(isPastTime('2026-10-21', '00:00', NOW, IST), false);
    assert.equal(PAST_TIME_MESSAGE, 'Event Time cannot be in the past');
  });
});

describe('dates stay correct across timezone boundaries', () => {
  // The same instant is a different calendar day in different zones.
  const cases: [string, string, number, string, string][] = [
    // [instant (UTC),        label,      offset,  local date,    local time]
    ['2026-10-20T19:30:00Z', 'India (UTC+5:30), already the next day', -330, '2026-10-21', '01:00'],
    ['2026-10-20T05:00:00Z', 'Baker Island (UTC-12), still the day before', 720, '2026-10-19', '17:00'],
    ['2026-10-20T10:30:00Z', 'Line Islands (UTC+14)', -840, '2026-10-21', '00:30'],
    ['2026-10-20T23:59:00Z', 'UTC', 0, '2026-10-20', '23:59'],
    ['2026-10-20T00:00:00Z', 'Los Angeles (UTC-7)', 420, '2026-10-19', '17:00'],
    ['2026-12-31T20:00:00Z', 'India, across New Year', -330, '2027-01-01', '01:30'],
  ];

  for (const [instant, label, offset, date, time] of cases) {
    test(`${label}: the local date is ${date}, not the UTC date`, () => {
      const at = new Date(instant);
      assert.equal(localDateString(at, offset), date);
      assert.equal(localTimeString(at, offset), time);
    });
  }

  test('reading the UTC date instead would be a day out in those zones (what the offset shift avoids)', () => {
    const at = new Date('2026-10-20T19:30:00Z');
    assert.equal(at.toISOString().slice(0, 10), '2026-10-20');
    assert.equal(localDateString(at, -330), '2026-10-21');
  });

  test("the picked date is judged against the user's own today at the boundary", () => {
    const at = new Date('2026-10-20T19:30:00Z'); // 21 Oct 01:00 in India
    const today = localDateString(at, -330);
    assert.equal(isPastDate('2026-10-20', today), true, "20 Oct has already gone by in the user's zone");
    assert.equal(isPastDate('2026-10-21', today), false, "21 Oct is the user's today");
    const west = new Date('2026-10-20T05:00:00Z'); // 19 Oct 17:00 at UTC-12
    assert.equal(isPastDate('2026-10-19', localDateString(west, 720)), false, "19 Oct is still the user's today");
    assert.equal(isPastDate('2026-10-18', localDateString(west, 720)), true);
  });

  test('the date a user picks is carried as plain text, with no conversion to a Date that could shift it', () => {
    for (const date of ['2026-12-31', '2027-01-01', '2028-02-29', '2027-03-28', '2026-10-25']) {
      const parsed = fieldAt.safeParse(date);
      assert.equal(parsed.success && parsed.data, date);
    }
  });
});

describe('what the form submits', () => {
  const create = read('frontend/src/pages/Events/EventCreate.tsx');
  const server = read('backend/src/controllers/eventController.ts');

  test('the date goes to the backend exactly as chosen: YYYY-MM-DD, with no transformation', () => {
    assert.ok(create.includes('const { customEventType, ...fields } = form;'));
    assert.ok(create.includes('const data = { ...fields, eventType: resolveEventType(form.eventType, customEventType) };'));
    const form = { eventDate: '2026-12-25', eventTime: '18:30', customEventType: '', eventType: 'Wedding' };
    const { customEventType, ...fields } = form;
    void customEventType;
    assert.equal(({ ...fields }).eventDate, '2026-12-25');
    assert.equal(/eventDate\s*:\s*[^e\n]*(new Date|toISOString|getTime|Date\.UTC)/.test(create), false);
  });

  test("the format is the one the server accepts, and the server still enforces the same rule", () => {
    assert.ok(server.includes("eventDate:        z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/, 'Event Date must be YYYY-MM-DD')"));
    assert.ok(server.includes("'Event Date cannot be in the past'"));
    assert.equal(fieldAt.safeParse('2026-12-25').success, true);
    assert.equal(fieldAt.safeParse('25-12-2026').success, false);
  });

  test('the field still requires a date and keeps its format message', () => {
    assert.equal(message(''), 'Event Date is required');
    assert.equal(message('nope'), 'Event Date must be YYYY-MM-DD');
  });
});

describe('how the Create Event page uses it', () => {
  const create = read('frontend/src/pages/Events/EventCreate.tsx');

  test('the date is never replaced and the old warning is gone', () => {
    assert.equal(create.includes("setValue('eventDate'"), false);
    assert.equal(create.includes('Past date selected'), false);
    assert.equal(create.includes('Automatically adjusted to today'), false);
  });

  test('the only automatic change is to a past time, through the tested helper', () => {
    assert.ok(create.includes('const adjusted = pastTimeAdjustment(selectedDate, selectedTime, todayStr, minTime);'));
    assert.ok(create.includes("setValue('eventTime', adjusted, { shouldValidate: true });"));
    assert.ok(create.includes('showToast(\'warning\', PAST_TIME_ADJUSTED_TOAST);'));
    assert.equal((create.match(/showToast\(/g) ?? []).length, 1, 'the time toast is the only notification the page raises for a date or time');
  });

  test('a complete date is checked at once, as a message on the field and not a notification', () => {
    assert.ok(create.includes("if (isCompleteDate(selectedDate)) void trigger('eventDate');"));
    assert.ok(create.includes('eventDate:        eventDateField,'));
    assert.ok(create.includes('error={errors.eventDate?.message}'));
  });

  test("today's date and time come from the offset-aware helpers", () => {
    assert.ok(create.includes('const todayStr = localDateString(now);'));
    assert.ok(create.includes('minTime = localTimeString(now);'));
    assert.equal(create.includes('toISOString().split'), false);
  });

  test('the date input itself is unchanged: a date field with today as its minimum', () => {
    assert.ok(create.includes('label="Event Date"\n              type="date"\n              min={todayStr}\n              {...register(\'eventDate\')}'));
  });

  test('the Edit Event form and the other date fields are untouched by this change', () => {
    const edit = read('frontend/src/pages/Events/EventEdit.tsx');
    assert.equal(edit.includes('utils/eventDate'), false);
    const contacts = read('frontend/src/pages/Contacts/ContactList.tsx');
    assert.equal(contacts.includes('utils/eventDate'), false);
  });
});
