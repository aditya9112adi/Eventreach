/**
 * The unsaved-changes dialog renders as a centered Yes/No confirmation.
 *
 * Run: npx tsx --test frontend/src/components/ui/UnsavedChangesDialog.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { UnsavedChangesDialog } from './UnsavedChangesDialog.tsx';
import { UNSAVED_CHANGES_MESSAGE } from '../useUnsavedChangesGuard.ts';

// The app builds JSX with the automatic runtime; tsx uses the classic one, which needs React in scope.
(globalThis as any).React = React;

const render = (open: boolean) =>
  renderToString(React.createElement(UnsavedChangesDialog, { open, onYes: () => {}, onNo: () => {} }));

test('renders nothing while closed', () => {
  assert.equal(render(false), '');
});

test('open: a centered alert dialog with the message and Yes / No buttons', () => {
  const html = render(true);
  assert.ok(html.includes('role="alertdialog"'));
  assert.ok(html.includes('aria-modal="true"'));
  assert.ok(html.includes('items-center justify-center'), 'centered');
  assert.ok(html.includes('Unsaved changes'));
  assert.ok(html.includes(UNSAVED_CHANGES_MESSAGE.replace(/'/g, '&#x27;')));
  assert.ok(html.includes('Yes, leave'));
  assert.ok(html.includes('No, stay'));
  // "No" comes first, so it is the first control in tab order.
  assert.ok(html.indexOf('No, stay') < html.indexOf('Yes, leave'));
});
