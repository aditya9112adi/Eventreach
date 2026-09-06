import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportFileName } from './reportExport.ts';
import { formatFileStamp } from './datetime.ts';

test('formatFileStamp renders DDMMYYYY with zero padding', () => {
  assert.equal(formatFileStamp(new Date(2026, 7, 21)), '21082026'); // 21 Aug 2026
  assert.equal(formatFileStamp(new Date(2026, 0, 5)), '05012026'); // 05 Jan 2026
  assert.equal(formatFileStamp(new Date(2026, 11, 31)), '31122026');
});

test('buildReportFileName matches the agreed convention', () => {
  // The exact example from the spec.
  assert.equal(
    buildReportFileName('AccessReport', 'UserName', new Date(2026, 7, 21)),
    'AccessReport_UserName_21082026'
  );
});

test('buildReportFileName covers every report and filter combination', () => {
  const when = new Date(2026, 7, 21);
  assert.equal(buildReportFileName('EventReport', 'EventName', when), 'EventReport_EventName_21082026');
  assert.equal(buildReportFileName('EventReport', 'Status', when), 'EventReport_Status_21082026');
  assert.equal(buildReportFileName('EventReport', 'Date', when), 'EventReport_Date_21082026');
  assert.equal(buildReportFileName('AccessReport', 'Status', when), 'AccessReport_Status_21082026');
  assert.equal(buildReportFileName('AccessReport', 'Date', when), 'AccessReport_Date_21082026');
  assert.equal(buildReportFileName('ContactReport', 'Name', when), 'ContactReport_Name_21082026');
});

test('buildReportFileName strips characters that are unsafe in a file name', () => {
  const when = new Date(2026, 7, 21);
  // A path separator or traversal attempt must not survive into the name.
  assert.equal(
    buildReportFileName('Access/Report', '../UserName', when),
    'AccessReport_UserName_21082026'
  );
  assert.equal(buildReportFileName('A B', 'C:D*E?', when), 'AB_CDE_21082026');
  const built = buildReportFileName('Report', 'Filter', when);
  assert.ok(!/[/\\:*?"<>|]/.test(built), 'must contain no reserved characters');
});
