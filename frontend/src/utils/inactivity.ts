/**
 * Signing a session out after a spell of inactivity.
 *
 * The timing and the listener bookkeeping are kept here, free of React, for the
 * same reason services/authErrors.ts keeps the 401 rule outside the axios
 * interceptor: it can then be driven by a test without a DOM. The component
 * supplies what to do when the time runs out, which is the application's own
 * logout — this adds no second way of ending a session.
 *
 * Nothing here touches the token's own lifetime. The server still signs a JWT
 * that expires on its own schedule; this only closes an unattended screen
 * sooner than that.
 */

/** Ten minutes. The one place the period is written down. */
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

/** Shown on the way out, and again on the sign-in screen. */
export const INACTIVITY_MESSAGE = 'You have been logged out due to inactivity.';

/**
 * Written to localStorage so the other open tabs learn of it.
 *
 * The session itself already lives in localStorage, so a tab that is merely
 * sitting there would otherwise go on looking signed in after another tab
 * ended the session.
 */
export const LOGOUT_BROADCAST_KEY = 'eventreach:session-ended';

/**
 * What counts as the user still being there.
 *
 * Each of these only restarts a timer — none of them is allowed to touch React
 * state, or moving the mouse would re-render the application a hundred times a
 * second.
 */
export const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'click',
  'keydown',
  'scroll',
  'touchstart',
  'pointerdown',
  'focus',
] as const;

/** The part of `window` / `document` this needs, so a test can pass its own. */
export interface ActivityTarget {
  addEventListener(type: string, listener: (event?: any) => void, options?: any): void;
  removeEventListener(type: string, listener: (event?: any) => void, options?: any): void;
}

export interface InactivityMonitorOptions {
  /** The application's logout. Called once, when the period elapses. */
  onTimeout: () => void;
  timeoutMs?: number;
  /** Defaults to `window`. */
  target?: ActivityTarget;
  /** Defaults to `document`; supplies visibilitychange. */
  doc?: ActivityTarget & { visibilityState?: string };
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface InactivityMonitor {
  /** Attaches the listeners and starts the clock. Starting twice is a no-op. */
  start: () => void;
  /** Restarts the clock. Does nothing once stopped. */
  reset: () => void;
  /** Removes every listener and cancels the pending timeout. */
  stop: () => void;
  isRunning: () => boolean;
  /** Listeners currently attached — what proves none are left behind. */
  listenerCount: () => number;
}

export const createInactivityMonitor = (options: InactivityMonitorOptions): InactivityMonitor => {
  const {
    onTimeout,
    timeoutMs = INACTIVITY_TIMEOUT_MS,
    target = typeof window !== 'undefined' ? window : undefined,
    doc = typeof document !== 'undefined' ? document : undefined,
    schedule = (fn: () => void, ms: number) => setTimeout(fn, ms),
    cancel = (handle: unknown) => clearTimeout(handle as any),
  } = options;

  let handle: unknown = null;
  let running = false;
  const attached: Array<() => void> = [];

  const clearPending = () => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  };

  const arm = () => {
    clearPending();
    handle = schedule(() => {
      handle = null;
      // Stop before handing over: the listeners have done their job, and the
      // caller is about to unmount this screen anyway.
      stop();
      onTimeout();
    }, timeoutMs);
  };

  const onActivity = () => {
    if (running) arm();
  };

  /**
   * A tab brought back to the front counts as the user returning. A tab going
   * to the background does not, so a session left hidden still times out.
   */
  const onVisibility = () => {
    if (running && doc?.visibilityState === 'visible') arm();
  };

  const start = () => {
    if (running) return; // re-rendering must not stack a second timer on the first
    running = true;

    if (target) {
      for (const type of ACTIVITY_EVENTS) {
        const listener = onActivity;
        // Passive: these never call preventDefault, and scroll/touch are the
        // ones a non-passive listener would make sluggish.
        target.addEventListener(type, listener, { passive: true });
        attached.push(() => target.removeEventListener(type, listener, { passive: true } as any));
      }
    }
    if (doc) {
      doc.addEventListener('visibilitychange', onVisibility);
      attached.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }

    arm();
  };

  const stop = () => {
    running = false;
    clearPending();
    while (attached.length > 0) {
      const detach = attached.pop();
      detach?.();
    }
  };

  return {
    start,
    reset: () => {
      if (running) arm();
    },
    stop,
    isRunning: () => running,
    listenerCount: () => attached.length,
  };
};

/**
 * Where the reason is parked so it survives the trip to the sign-in screen.
 *
 * Router state is not enough: clearing the token makes the next API call fail
 * with 401, and the axios interceptor answers that with a full page load —
 * which throws away anything held in the router. sessionStorage survives that,
 * and being per-tab it cannot leak the notice into another tab that is still
 * signed in.
 */
export const LOGOUT_REASON_KEY = 'eventreach:logout-reason';

export const storeLogoutReason = (reason: string): void => {
  try {
    sessionStorage.setItem(LOGOUT_REASON_KEY, reason);
  } catch {
    /* storage unavailable: the sign-out itself still happens */
  }
};

/** Reads the reason and consumes it, so it is shown once and not again. */
export const takeLogoutReason = (): string | null => {
  try {
    const reason = sessionStorage.getItem(LOGOUT_REASON_KEY);
    if (reason) sessionStorage.removeItem(LOGOUT_REASON_KEY);
    return reason || null;
  } catch {
    return null;
  }
};

/**
 * Another tab ended the session deliberately.
 *
 * Read from a storage event rather than from localStorage directly, because
 * the event is the only thing that tells a tab something changed underneath it.
 */
export const isSessionEndedBroadcast = (key: string | null, newValue: string | null): boolean =>
  key === LOGOUT_BROADCAST_KEY && newValue !== null && newValue !== '';

/** The token was removed in another tab — a sign-out by any route. */
export const isTokenCleared = (key: string | null, newValue: string | null): boolean =>
  key === 'token' && (newValue === null || newValue === '');
