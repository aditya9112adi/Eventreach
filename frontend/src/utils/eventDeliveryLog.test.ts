/**
 * The Delivery Log under the Event Report.
 *
 * The status and label rules are exercised directly. The React wiring cannot
 * be rendered here - this repo has no DOM test runner - so it is asserted from
 * the source, as the report tests already do: what matters is WHEN the log is
 * fetched, WHAT it is allowed to touch, and that the Event Report keeps the
 * columns it had.
 *
 * Run: npx tsx --test frontend/src/utils/eventDeliveryLog.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  DELIVERY_STATUS_FILTERS,
  describeDeliveryLog,
  deliveryStamp,
  DELIVERY_LOG_COLUMNS,
} from './deliveryLogReport.ts';

// Normalised so the anchors below hold on a CRLF checkout as well as an LF one.
const read = (file: string) =>
  fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
const reports = read('frontend/src/pages/Reports.tsx');
const container = read('frontend/src/components/ui/EventDeliveryLog.tsx');
const table = read('frontend/src/components/ui/DeliveryLogTable.tsx');
const campaignPage = read('frontend/src/pages/Campaigns/CampaignReport.tsx');

/** The text of one function or block, up to its closing line. */
const between = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `"${from}" is in the source`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `"${to}" follows it`);
  return source.slice(start, end);
};

test('the statuses are the ones the system already has', async (t) => {
  await t.test('the filter offers exactly the existing statuses, in the table\'s order', () => {
    assert.deepEqual(
      DELIVERY_STATUS_FILTERS.map((o) => o.value),
      ['All', 'Sent', 'Delivered', 'Read', 'Failed', 'Pending']
    );
  });

  await t.test('"Accepted" is a label for Sent, not a second status', () => {
    assert.equal(DELIVERY_STATUS_FILTERS.some((o) => o.value === 'Accepted'), false);
    assert.equal(DELIVERY_STATUS_FILTERS.find((o) => o.value === 'Sent')?.label, 'Accepted by WhatsApp');
  });

  await t.test('every value is one the backend persists or derives', () => {
    // Pending/Sent/Delivered/Failed are MessageLog.status; Read is readAt.
    const model = read('backend/src/models/MessageLog.ts');
    for (const status of ['Pending', 'Sent', 'Delivered', 'Failed']) {
      assert.ok(model.includes(`'${status}'`), `${status} is a stored status`);
    }
    assert.ok(model.includes('readAt'), 'Read is the readAt timestamp');
  });
});

test('each message state reads the way the existing table reads it', async (t) => {
  await t.test('Pending', () => {
    assert.equal(describeDeliveryLog({ status: 'Pending' }).label, 'Waiting to be processed');
  });
  await t.test('Sent is accepted by WhatsApp', () => {
    assert.equal(describeDeliveryLog({ status: 'Sent', sentAt: 'x' }).label, 'Accepted by WhatsApp');
  });
  await t.test('Delivered', () => {
    assert.equal(describeDeliveryLog({ status: 'Delivered', deliveredAt: 'x' }).label, 'Delivered');
  });
  await t.test('Read wins over Delivered, because a read message is also a delivered one', () => {
    assert.equal(describeDeliveryLog({ status: 'Delivered', deliveredAt: 'x', readAt: 'y' }).label, 'Read');
  });
  await t.test('Failed wins over everything', () => {
    assert.equal(describeDeliveryLog({ status: 'Failed', sentAt: 'x', readAt: 'y' }).label, 'Failed');
  });
  await t.test('a timestamp that does not exist is a dash, never a made-up value', () => {
    assert.equal(deliveryStamp(undefined), '—');
    assert.equal(deliveryStamp(''), '—');
    assert.equal(deliveryStamp('not a date'), '—');
  });
});

test('the Event Report keeps its columns', async (t) => {
  const eventBlock = between(reports, "key: 'event'", "key: 'access'");
  const headers = [...eventBlock.matchAll(/header: '([^']+)'/g)].map((m) => m[1]);

  await t.test('still the nine event columns, unchanged', () => {
    assert.deepEqual(headers, [
      'Event ID', 'Event Name', 'Event Type', 'Organizer', 'Mobile', 'Date', 'Time', 'Venue', 'Status',
    ]);
  });

  await t.test('no WhatsApp statistic was added as a column', () => {
    for (const forbidden of ['Sent', 'Pending', 'Failed', 'Delivered', 'Read', 'Accepted']) {
      assert.equal(headers.includes(forbidden), false, `"${forbidden}" is not an Event Report column`);
    }
  });

  await t.test('the exports are still the event table alone', () => {
    const exportBlock = between(reports, 'const runExport', 'const statusVariant');
    assert.ok(exportBlock.includes('definition.columns'), 'the report definition supplies the columns');
    assert.ok(!exportBlock.includes('EventDeliveryLog') && !exportBlock.includes('delivery-log'),
      'the export does not pull delivery data in');
  });
});

