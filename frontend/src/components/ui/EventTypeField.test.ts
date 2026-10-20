/**
 * The Event Type dropdown in the Create and Edit event forms.
 *
 * Its rules - the options, matching a stored type, validation, the value that
 * is saved - are tested for real in utils/eventType.test.ts, and the API's in
 * tests/eventDbHardening.integration.test.ts. This repo has no DOM test
 * runner, so - as SubEvents.test.ts does - these assertions pin the markup and
 * the wiring: both forms use the same field, the same rules and the same save.
 *
 * Run: npx tsx --test frontend/src/components/ui/EventTypeField.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const field = read('frontend/src/components/ui/EventTypeField.tsx');
const create = read('frontend/src/pages/Events/EventCreate.tsx');
const edit = read('frontend/src/pages/Events/EventEdit.tsx');
const util = read('frontend/src/utils/eventType.ts');

test('the field: a dropdown of the shared options, and a box for Other', async (t) => {
  await t.test('the options come from the one shared list', () => {
    assert.ok(util.includes("import { EVENT_TYPE_OPTIONS, EVENT_TYPE_MAX_LENGTH, OTHER_EVENT_TYPE } from '@eventreach/shared';"));
    assert.ok(field.includes('{EVENT_TYPE_OPTIONS.map((option) => ('));
    assert.equal(/'Wedding'|"Wedding"/.test(field), false, 'no second copy of the list');
  });

  await t.test('nothing is chosen until the user chooses', () => {
    assert.ok(field.includes('<option value="" disabled>\n            Select Event Type\n          </option>'));
  });

  await t.test('"Specify Event Type" appears only for Other, limited to 20 characters', () => {
    assert.ok(field.includes('const isOther = selected === OTHER_EVENT_TYPE;'));
    assert.ok(field.includes('{isOther && ('));
    assert.ok(field.includes('Specify Event Type'));
    assert.ok(field.includes('maxLength={EVENT_TYPE_MAX_LENGTH}'));
  });

  await t.test('switching away from Other hides the typed text but never clears it', () => {
    assert.equal(field.includes('setValue'), false);
    assert.equal(/customEventType['"]?\s*,\s*['"]{2}/.test(create + edit), false, 'neither form blanks it on change');
  });

  await t.test('styled as the forms’ other inputs, with errors under each field', () => {
    assert.ok(field.includes("'w-full rounded-md border bg-surface px-4 py-2.5 text-sm"));
    assert.ok(field.includes('{selectError && <p className="mt-1 text-sm text-red-600">{selectError}</p>}'));
    assert.ok(field.includes('{customError && <p className="mt-1 text-sm text-red-600">{customError}</p>}'));
  });
});

test('every screen shows an event type through formatEventType, so options keep their exact wording', () => {
  const shown: Array<[string, string]> = [
    ['frontend/src/pages/Events/EventList.tsx', '{formatEventType(event.eventType)}'],
    ['frontend/src/pages/Events/EventList.tsx', "matchesType = !filterType || formatEventType(e.eventType) === filterType"],
    ['frontend/src/pages/Events/EventDetail.tsx', '{formatEventType(event.eventType)}'],
    ['frontend/src/pages/Reports.tsx', "{ header: 'Event Type', value: (r) => value(formatEventType(r.eventType), '-'), width: 18 }"],
    ['frontend/src/components/ui/SubEventsSection.tsx', '{formatEventType(sub.eventType)}'],
    ['frontend/src/components/ui/EventSearch.tsx', '{formatEventType(evt.eventType)}'],
  ];
  for (const [file, usage] of shown) assert.ok(read(file).includes(usage), `${file}: ${usage}`);
  assert.ok(util.includes('const option = matchEventTypeOption(value);\n  if (option) return option;'));
});

test('Create and Edit use the same field, rules and save', async (t) => {
  for (const [name, source] of [['EventCreate', create], ['EventEdit', edit]] as const) {
    await t.test(`${name}: the dropdown replaces the free-text input`, () => {
      assert.ok(source.includes('<EventTypeField\n              select={register(\'eventType\')}\n              custom={register(\'customEventType\')}'));
      assert.equal(source.includes('placeholder="e.g. Conference, Webinar, Wedding"'), false);
      assert.equal(source.includes("{...register('eventType')}"), false);
    });

    await t.test(`${name}: validated by the shared rule`, () => {
      assert.ok(source.includes('customEventType:  z.string().optional(),'));
      assert.ok(source.includes('}).superRefine((data, ctx) => {\n  refineEventType(data, ctx);'));
    });

    await t.test(`${name}: saves the resolved type in eventType, and no extra field`, () => {
      assert.ok(source.includes('const { customEventType, ...fields } = form;'));
    });
  }

  await t.test('Create saves the chosen option or the specified type', () => {
    assert.ok(create.includes('const data = { ...fields, eventType: resolveEventType(form.eventType, customEventType) };'));
    assert.ok(create.includes("defaultValues: { eventType: '', customEventType: '' },"));
  });

  await t.test('Edit selects the stored type’s option, or Other with it written in, and keeps an unchanged type as stored', () => {
    assert.ok(edit.includes('...eventTypeFormValues(response.data.eventType),'));
    assert.ok(edit.includes("setStoredEventType(response.data.eventType || '');"));
    assert.ok(edit.includes('const data = { ...fields, eventType: resolveEventType(form.eventType, customEventType, storedEventType) };'));
  });

  await t.test('the other fields and requests are unchanged', () => {
    assert.ok(create.includes(': await api.post(\'/events\', data);'));
    assert.ok(edit.includes('await api.put(`/events/${id}`, data);'));
    for (const source of [create, edit]) {
      for (const f of ['organizerName', 'organizerMobile', 'eventName', 'eventDate', 'eventTime', 'eventVenue', 'eventDescription']) {
        // Create registers its organizer mobile once up front, so the field's own handlers can wrap
        // its onChange (see utils/organizerMobile.ts); every other field, and Edit, are as before.
        const registration = source === create && f === 'organizerMobile'
          ? "const organizerMobileField = register('organizerMobile');"
          : `{...register('${f}')}`;
        assert.ok(source.includes(registration), f);
      }
    }
  });
});
