/**
 * Sign-in when the API is asleep - the logic, free of React so it can be tested
 * without a browser.
 *
 * The API runs on a host that puts an idle service to sleep; the first request
 * after that waits for it to wake (measured at ~43 s on this deployment), while
 * later requests take well under a second. Nothing in the app can make the
 * host wake faster, so this module does the two honest things that are possible:
 * start the wake-up as early as possible - when the sign-in page opens, while
 * the person is still typing - and say plainly what is happening while they wait.
 */

/** After this long without an answer the page explains that the server is waking. */
export const WAKE_NOTICE_AFTER_MS = 4_000;
/** Longer than a cold start, so a wake-up completes - but never an endless spinner. */
export const LOGIN_TIMEOUT_MS = 90_000;

export const WAKE_NOTICE = 'Still connecting. The server was idle and is starting up, which can take up to a minute the first time. Please keep this page open.';

/** The message to show while a sign-in has been waiting `elapsedMs`, or null. */
export const loginWaitNotice = (elapsedMs: number): string | null => (elapsedMs >= WAKE_NOTICE_AFTER_MS ? WAKE_NOTICE : null);

/** What to tell the person when sign-in failed, with the cause named. */
export const loginErrorMessage = (error: any): string => {
  const serverMessage = error?.response?.data?.error;
  if (typeof serverMessage === 'string' && serverMessage) return serverMessage;
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return 'The server took too long to respond. It may still be starting up - please try again in a moment.';
  }
  if (!error?.response) return 'Could not reach the server. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
};

/** The API's own origin: the base URL without its /api path. */
export const apiRootFromBase = (baseURL: string | undefined): string | null => {
  if (!baseURL) return null;
  try {
    const url = new URL(baseURL);
    return url.origin;
  } catch {
    return null;
  }
};

let warmedUp = false;

/**
 * One request to the API's /health (no database, no data, no credentials) so a
 * sleeping server starts waking now rather than when the person presses Sign In.
 * Sent once per page load, never repeated or retried, and its answer is ignored.
 * `no-cors` because only the wake-up matters, not the response.
 */
export const warmUpApi = (
  baseURL: string | undefined,
  fetchImpl: typeof fetch | null = typeof fetch === 'function' ? fetch : null
): boolean => {
  const root = apiRootFromBase(baseURL);
  if (warmedUp || !root || !fetchImpl) return false;
  warmedUp = true;
  try {
    void Promise.resolve(fetchImpl(`${root}/health`, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit' })).catch(() => {});
  } catch {
    // Never let a failed ping touch the page.
  }
  return true;
};

/** For tests. */
export const resetWarmUpForTests = () => {
  warmedUp = false;
};
