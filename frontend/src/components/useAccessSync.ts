import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/authStore';
import { useSocket } from '../contexts/SocketContext';
import { useToast } from './ui/Toast';
import {
  ACCESS_CHANGED_EVENT,
  ACCESS_REFRESH_INTERVAL_MS,
  accessChangeToasts,
  createRefreshCoordinator,
  diffAccess,
  nextAccessBoundaryDelay,
  redirectTargetFor,
  shouldRefreshNow,
} from '../utils/accessSync';

/**
 * Keeps the signed-in account's permissions current without a page refresh.
 * Mounted once, in the layout every signed-in page renders inside.
 *
 * When something may have changed (see utils/accessSync.ts for the list) it
 * asks the server for the account, adopts the answer, tells the person what
 * changed, and moves them off a page that is no longer theirs. The menu and the
 * route guards read the same profile, so they follow on their own.
 *
 * Everything it sets up is torn down on unmount, sign-out and a new session, and
 * it is set up once per session: the callbacks it uses live in refs, so a
 * re-render never adds a second set of listeners.
 */
export const useAccessSync = () => {
  const { user, token, refreshUser } = useAuth();
  const { socket } = useSocket();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const latest = useRef({ showToast, navigate, pathname: location.pathname });
  latest.current = { showToast, navigate, pathname: location.pathname };
  const lastRefreshAt = useRef(0);

  const coordinatorRef = useRef<ReturnType<typeof createRefreshCoordinator> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createRefreshCoordinator(async () => {
      const result = await refreshUser();
      lastRefreshAt.current = Date.now();
      if (!result) return;
      for (const toast of accessChangeToasts(diffAccess(result.before, result.after))) {
        latest.current.showToast(toast.type, toast.message);
      }
      const target = redirectTargetFor(latest.current.pathname, result.after);
      if (target) latest.current.navigate(target, { replace: true });
    });
  }
  const requestRef = useRef(() => void coordinatorRef.current!.request());

  // The push, and a reconnect after a drop (which may have missed pushes).
  useEffect(() => {
    if (!socket || !token) return;
    const refresh = () => requestRef.current();
    socket.on(ACCESS_CHANGED_EVENT, refresh);
    socket.on('connect', refresh);
    return () => {
      socket.off(ACCESS_CHANGED_EVENT, refresh);
      socket.off('connect', refresh);
    };
  }, [socket, token]);

  // Coming back to the tab or the network, and the slow safety net while visible.
  useEffect(() => {
    if (!token) return;
    const onReturn = () => {
      if (document.visibilityState === 'visible' && shouldRefreshNow(lastRefreshAt.current, Date.now())) requestRef.current();
    };
    const onOnline = () => {
      if (shouldRefreshNow(lastRefreshAt.current, Date.now())) requestRef.current();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') requestRef.current();
    }, ACCESS_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onOnline);
    };
  }, [token]);

  // The moment an access window starts or ends: ask the server what it says,
  // even if no one is online to change anything.
  const startDate = user?.accessStartDate;
  const expiryDate = user?.accessExpiryDate;
  const role = user?.role;
  useEffect(() => {
    if (!token) return;
    const delay = nextAccessBoundaryDelay({ accessStartDate: startDate, accessExpiryDate: expiryDate, role: role as any }, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(() => requestRef.current(), delay);
    return () => window.clearTimeout(timer);
  }, [token, startDate, expiryDate, role]);
};
