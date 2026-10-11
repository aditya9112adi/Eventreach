import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { Event } from '../backend/src/models/Event.ts';
import { EventMember } from '../backend/src/models/EventMember.ts';
import { MAIN_EVENT_FILTER, isSubEvent } from '../backend/src/services/subEventService.ts';
import { MAX_MEMBERS_PER_REQUEST } from '../backend/src/controllers/eventMemberController.ts';

/**
 * The data rules behind Main Events and Sub-Events, checked on the schemas
 * themselves (no database needed). The behaviour over HTTP is in
 * tests/subEvents.integration.test.ts.
 *
 * Run: npx tsx --test tests/subEventRules.test.ts
 */

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

test('an event is a Main Event unless it names a parent', () => {
  assert.deepEqual(MAIN_EVENT_FILTER, { parentEventId: null }, 'null also matches legacy events with no such field');
  assert.equal(isSubEvent({ parentEventId: null }), false);
  assert.equal(isSubEvent({}), false, 'a legacy event');
  assert.equal(isSubEvent(null), false);
  assert.equal(isSubEvent({ parentEventId: '6aca379360305cef101a5570' }), true);
});

test('parentEventId: an ObjectId, null by default, set once and never changed', () => {
  const path: any = Event.schema.path('parentEventId');
  assert.equal(path.instance, 'ObjectId');
  assert.equal(path.options.ref, 'Event');
  assert.equal(path.options.immutable, true, 'no edit can detach or reparent a sub-event');
  const fresh = new Event({});
  assert.equal(fresh.parentEventId, null, 'a new event is a Main Event');
});

test('the sub-event listing is indexed', () => {
  const keys = Event.schema.indexes().map(([key]) => JSON.stringify(key));
  assert.ok(keys.includes(JSON.stringify({ parentEventId: 1, eventDate: 1 })));
});

test('a membership needs both a sub-event and a contact, and exists once', () => {
  const errors = new EventMember({}).validateSync()?.errors ?? {};
  assert.ok('eventId' in errors && 'contactId' in errors);
  const indexes = EventMember.schema.indexes();
  const unique = indexes.find(([key]) => JSON.stringify(key) === JSON.stringify({ eventId: 1, contactId: 1 }));
  assert.ok(unique && unique[1].unique, 'duplicate membership is impossible at the database level');
  assert.ok(indexes.some(([key]) => JSON.stringify(key) === JSON.stringify({ contactId: 1 })), 'cleanup by contact is indexed');
});

test('one request adds a bounded number of members', () => {
  assert.equal(MAX_MEMBERS_PER_REQUEST, 500);
});

test('creating a sub-event is administrative; reading and member changes are scoped by the controller', () => {
  const routes = read('backend/src/routes/eventRoutes.ts');
  assert.ok(routes.includes("router.post('/:id/sub-events', requireAdmin, createSubEvent);"));
  assert.ok(routes.includes("router.delete('/:id', requireAdmin, deleteEvent);"), 'deleting a sub-event is gated like any event');
  const members = read('backend/src/controllers/eventMemberController.ts');
  assert.ok(members.includes('if (!(await isEventAuthorized((req as any).user, id))) {'));
});

test('the parent comes from the route, never the request body', () => {
  const controller = read('backend/src/controllers/eventController.ts');
  const create = controller.slice(controller.indexOf('export const createSubEvent'), controller.indexOf('// The expiry sweep'));
  assert.ok(create.includes('parentEventId: parent._id,'));
  assert.equal(create.includes('req.body.parentEventId'), false);
  assert.equal(controller.includes('parentEventId: z.'), false, 'not part of the event body schema');
});

test('the hardening migration validates the new field and collection', () => {
  const migration = read('backend/migrateDbHardening.ts');
  assert.ok(migration.includes('parentEventId: oidOrNull,'));
  assert.ok(migration.includes("['eventmembers', {"));
  assert.ok(read('backend/verifyDbHardening.ts').includes("'eventmembers', 'events'"));
});
