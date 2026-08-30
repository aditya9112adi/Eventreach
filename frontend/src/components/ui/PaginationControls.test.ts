import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { PaginationControls } from './PaginationControls.tsx';

test('PaginationControls renders correctly', () => {
  const html = renderToString(
    React.createElement(PaginationControls, {
      currentPage: 2,
      rowsPerPage: 10,
      totalItems: 25,
      onPageChange: () => {},
      onRowsChange: () => {}
    })
  );
  assert.ok(html.includes('11-20 of 25'));
});
