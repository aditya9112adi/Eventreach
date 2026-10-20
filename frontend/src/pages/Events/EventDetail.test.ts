/**
 * The Event Details header: the Access Report button is gone, Edit Event is untouched, and the
 * Access Report itself (its page, route, permissions and endpoint) is unchanged.
 *
 * There is no DOM test runner here, so the page is checked in its source, as the other
 * component tests do.
 *
 * Run: npx tsx --test frontend/src/pages/Events/EventDetail.test.ts
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const read = (file: string) => fs.readFileSync(file, 'utf-8').split('\r\n').join('\n');

const detail = read('frontend/src/pages/Events/EventDetail.tsx');
const app = read('frontend/src/App.tsx');
const reports = read('frontend/src/pages/Reports.tsx');
const layout = read('frontend/src/layouts/DashboardLayout.tsx');
const adminRoutes = read('backend/src/routes/adminRoutes.ts');

/** The header's action area: from the wrapper that holds the buttons to the end of its block. */
const actions = detail.slice(
  detail.indexOf('<div className="flex flex-wrap items-center gap-2">'),
  detail.indexOf('<div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">')
);

describe('the Access Report button is gone from Event Details', () => {
  test('no button, label, icon, link or permission flag for it remains on the page', () => {
    assert.equal(detail.includes('Access Report'), false);
    assert.equal(detail.includes('canViewAccessReport'), false);
    assert.equal(detail.includes('type=access'), false);
    assert.equal(detail.includes('/reports'), false);
    assert.equal(/\bShieldCheck\b/.test(detail), false, 'the icon, which only the button used, is no longer imported');
  });

  test('the header actions hold no other report or navigation button besides Edit Event', () => {
    assert.ok(actions.length > 50, 'the action area was found');
    assert.equal((actions.match(/<Button\b/g) ?? []).length, 1, 'exactly one button: Edit Event');
    assert.equal(/navigate\(`\/reports/.test(actions), false);
  });

  test('nothing the button used is left behind unused', () => {
    // The imports and handlers it shared with Edit Event are still used by it.
    for (const used of ['useNavigate', 'navigate(', 'Edit3', 'Button']) assert.ok(detail.includes(used), used);
    const imported = /import \{([^}]*)\} from 'lucide-react';/.exec(detail)![1].split(',').map((s) => s.trim());
    for (const name of imported) {
      assert.ok((detail.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length >= 2, `${name} is imported and used`);
    }
  });
});

describe('Edit Event stays, and works', () => {
  test('it is still shown for an event that is not completed, with its icon and label', () => {
    assert.ok(/\{event\.eventStatus !== 'Completed' && \(\s*<Button\s+variant="secondary"\s+onClick=\{\(\) => navigate\(`\/events\/\$\{event\._id\}\/edit`\)\}\s*>\s*<Edit3 className="w-4 h-4 mr-2" \/>\s*Edit Event\s*<\/Button>\s*\)\}/.test(actions));
  });

  test('it opens the edit page of this event, and that route and page exist', () => {
    assert.ok(detail.includes('navigate(`/events/${event._id}/edit`)'));
    assert.ok(app.includes('<Route path="/events/:id/edit" element={<PageWrapper><EventEdit /></PageWrapper>} />'));
    assert.ok(app.includes("const EventEdit = lazy(() => import('./pages/Events/EventEdit'));"));
  });

  test('it is still hidden for a completed event, as before', () => {
    assert.ok(actions.includes("event.eventStatus !== 'Completed'"));
  });
});

describe('the header layout is preserved', () => {
  test('the same container classes hold the title and the buttons, so Edit Event keeps its place', () => {
    assert.ok(detail.includes('<div className="flex flex-col md:flex-row md:items-start justify-between gap-4">'));
    assert.ok(detail.includes('<div className="flex flex-wrap items-center gap-2">'));
    assert.ok(detail.includes('<h1 className="text-4xl font-sans font-bold text-foreground">{event.eventName}</h1>'));
  });
});

describe('the Access Report itself is untouched', () => {
  test('its page and route are still there', () => {
    assert.ok(app.includes("const Reports = lazy(() => import('./pages/Reports'));"));
    assert.ok(app.includes('<Route path="/reports" element={<PageWrapper><Reports /></PageWrapper>} />'));
  });

  test('it is still reachable: from the sidebar, from the Event Report View, and by its address', () => {
    assert.ok(layout.includes("{ name: 'Access Report', type: 'access', icon: ShieldCheck }"));
    assert.ok(reports.includes('navigate(`/reports?type=access&eventId=${selectedEventId}`)'));
    assert.ok(reports.includes("endpoint: '/admin/access-report',"));
    assert.ok(reports.includes('parseReportType(searchParams.get(\'type\'), canViewAccessReport)'));
  });

  test('its permissions are unchanged: Admins and Super Admins only, on the page and on the server', () => {
    assert.ok(reports.includes("const canViewAccessReport = user?.role === 'SuperAdmin' || user?.role === 'Admin';"));
    assert.ok(adminRoutes.includes("router.get('/access-report', requireRole(['SuperAdmin', 'Admin']), getAccessReport);"));
  });
});

describe('other pages and buttons are not affected', () => {
  test("the Event List's buttons and the Create/Edit forms do not mention this change", () => {
    for (const file of ['frontend/src/pages/Events/EventList.tsx', 'frontend/src/pages/Events/EventCreate.tsx', 'frontend/src/pages/Events/EventEdit.tsx']) {
      assert.equal(read(file).includes('type=access'), false, file);
    }
  });

  test('the sub-event and member sections still follow the header', () => {
    assert.ok(detail.includes('<SubEventMembers subEvent={event} />'));
    assert.ok(detail.includes('<SubEventsSection parent={event} canManage={canManageSubEvents} />'));
    assert.ok(detail.includes("const backTo = isSubEvent ? `/events/${event.parentEventId}` : '/events';"));
  });
});
