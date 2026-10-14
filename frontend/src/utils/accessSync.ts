import type { User } from '@eventreach/shared';
import { canSeeTemplatesPage } from './whatsappTemplates';

/**
 * Keeping a signed-in account's permissions current - the logic, free of React
 * so it can be tested without a browser.
 *
 * The server is the only source of truth: GET /auth/me returns the account as
 * the database holds it right now, and every protected API call is authorized
 * from the database again. Nothing here grants anything. What the browser
 * holds only decides which controls and pages are drawn, so a missed, forged,
 * duplicated or late event can cost at most a stale menu until the next
 * re-read - never access.
 *
 * Re-reads are triggered by: the ACCESS_CHANGED push, a socket reconnect, the
 * tab becoming visible or the window regaining focus, coming back online, a
 * slow interval (the safety net for a missed push, and for several backend
 * instances), and the moment an access window starts or ends.
 */

export const ACCESS_CHANGED_EVENT = 'ACCESS_CHANGED';
/** Slow safety net while the tab is visible. One small request. */
export const ACCESS_REFRESH_INTERVAL_MS = 60_000;
/** Focus, visibility and "online" fire in bursts: one re-read per burst. */
export const ACCESS_REFRESH_MIN_GAP_MS = 5_000;
/** Timers are chunked: setTimeout cannot hold more than ~24.8 days. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
/** A little past the boundary, so the server agrees the window has changed. */
const BOUNDARY_SLACK_MS = 750;

// ── what changed ────────────────────────────────────────────────────────────

export type AccessChange =
  | 'templates_granted'
  | 'templates_revoked'
  | 'access_window'
  | 'event_assignment'
  | 'role'
  | 'status';

const flag = (value: unknown) => value === true;

/** The differences that matter to the person, between two server answers for the same account. */
export const diffAccess = (before: User | null | undefined, after: User | null | undefined): AccessChange[] => {
  if (!before || !after || before.id !== after.id) return [];
  const changes: AccessChange[] = [];
  if (!flag(before.canManageWhatsAppTemplates) && flag(after.canManageWhatsAppTemplates)) changes.push('templates_granted');
  if (flag(before.canManageWhatsAppTemplates) && !flag(after.canManageWhatsAppTemplates)) changes.push('templates_revoked');
  if (before.role !== after.role) changes.push('role');
  if (before.status !== after.status || flag(before.isAccessCancelled) !== flag(after.isAccessCancelled)) changes.push('status');
  if (before.accessStartDate !== after.accessStartDate || before.accessExpiryDate !== after.accessExpiryDate) changes.push('access_window');
  if (before.assignedEventId !== after.assignedEventId) changes.push('event_assignment');
  return changes;
};

export const ACCESS_CHANGE_MESSAGES: Record<AccessChange, { type: 'success' | 'info' | 'warning'; message: string }> = {
  templates_granted: { type: 'success', message: 'You can now manage WhatsApp templates.' },
  templates_revoked: { type: 'warning', message: 'Your access to WhatsApp templates was removed.' },
  access_window: { type: 'info', message: 'Your access period was updated.' },
  event_assignment: { type: 'info', message: 'Your event assignment was updated.' },
  role: { type: 'info', message: 'Your role was updated.' },
  status: { type: 'info', message: 'Your account status was updated.' },
};

/** The toasts to show: one per change that matters. */
export const accessChangeToasts = (changes: AccessChange[]) => changes.map((c) => ACCESS_CHANGE_MESSAGES[c]);

/** Whether two profiles are the same, so an unchanged answer causes no re-render. */
export const sameProfile = (a: User | null | undefined, b: User | null | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

// ── where the person may be ─────────────────────────────────────────────────

const TEMPLATE_PATHS = ['/whatsapp/templates', '/whatsapp/test-send'];
const isUnder = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Where to send the person if the page they are on is no longer theirs, or
 * null to leave them. The pages' own guards (RoleRoute, TemplateAccessRoute)
 * show "Access denied" as well and follow the live profile; this moves the
 * person off the page so they are not left staring at it. Only the pages whose
 * permission can change while signed in are listed.
 */
export const redirectTargetFor = (pathname: string, user: User | null | undefined): string | null => {
  if (!user) return null;
  if (TEMPLATE_PATHS.some((p) => isUnder(pathname, p)) && !canSeeTemplatesPage(user) && user.role !== 'SuperAdmin') return '/dashboard';
  return null;
};

// ── when to look again ──────────────────────────────────────────────────────

/**
 * Milliseconds until the next moment the account's access window starts or
 * ends, or null if there is none ahead. Capped at a day: the timer is simply
 * set again after it fires.
 */
export const nextAccessBoundaryDelay = (user: Pick<User, 'accessStartDate' | 'accessExpiryDate' | 'role'> | null | undefined, now: number): number | null => {
  if (!user || user.role === 'SuperAdmin') return null;
  const ahead = [user.accessStartDate, user.accessExpiryDate]
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((time) => Number.isFinite(time) && time > now)
    .map((time) => time - now);
  if (ahead.length === 0) return null;
  return Math.min(Math.min(...ahead) + BOUNDARY_SLACK_MS, MAX_TIMER_MS);
};

/** A burst of focus/visibility/online signals triggers one re-read per gap. */
export const shouldRefreshNow = (lastRefreshAt: number, now: number, minGap = ACCESS_REFRESH_MIN_GAP_MS) => now - lastRefreshAt >= minGap;

// ── one re-read at a time ───────────────────────────────────────────────────

/**
 * Runs re-reads one at a time. A request that arrives while one is running does
 * not start a second in parallel - it asks for exactly one more run once the
 * first finishes. So a burst of duplicate pushes costs at most two requests,
 * and an older answer can never arrive after, and overwrite, a newer one.
 */
export const createRefreshCoordinator = (run: () => Promise<void>) => {
  let running = false;
  let again = false;
  const request = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          await run();
        } catch {
          // A failed read leaves what is shown as it was; the next trigger retries.
        }
      } while (again);
    } finally {
      running = false;
    }
  };
  return { request, isRunning: () => running };
};

// ── other tabs ──────────────────────────────────────────────────────────────

/**
 * The profile another tab just wrote to localStorage, if it is for THIS
 * account and differs from what this tab shows. Another account's profile
 * (someone signing in elsewhere) is never adopted.
 */
export const profileFromStorageEvent = (
  event: { key: string | null; newValue: string | null },
  current: User | null | undefined
): User | null => {
  if (event.key !== 'user' || !event.newValue || !current) return null;
  try {
    const parsed = JSON.parse(event.newValue) as User;
    if (!parsed || parsed.id !== current.id || sameProfile(parsed, current)) return null;
    return parsed;
  } catch {
    return null;
  }
};