test('the log is fetched only once a report exists', async (t) => {
  const section = between(reports, 'Delivery Log: the WhatsApp recipients', '</>\n      )}');

  await t.test('it is shown only for the Event Report', () => {
    assert.ok(section.includes("activeReport === 'event'"));
  });

  await t.test('and only after a report has been generated', () => {
    assert.ok(section.includes('hasResults'), 'no generated report, no log');
    assert.ok(section.includes('filteredRows.length > 0'), 'and there is something to belong to');
  });

  await t.test('Reports itself never calls the delivery-log endpoint', () => {
    // Only the component, mounted under those conditions, does.
    assert.equal(reports.includes('delivery-log'), false, 'opening Reports cannot fetch it');
    assert.equal(reports.includes('api.get(`/reports/event'), false);
  });

  await t.test('the drill-down and the log are never both showing', () => {
    assert.ok(section.includes('!selectedEventId'), 'the full campaign report keeps its own log');
  });

  await t.test('Clear and a tab switch both discard the report, which unmounts the log', () => {
    const clear = between(reports, 'const clearFilters', 'const activeOption');
    const switchStart = reports.indexOf('const switchReport');
    const switching = reports.slice(switchStart, reports.indexOf('\n  };', switchStart));
    assert.ok(clear.includes("dispatch({ type: 'reset'"), 'Clear resets the run');
    assert.ok(switching.includes("dispatch({ type: 'reset'"), 'switching resets the run');
    assert.ok(!switching.includes('EventDeliveryLog') && !switching.includes('delivery-log'),
      'and switching starts no log request of its own');
  });

  await t.test('the Access and Contact reports never show it', () => {
    // The Event Report condition is what the whole section is gated by, and
    // it comes before anything is rendered.
    assert.ok(section.indexOf("activeReport === 'event'") < section.indexOf('<EventDeliveryLog'));
    assert.equal((section.match(/activeReport === /g) || []).length, 1, 'no other report is named');
  });
});

test('the log belongs to exactly one event', async (t) => {
  const derive = between(reports, 'const deliveryLogEventId', 'const statusVariant');

  await t.test('it needs a report that has narrowed to a single event', () => {
    assert.ok(derive.includes('filteredRows.length === 1'));
    assert.ok(derive.includes('_id'), 'the id comes from the event row itself');
  });

  await t.test('with several events it says so rather than choosing one', () => {
    assert.ok(reports.includes('shows one event at a time'));
  });

  await t.test('the component is keyed by event, so one event\'s rows never linger under another', () => {
    assert.ok(reports.includes('key={deliveryLogEventId}'));
  });

  await t.test('the request is scoped to that event in its URL', () => {
    assert.ok(container.includes('/reports/event/${eventId}/delivery-log'));
  });
});

test('one request, scoped, and not per recipient', async (t) => {
  await t.test('exactly one API call site in the component', () => {
    assert.equal((container.match(/api\.get\(/g) || []).length, 1);
  });

  await t.test('it is never made from inside a loop over the rows', () => {
    assert.ok(!/\.map\([^)]*api\./.test(container) && !/forEach\([^)]*api\./.test(container));
    assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*api\./.test(container));
  });

  await t.test('the filter is sent to the server and the page size is bounded', () => {
    assert.ok(container.includes("status: statusFilter === 'All' ? undefined : statusFilter"));
    assert.ok(container.includes('limit: PAGE_LIMIT'));
  });

  await t.test('a slow earlier answer cannot overwrite a newer one', () => {
    // Both outcomes are guarded: a late success would replace newer rows, and a
    // late failure would put an error on top of a log that has since loaded.
    const guards = container.split('if (latestRequest.current !== requestId) return;').length - 1;
    assert.equal(guards, 2, 'the success path and the failure path each check');
    assert.ok(container.includes('if (latestRequest.current === requestId) setIsLoading(false);'),
      'and only the newest request may clear the loading state');
    assert.ok(container.includes('++latestRequest.current'), 'every request takes the next number');
  });

  await t.test('a truncated list says so instead of passing as complete', () => {
    assert.ok(container.includes('Showing the latest'));
    assert.ok(container.includes('total > logs.length'));
  });
});

