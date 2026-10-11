/**
 * Adding contacts to a Sub-Event's member list: batching, the merged outcome
 * of the batches, what may be retried, and how the outcome is worded. The
 * server side of each rule is in tests/subEvents.integration.test.ts.
 *
 * Run: npx tsx --test frontend/src/utils/subEventMembers.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_MEMBERS_BATCH_SIZE,
  chunkIds,
  describeOutcome,
  emptyOutcome,
  memberCountLabel,
  mergeBatchFailure,
  mergeBatchResponse,
  retryableIds,
  subEventCountLabel,
  MEMBER_EXPORT_COLUMNS,
  buildMemberExportMeta,
  type SubEventMember,
} from './subEventMembers.ts';
import { createRequire } from 'node:module';
import { buildReportWorkbook, buildReportPdf } from './reportExport.ts';

const ids = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('a selection is sent in bounded batches', async (t) => {
  await t.test('below the server\'s limit of 500 per request', () => {
    assert.ok(ADD_MEMBERS_BATCH_SIZE <= 500);
  });

  await t.test('450 contacts: three requests of 200, 200 and 50', () => {
    assert.deepEqual(chunkIds(ids(450)).map((c) => c.length), [200, 200, 50]);
  });

  await t.test('a contact picked twice is sent once', () => {
    assert.deepEqual(chunkIds(['a', 'b', 'a', 'c', 'b'], 2), [['a', 'b'], ['c']]);
  });

  await t.test('nothing selected: no request', () => {
    assert.deepEqual(chunkIds([]), []);
  });
});

test('the outcome is the sum of what the server reported for each batch', async (t) => {
  await t.test('two batches fold together, the last member count wins', () => {
    let outcome = emptyOutcome();
    outcome = mergeBatchResponse(outcome, { added: ['a', 'b'], alreadyMembers: ['c'], rejected: [], failed: [], memberCount: 3 });
    outcome = mergeBatchResponse(outcome, {
      added: ['d'], alreadyMembers: [], rejected: [{ id: 'x', reason: 'Access denied' }], failed: [], memberCount: 4,
    });
    assert.deepEqual(outcome.added, ['a', 'b', 'd']);
    assert.deepEqual(outcome.alreadyMembers, ['c']);
    assert.deepEqual(outcome.rejected, [{ id: 'x', reason: 'Access denied' }]);
    assert.equal(outcome.memberCount, 4);
  });

  await t.test('a batch with no answer at all is recorded as failed, id by id', () => {
    const outcome = mergeBatchFailure(emptyOutcome(), ['p', 'q'], 'Could not reach the server.');
    assert.deepEqual(outcome.failed, [
      { id: 'p', reason: 'Could not reach the server.' },
      { id: 'q', reason: 'Could not reach the server.' },
    ]);
    assert.equal(outcome.memberCount, null, 'nothing is assumed about the list');
  });

  await t.test('a malformed body adds nothing rather than throwing', () => {
    assert.deepEqual(mergeBatchResponse(emptyOutcome(), { error: 'x' }), emptyOutcome());
  });
});

test('only failures are retried - refusals are not', () => {
  let outcome = mergeBatchResponse(emptyOutcome(), {
    added: ['a'], alreadyMembers: [], rejected: [{ id: 'r', reason: 'Contact not found' }],
    failed: [{ id: 'f', reason: 'Could not be added. Try again.' }],
  });
  outcome = mergeBatchFailure(outcome, ['g', 'f'], 'Network error');
  assert.deepEqual(retryableIds(outcome), ['f', 'g']);
});

test('the outcome is worded from the server\'s counts, never the selection', async (t) => {
  await t.test('everything added: success', () => {
    assert.deepEqual(describeOutcome({ ...emptyOutcome(), added: ['a', 'b'] }), { tone: 'success', message: '2 contacts added.' });
  });

  await t.test('added and already members: success, both stated', () => {
    assert.deepEqual(describeOutcome({ ...emptyOutcome(), added: ['a'], alreadyMembers: ['b'] }), {
      tone: 'success',
      message: '1 contact added, 1 contact already a member.',
    });
  });

  await t.test('every selected contact already a member: says so', () => {
    assert.deepEqual(describeOutcome({ ...emptyOutcome(), alreadyMembers: ['a', 'b', 'c'] }), {
      tone: 'info',
      message: 'All selected contacts are already members (3).',
    });
  });

  await t.test('a partial outcome is a warning, never a success', () => {
    const result = describeOutcome({ ...emptyOutcome(), added: ['a'], failed: [{ id: 'b', reason: 'x' }] });
    assert.equal(result.tone, 'warning');
    assert.equal(result.message, '1 contact added, 1 contact could not be added.');
  });

  await t.test('nothing added: an error', () => {
    const result = describeOutcome({ ...emptyOutcome(), rejected: [{ id: 'a', reason: 'Access denied' }, { id: 'b', reason: 'x' }] });
    assert.deepEqual(result, { tone: 'error', message: '2 contacts could not be added.' });
  });
});

test('counts read naturally', () => {
  assert.equal(memberCountLabel(0), 'No members');
  assert.equal(memberCountLabel(undefined), 'No members');
  assert.equal(memberCountLabel(1), '1 member');
  assert.equal(memberCountLabel(120), '120 members');
  assert.equal(subEventCountLabel(1), '1 sub-event');
  assert.equal(subEventCountLabel(5), '5 sub-events');
});

test("the member download holds exactly the sub-event's members, under its own name", async () => {
  const members: SubEventMember[] = [
    { _id: 'm1', fullName: 'Aarav Mehta', phoneNumber: '+919876500000', status: 'Valid', addedAt: '2026-10-10T08:00:00.000Z',
      sourceEvent: { _id: 'w', eventId: 'EVT-000003', eventName: 'Sharma Wedding' } },
    { _id: 'm2', fullName: 'Neha Engaged', phoneNumber: '+919876599999', email: 'neha@gmail.com', status: 'Valid', addedAt: null,
      sourceEvent: { _id: 'e', eventId: 'EVT-000004', eventName: 'Sharma Engagement' } },
  ];
  const haldi = {
    eventId: 'EVT-000005', eventName: 'Haldi Ceremony',
    parentEvent: { _id: 'w', eventId: 'EVT-000003', eventName: 'Sharma Wedding' },
  };
  const meta = buildMemberExportMeta(haldi, '  ', members);
  assert.deepEqual(meta.rows, [
    ['Sub-Event', 'EVT-000005 | Haldi Ceremony'],
    ['Main Event', 'EVT-000003 | Sharma Wedding'],
    ['Search Value', '-'],
    ['Members', '2'],
  ], 'the stated count is the number of rows written');
  assert.equal(buildMemberExportMeta(haldi, 'neha', members.slice(1)).rows![3][1], '1', 'a searched download counts what it holds');

  const built = await buildReportWorkbook('Sub-Event Members', MEMBER_EXPORT_COLUMNS, members, meta);
  const imported: any = await import('exceljs');
  const ExcelJS = imported.default ?? imported;
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(await built.xlsx.writeBuffer());
  const rows: string[][] = [];
  back.worksheets[0].eachRow({ includeEmpty: false }, (row: any) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell: any) => cells.push(String(cell.value ?? '')));
    rows.push(cells);
  });
  const flat = rows.map((r) => r.join(' | '));
  assert.ok(flat.some((line) => line.includes('Sub-Event') && line.includes('EVT-000005 | Haldi Ceremony')));
  assert.ok(flat.some((line) => line.includes('Main Event') && line.includes('EVT-000003 | Sharma Wedding')));
  assert.ok(flat.some((line) => line.startsWith('Members | 2')), 'the Excel states the member count');

  const header = rows.findIndex((r) => r[0] === 'Full Name');
  assert.ok(header >= 0, 'the table heading row');
  assert.deepEqual(rows[header], ['Full Name', 'Phone', 'Email', 'Added From', 'Status', 'Added On']);
  const data = rows.slice(header + 1, header + 3);
  assert.deepEqual(data[0].slice(0, 5), ['Aarav Mehta', '+919876500000', '-', 'EVT-000003 | Sharma Wedding', 'Valid']);
  assert.deepEqual(data[1].slice(0, 6), ['Neha Engaged', '+919876599999', 'neha@gmail.com', 'EVT-000004 | Sharma Engagement', 'Valid', '-']);
  const memberRows = rows.slice(header + 1).filter((r) => r.length >= 5 && /^\+91/.test(r[1] ?? ''));
  assert.equal(memberRows.length, 2, 'exactly the members, one row each');

  // The PDF, read back as text (as accessContactExport.test.ts reads its reports).
  const pdf = await buildReportPdf('Sub-Event Members', MEMBER_EXPORT_COLUMNS, members, meta);
  const require = createRequire(import.meta.url);
  const pdfParse = require(require.resolve('pdf-parse', { paths: ['./backend', '.'] }));
  const raw: string = (await pdfParse(Buffer.from(pdf.output('arraybuffer')))).text;
  // The extractor runs each label into its value ("Members2").
  assert.ok(raw.split(/\r?\n/).includes('Members2'), 'the PDF states the member count');
  const text = raw.replace(/\s+/g, ' ');
  for (const expected of ['Sub-Event Members', 'EVT-000005 | Haldi Ceremony', 'EVT-000003 | Sharma Wedding', 'Aarav Mehta', 'Neha Engaged', 'neha@gmail.com']) {
    assert.ok(text.includes(expected), `the PDF shows "${expected}"`);
  }
  assert.equal(text.split('+91').length - 1, 2, 'two members, no more');
});
