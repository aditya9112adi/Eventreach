import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('ContactList is refactored to use PaginationControls', () => {
  const content = fs.readFileSync('frontend/src/pages/Contacts/ContactList.tsx', 'utf-8');
  assert.ok(content.includes('PaginationControls'), 'ContactList must use PaginationControls');
  assert.ok(!content.includes('Rows per page:'), 'ContactList must not contain hardcoded pagination UI');
});