test('the filter changes the log and nothing else', async (t) => {
  await t.test('the status filter is local to the log', () => {
    assert.ok(container.includes("useState('All')"), 'it owns its own filter state');
    assert.ok(!container.includes('setEvents') && !container.includes('loadReport'),
      'it cannot reach the Event Report\'s rows or request');
  });

  await t.test('Reports does not know the log\'s filter', () => {
    assert.equal(reports.includes('statusFilter'), false, 'the report\'s filters are untouched by it');
  });

  await t.test('the log refetches on a filter change, so only the log', () => {
    assert.ok(container.includes('[eventId, statusFilter]'), 'the loader depends on the filter');
  });
});

test('a status change reaches the open log', async (t) => {
  await t.test('it listens for the message updates the system already emits', () => {
    assert.ok(container.includes("socket.on('message-log-updated'"));
    assert.ok(container.includes("socket.off('message-log-updated'"), 'and lets go on unmount');
  });

  await t.test('it refreshes only for its own event', () => {
    assert.ok(container.includes('data.eventId === eventId'), 'a template message is recognised by event');
    assert.ok(container.includes('data.campaignId === campaignId'), 'a campaign message by its campaign');
    // Recognising its own is not enough: the refresh itself has to be gated on
    // it, or every message update anywhere would reload this log.
    assert.ok(container.includes('if (mine) void load(true);'), 'and nothing else triggers a reload');
    assert.equal((container.match(/void load\(true\)/g) || []).length, 1, 'there is no other silent reload');
  });

  await t.test('and refreshes quietly, without blanking the table', () => {
    assert.ok(container.includes('void load(true)'));
  });

  await t.test('the webhook now says which event a template update is for', () => {
    const webhook = read('backend/src/controllers/webhookController.ts');
    assert.ok(webhook.includes('eventId: log.eventId ? String(log.eventId) : undefined'));
    assert.equal(webhook.includes('campaignId: String(log.campaignId)'), false,
      'String(undefined) no longer goes out as the text "undefined"');
  });
});

test('one table serves both reports', async (t) => {
  await t.test('the campaign report renders the shared table', () => {
    assert.ok(campaignPage.includes('<DeliveryLogTable'));
    assert.equal(campaignPage.includes('<table'), false, 'it no longer carries its own copy');
  });

  await t.test('the event section renders the same component', () => {
    assert.ok(container.includes('<DeliveryLogTable'));
  });

  await t.test('the campaign report keeps its card placement and its own endpoints', () => {
    assert.ok(campaignPage.includes('lg:col-span-2'));
    assert.ok(campaignPage.includes('/reports/campaign/${campaignId}/stats'));
    assert.ok(campaignPage.includes('/reports/campaign/${campaignId}/logs'));
    assert.ok(campaignPage.includes('/reports/event/${eventId}/template-logs'));
  });

  await t.test('the table keeps the columns, in the order the reference shows', () => {
    const heads = [...table.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(heads, [
      'Sr No', 'Contact', 'Phone', 'Status', 'Accepted', 'Delivered', 'Read', 'Failed', 'Details',
    ]);
  });

  await t.test('the Excel export of the log uses those same columns', () => {
    assert.deepEqual(
      DELIVERY_LOG_COLUMNS.map((c) => c.header),
      ['Contact', 'Phone', 'Status', 'Accepted', 'Delivered', 'Read', 'Failed', 'Details']
    );
  });

  await t.test('the wide detail columns scroll inside the log, not the page', () => {
    assert.ok(table.includes('table-scroll'));
    assert.ok(table.includes('min-w-[1150px]'));
  });

  await t.test('the filter sits at the top right of the log', () => {
    const head = between(table, '<div className="flex items-center justify-between mb-4">', '</div>');
    assert.ok(head.indexOf('<h3') < head.indexOf('<select'), 'title first, filter after it, justified apart');
  });
});

test('the existing Reports behaviour is intact', async (t) => {
  await t.test('SuperAdmin still generates only on Search, behind the date check', () => {
    const run = between(reports, 'const runSearch', 'useEffect(() => {\n    if (!selectedEventId)');
    assert.ok(run.indexOf('validateReportDateRange') < run.indexOf('loadReport(activeReport'));
  });

  await t.test('switching reports still keeps the dates', () => {
    const start = reports.indexOf('const switchReport');
    const switching = reports.slice(start, reports.indexOf('\n  };', start));
    assert.ok(!switching.includes("setStartDate('')") && !switching.includes("setEndDate('')"));
  });

  await t.test('the report request still carries both dates and never fills the events cache', () => {
    const load = between(reports, 'const loadReport', 'Roles other than Super Admin filter live');
    assert.ok(load.includes('startDate: filters.startDate') && load.includes('endDate: filters.endDate'));
    assert.ok(!load.includes('setEvents('));
  });
});
