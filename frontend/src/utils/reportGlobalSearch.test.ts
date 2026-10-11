/**
 * The Reports tab's "All Fields" search, and the search box clearing itself
 * once an event is opened from a report.
 *
 * The matching itself is the server's (tests/reportSearch.integration.test.ts
 * checks every field, the authorization and the combination with the other
 * filters). Here: what the page sends, how it treats the server's answer, and
 * - by source assertions, as the other Reports tests do, this repo having no
 * DOM test runner - the wiring of the clearing.
 *
 * Run: npx tsx --test frontend/src/utils/reportGlobalSearch.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  GLOBAL_SEARCH_MODE,
  filterReportRows,
  isServerFiltered,
  reportFilterParams,
  type ReportFilters,
  type ReportKey,
} from './reportSearch.ts';

const reports = fs.readFileSync('frontend/src/pages/Reports.tsx', 'utf-8').split('\r\n').join('\n');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

const filters = (over: Partial<ReportFilters> = {}): ReportFilters => ({
  mode: GLOBAL_SEARCH_MODE, searchValue: '', startDate: '2026-10-01', endDate: '2026-10-31', eventId: '', ...over,
});

test('"All Fields" is sent to the server as q, for every report', async (t) => {
  await t.test('the typed value, trimmed', () => {
    for (const key of ['event', 'access', 'contact'] as ReportKey[]) {
      assert.deepEqual(reportFilterParams(key, filters({ searchValue: '  College Party  ' })), { q: 'College Party' }, key);
      assert.equal(isServerFiltered(key, GLOBAL_SEARCH_MODE), true, key);
    }
  });

  await t.test('nothing empty is sent', () => {
    assert.deepEqual(reportFilterParams('event', filters({ searchValue: '   ' })), {});
    assert.deepEqual(reportFilterParams('contact', filters({ mode: 'Date', searchValue: 'ignored' })), {});
  });

  await t.test('the single-field choices are as they were', () => {
    assert.deepEqual(reportFilterParams('access', filters({ mode: 'UserName', searchValue: 'priya' })), { username: 'priya' });
    assert.deepEqual(reportFilterParams('contact', filters({ mode: 'Name', searchValue: 'riya' })), { name: 'riya' });
    assert.deepEqual(reportFilterParams('contact', filters({ mode: 'Status', searchValue: 'valid' })), { status: 'valid' });
    assert.deepEqual(reportFilterParams('event', filters({ mode: 'EventName', searchValue: 'x' })), {}, 'still filtered in the page');
    assert.equal(isServerFiltered('event', 'EventID'), false);
  });

  await t.test('every report request carries it, the Event Report\'s too', () => {
    const load = between(reports, 'const loadReport = useCallback(', 'Roles other than Super Admin filter live');
    assert.ok(load.includes('...reportFilterParams(key, filters),'));
  });
});

test('the page keeps the server\'s matches - it cannot re-match fields a row does not carry', () => {
  const ACCESSORS = { text: (r: any) => r.eventName, status: () => 'Upcoming', date: (r: any) => r.eventDate };
  // Matched by the server on the date as printed and on the venue.
  const rows = [
    { eventName: 'College Party', eventDate: '2026-10-31' },
    { eventName: 'Sharma Wedding', eventDate: '2026-10-15' },
    { eventName: 'Out Of Range', eventDate: '2026-12-01' },
  ];
  const kept = filterReportRows(rows, ACCESSORS, filters({ searchValue: '31 Oct 2026' }), false).map((r) => r.eventName);
  assert.deepEqual(kept, ['College Party', 'Sharma Wedding'], 'no text re-filter, and the period still applies');
  assert.deepEqual(
    filterReportRows(rows, ACCESSORS, filters({ mode: 'EventName', searchValue: 'wedd' }), false).map((r) => r.eventName),
    ['Sharma Wedding'],
    'a single-field choice still filters in the page'
  );
});

test('every report offers "All Fields" first, with its existing choices after it', () => {
  const blocks = {
    event: between(reports, "key: 'event',", "key: 'access',"),
    access: between(reports, "key: 'access',", "key: 'contact',"),
    contact: between(reports, "key: 'contact',", 'const Reports = () =>'),
  };
  for (const [key, block] of Object.entries(blocks)) {
    const all = block.indexOf("{ key: GLOBAL_SEARCH_MODE, label: 'All Fields', type: 'text', placeholder:");
    assert.ok(all > 0, key);
    assert.ok(all < block.indexOf("type: 'date' }"), `${key}: first`);
  }
  assert.ok(blocks.event.includes("placeholder: 'Search event name, ID, venue, date, time...'"));
  assert.ok(blocks.event.includes("{ key: 'EventName', label: 'Name / ID', type: 'text' },"));
  assert.ok(blocks.event.includes("{ key: 'EventID', label: 'Event ID', type: 'text' },"));
  assert.ok(blocks.access.includes("{ key: 'UserName', label: 'UserName', type: 'text' },"));
  assert.ok(blocks.contact.includes("{ key: 'Name', label: 'Name', type: 'text' },"));
  assert.ok(reports.includes('const [mode, setMode] = useState<string>(REPORTS.event.options[0].key);'), 'the page opens on it');
});

test('opening an event clears the search box and keeps the report', async (t) => {
  const opener = between(reports, 'const openEventFromReport = ', 'const statusVariant');

  await t.test('the box is cleared and the event opened', () => {
    assert.ok(opener.includes("setSearchValue('');"));
    assert.ok(opener.includes("const open = target === 'event' ? setSelectedEventId : setScopedViewEventId;"));
    assert.ok(opener.indexOf("setSearchValue('');") < opener.indexOf('open(id);'));
  });

  await t.test('the generated report\'s filters are kept, so its table, View and downloads stay as they were', () => {
    assert.ok(opener.includes('if (reportFilters) setPinnedFilters(reportFilters);'));
    assert.ok(reports.includes('const reportFilters: ReportFilters | null = pinnedFilters ?? generatedFilters;'));
    assert.ok(reports.includes('const exportFilters = reportFilters ?? liveFilters;'), 'the downloads read the kept filters');
    assert.ok(reports.includes('searchValue: exportFilters.searchValue,'));
  });

  await t.test('clearing the box searches nothing again', () => {
    const debounce = between(reports, 'const [debouncedSearch, setDebouncedSearch] = useState', 'const loadReport = useCallback(');
    assert.ok(debounce.includes('if (searchFirst || !serverFiltered || pinnedFilters) return;'), 'no reload for roles without Search');
    assert.equal(opener.includes('runSearch') || opener.includes('loadReport'), false);
    assert.ok(reports.includes('const filtersChanged = searchFirst && hasResults && !pinnedFilters && filtersDiffer(run.applied, liveFilters);'),
      'no "Filters changed" warning for the cleared box');
  });

  await t.test('closing an event (clearing the picker) does not touch the box', () => {
    assert.ok(opener.includes("if (!id) {\n      open('');\n      return;\n    }"));
  });

  await t.test('it is every way an event is opened from a report', () => {
    assert.ok(reports.includes("onClick={() => openEventFromReport('event', row._id)}"), 'the Event Report View');
    assert.ok(reports.includes("onChange={(id) => openEventFromReport('event', id)}"), 'the Event Report\'s Select Event Name');
    assert.ok(reports.includes("onClick={() => openEventFromReport('scoped', row._id)}"), 'an Access/Contact row\'s View');
    // The Access/Contact picker chooses the next report's event; it opens nothing.
    assert.ok(reports.includes('onChange={(id) => setReportEventId(id)}'));
  });

  await t.test('a search with no event opened keeps what was typed', () => {
    const run = between(reports, 'const runSearch = () => {', 'useEffect(() => {\n    if (!selectedEventId)');
    assert.equal(run.includes("setSearchValue('')"), false);
  });

  await t.test('the next filter change releases the kept filters', () => {
    assert.ok(reports.includes('onSearchChange={(value) => {\n          setPinnedFilters(null);\n          setSearchValue(value);'), 'typing');
    assert.ok(reports.includes('useEffect(() => {\n    setPinnedFilters(null);\n  }, [mode, startDate, endDate, reportEventId]);'), 'choice, dates, event');
    assert.ok(between(reports, 'const runSearch = () => {', 'const clearFilters').includes('setPinnedFilters(null);'), 'Search');
    assert.ok(between(reports, 'const clearFilters = () => {', 'const switchReportRef').includes('setPinnedFilters(null);'), 'Clear');
  });

  await t.test('switching report clears it with every other filter', () => {
    const switching = between(reports, 'const switchReport = (key: ReportKey) => {', 'const clearFilters');
    assert.ok(switching.includes('setPinnedFilters(null);'));
    assert.ok(switching.includes("setSearchValue('');") && switching.includes("setStartDate('');"));
    assert.ok(switching.includes("dispatch({ type: 'reset', reportKey: key, requestId: nextRequestId() });"));
  });
});
