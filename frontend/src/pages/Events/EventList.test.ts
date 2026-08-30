import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('EventList contains PaginationControls', () => {
  const content = fs.readFileSync('frontend/src/pages/Events/EventList.tsx', 'utf-8');
  assert.ok(content.includes('PaginationControls'), 'EventList must use PaginationControls');
  assert.ok(content.includes('getPaginatedData'), 'EventList must use getPaginatedData');
});
