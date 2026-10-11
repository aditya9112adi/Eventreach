import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  formatEventType,
  EVENT_TYPE_OPTIONS,
  EVENT_TYPE_MAX_LENGTH,
  OTHER_EVENT_TYPE,
  eventTypeFormValues,
  eventTypeIssue,
  matchEventTypeOption,
  refineEventType,
  resolveEventType,
} from './eventType';

test('formatEventType capitalises the stored value for display', async (t) => {
  await t.test('capitalises an all-lowercase value', () => {
    assert.equal(formatEventType('farewell'), 'Farewell');
    assert.equal(formatEventType('party'), 'Party');
    assert.equal(formatEventType('wedding'), 'Wedding');
    assert.equal(formatEventType('birthday'), 'Birthday');
  });

  await t.test('leaves an already-correct value alone', () => {
    assert.equal(formatEventType('Farewell'), 'Farewell');
  });

  await t.test('normalises inconsistent casing', () => {
    assert.equal(formatEventType('FAREWELL'), 'Farewell');
    assert.equal(formatEventType('fArEwElL'), 'Farewell');
  });

  await t.test('trims surrounding whitespace', () => {
    assert.equal(formatEventType('  farewell  '), 'Farewell');
  });

  await t.test('capitalises only the first word of a custom type', () => {
    assert.equal(formatEventType('product launch'), 'Product launch');
    assert.equal(formatEventType('Product Launch'), 'Product launch');
    assert.equal(formatEventType('team OUTING day'), 'Team outing day');
  });

  await t.test('a predefined type reads exactly as its option, whatever its stored casing', () => {
    assert.equal(formatEventType('birthday party'), 'Birthday Party');
    assert.equal(formatEventType('Corporate event'), 'Corporate Event');
    assert.equal(formatEventType('CORPORATE EVENT'), 'Corporate Event');
    assert.equal(formatEventType('  networking event  '), 'Networking Event');
    for (const option of EVENT_TYPE_OPTIONS) assert.equal(formatEventType(option), option, option);
  });

  await t.test('predefined and custom types each collapse to one filter option, and stay idempotent', () => {
    const corporate = new Set(['corporate event', 'Corporate Event', 'CORPORATE EVENT', ' Corporate event '].map(formatEventType));
    assert.deepEqual([...corporate], ['Corporate Event']);
    const custom = new Set(['product launch', 'Product Launch', 'PRODUCT LAUNCH'].map(formatEventType));
    assert.deepEqual([...custom], ['Product launch']);
    for (const value of ['Corporate Event', 'Product launch', 'Other', 'Party']) {
      assert.equal(formatEventType(formatEventType(value)), formatEventType(value), value);
    }
  });

  await t.test('a type stored as the word "Other" still reads "Other"', () => {
    assert.equal(formatEventType('other'), 'Other');
    assert.equal(formatEventType('Other'), 'Other');
  });

  await t.test('is idempotent, so it can double as a comparison key', () => {
    const once = formatEventType('FAREWELL');
    assert.equal(formatEventType(once), once);
  });

  await t.test('collapses values that differ only in casing or padding', () => {
    const variants = ['farewell', 'Farewell', 'FAREWELL', 'fArEwElL', ' farewell '];
    const unique = new Set(variants.map(formatEventType));
    assert.deepEqual([...unique], ['Farewell']);
  });

  await t.test('returns an empty string for a missing value', () => {
    assert.equal(formatEventType(undefined), '');
    assert.equal(formatEventType(null), '');
    assert.equal(formatEventType(''), '');
    assert.equal(formatEventType('   '), '');
  });

  await t.test('does not throw on a non-string value', () => {
    assert.equal(formatEventType(42 as unknown as string), '');
  });
});

// ─── The Event Type field of the event forms ─────────────────────────────────

test('the Event Type options', async (t) => {
  await t.test('are the agreed list, in order, ending with Other', () => {
    assert.deepEqual([...EVENT_TYPE_OPTIONS], [
      'Wedding', 'Birthday Party', 'Anniversary', 'Engagement', 'Baby Shower', 'Corporate Event',
      'Conference', 'Seminar', 'Workshop', 'Webinar', 'Concert', 'Festival', 'Graduation',
      'Sports Event', 'Religious Event', 'Networking Event', 'Farewell', 'Charity Event', 'Other',
    ]);
    assert.equal(OTHER_EVENT_TYPE, 'Other');
  });

  await t.test('every option fits the stored 20-character limit', () => {
    assert.equal(EVENT_TYPE_MAX_LENGTH, 20);
    for (const option of EVENT_TYPE_OPTIONS) assert.ok(option.length <= EVENT_TYPE_MAX_LENGTH, option);
  });

  await t.test('no two options differ only in casing', () => {
    assert.equal(new Set(EVENT_TYPE_OPTIONS.map((o) => o.toLowerCase())).size, EVENT_TYPE_OPTIONS.length);
  });
});

