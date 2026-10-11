/**
 * The Access Report by event: the page side. The server's side - which events
 * are listed and who has access to each - is in
 * tests/accessReport.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/utils/accessReportByEvent.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { filterReportRows, GLOBAL_SEARCH_MODE, type ReportFilters } from './reportSearch.ts';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');
const reports = read('frontend/src/pages/Reports.tsx');
const accessBlock = reports.slice(reports.indexOf("key: 'access',"), reports.indexOf("key: 'contact',"));

const filters: ReportFilters = { mode: GLOBAL_SEARCH_MODE, searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31' };

test('the period is the server\'s: people are not dropped for when their access was granted', () => {
  const rows = [
    { name: 'Aditya Super', createdAt: '2025-01-01T00:00:00Z' }, // a Super Admin, no grant date
    { name: 'Xavier Admin', accessGrantedOn: '2026-08-01T06:00:00Z' }, // granted before the period
  ];
  const accessors = { text: () => '', status: () => 'Active', date: (r: any) => r.accessGrantedOn || r.createdAt };
  assert.deepEqual(filterReportRows(rows, { ...accessors, datedByServer: true }, filters, false).map((r) => r.name), ['Aditya Super', 'Xavier Admin']);
  assert.deepEqual(filterReportRows(rows, accessors, filters, false), [], 'without the flag the page would drop both');
});

test('the Access tab reads the report by event, and Just Access keeps its account list', () => {
  assert.ok(accessBlock.includes("endpoint: '/admin/access-report',"));
  assert.ok(accessBlock.includes('datedByServer: true,'));
  assert.ok(read('frontend/src/pages/Admin/JustAccess.tsx').includes("api.get('/admin/users/access-records')"));
});

test('the View and its downloads say how each person has access to the event', () => {
  assert.ok(accessBlock.includes("{ header: 'Access Through', value: (r) => value(r.accessVia, '-'), width: 30 },"));
  // The View fetches the report's own endpoint for the event, and downloads its columns.
  assert.ok(reports.includes('endpoint={definition.endpoint}'));
  assert.ok(reports.includes('columns={definition.columns}'));
});

test('rows are one per event, as on the Contact Report', () => {
  assert.ok(accessBlock.includes('eventIds: accessRecordEventIds,'));
  assert.ok(reports.includes('groupRecordsByEvent(filteredRows, eventIdsOf, events)'));
});