test('a stored type selects its option, or Other with the type written in', async (t) => {
  await t.test('a predefined type selects that option', () => {
    assert.deepEqual(eventTypeFormValues('Wedding'), { eventType: 'Wedding', customEventType: '' });
    assert.deepEqual(eventTypeFormValues('Corporate Event'), { eventType: 'Corporate Event', customEventType: '' });
  });

  await t.test('an existing record in other casing still selects its option', () => {
    assert.equal(matchEventTypeOption(' wedding '), 'Wedding');
    assert.equal(matchEventTypeOption('BIRTHDAY PARTY'), 'Birthday Party');
    assert.deepEqual(eventTypeFormValues('farewell'), { eventType: 'Farewell', customEventType: '' });
  });

  await t.test('a custom type selects Other and fills the box with it', () => {
    assert.deepEqual(eventTypeFormValues('Product Launch'), { eventType: 'Other', customEventType: 'Product Launch' });
    assert.deepEqual(eventTypeFormValues('Party'), { eventType: 'Other', customEventType: 'Party' });
  });

  await t.test('a type stored as the word "Other" is shown as a custom value, kept unless replaced', () => {
    assert.equal(matchEventTypeOption('Other'), null);
    assert.deepEqual(eventTypeFormValues('Other'), { eventType: 'Other', customEventType: 'Other' });
  });

  await t.test('no type yet: nothing is selected', () => {
    for (const empty of [undefined, null, '', '   ']) {
      assert.deepEqual(eventTypeFormValues(empty), { eventType: '', customEventType: '' });
    }
  });
});

test('validation of the Event Type fields', async (t) => {
  await t.test('a choice is required', () => {
    assert.deepEqual(eventTypeIssue('', ''), { path: 'eventType', message: 'Event Type is required' });
    assert.deepEqual(eventTypeIssue(undefined, undefined), { path: 'eventType', message: 'Event Type is required' });
  });

  await t.test('only a listed choice is accepted from the dropdown', () => {
    assert.equal(eventTypeIssue('Hackathon', '')?.path, 'eventType');
  });

  await t.test('a predefined choice needs nothing else - leftover text in the hidden box is ignored', () => {
    assert.equal(eventTypeIssue('Wedding', ''), null);
    assert.equal(eventTypeIssue('Wedding', 'x'.repeat(40)), null);
  });

  await t.test('Other needs a type: empty and whitespace-only are refused', () => {
    assert.deepEqual(eventTypeIssue('Other', ''), { path: 'customEventType', message: 'Specify the Event Type' });
    assert.deepEqual(eventTypeIssue('Other', '    '), { path: 'customEventType', message: 'Specify the Event Type' });
    assert.deepEqual(eventTypeIssue('Other', undefined), { path: 'customEventType', message: 'Specify the Event Type' });
  });

  await t.test('the 20-character limit applies to the specified type, after trimming', () => {
    assert.equal(eventTypeIssue('Other', 'x'.repeat(20)), null);
    assert.equal(eventTypeIssue('Other', `  ${'x'.repeat(20)}  `), null);
    assert.deepEqual(eventTypeIssue('Other', 'x'.repeat(21)), { path: 'customEventType', message: 'Event Type max 20 characters' });
    assert.equal(eventTypeIssue('Other', 'Product Launch'), null);
  });

  await t.test('in a form schema, the rule reports alongside the other fields’ errors', () => {
    // Composed the way EventCreate and EventEdit compose theirs.
    const schema = z.object({
      eventName: z.string().min(1, 'Event Name is required'),
      eventType: z.string(),
      customEventType: z.string().optional(),
    }).superRefine(refineEventType);

    const bad = schema.safeParse({ eventName: '', eventType: 'Other', customEventType: '  ' });
    assert.equal(bad.success, false);
    const issues = bad.success ? [] : bad.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    assert.deepEqual(issues.sort(), ['customEventType: Specify the Event Type', 'eventName: Event Name is required']);

    assert.equal(schema.safeParse({ eventName: 'Launch', eventType: 'Other', customEventType: 'Product Launch' }).success, true);
    assert.equal(schema.safeParse({ eventName: 'Party', eventType: 'Birthday Party', customEventType: '' }).success, true);
    assert.equal(schema.safeParse({ eventName: 'Party', eventType: '' }).success, false);
  });
});

test('the eventType that is saved', async (t) => {
  await t.test('a predefined choice saves its wording', () => {
    assert.equal(resolveEventType('Corporate Event', ''), 'Corporate Event');
  });

  await t.test('Other saves the specified type, trimmed - never the word "Other"', () => {
    assert.equal(resolveEventType('Other', '  Product Launch  '), 'Product Launch');
    assert.notEqual(resolveEventType('Other', 'Product Launch'), 'Other');
  });

  await t.test('switching away from Other saves the option; the typed text is not saved', () => {
    assert.equal(resolveEventType('Wedding', 'Product Launch'), 'Wedding');
  });

  await t.test('editing: an unchanged type is saved exactly as stored', () => {
    assert.equal(resolveEventType('Wedding', '', 'wedding'), 'wedding', 'no silent rewrite of casing');
    assert.equal(resolveEventType('Wedding', '', 'Wedding'), 'Wedding');
    const custom = eventTypeFormValues('Product Launch');
    assert.equal(resolveEventType(custom.eventType, custom.customEventType, 'Product Launch'), 'Product Launch');
  });

  await t.test('editing: a changed type saves the new one', () => {
    assert.equal(resolveEventType('Conference', '', 'wedding'), 'Conference');
    assert.equal(resolveEventType('Other', 'Product Launch', 'Wedding'), 'Product Launch');
    assert.equal(resolveEventType('Seminar', 'Product Launch', 'Product Launch'), 'Seminar');
  });
});
