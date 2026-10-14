import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { leaveDestination, shouldConfirmLeaving } from '../utils/whatsappTemplates';

export const UNSAVED_CHANGES_MESSAGE = 'You have unsaved changes. Leave this page and discard them?';

/**
 * Asks before unsaved changes are lost.
 *
 * Clicking an in-app link (the sidebar, a breadcrumb): the click is stopped in
 * the capture phase, so the router never starts the navigation, and
 * `pendingPath` is set. The page shows <UnsavedChangesDialog> for it: "Yes"
 * (`confirmLeave`) goes where the click was heading, "No" (`stay`) stays.
 *
 * Reloading or closing the tab: the browser's own beforeunload prompt. Browsers
 * do not allow a page to restyle or replace that one, so it stays as it is. The
 * app uses <BrowserRouter>, which has no navigation blocker, so the browser's
 * Back button is not intercepted.
 */
export const useUnsavedChangesGuard = (dirty: boolean) => {
  const navigate = useNavigate();
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) {
      setPendingPath(null);
      return;
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      const leaving = shouldConfirmLeaving({
        dirty,
        button: event.button,
        modifier: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        defaultPrevented: event.defaultPrevented,
        href,
        target: anchor.getAttribute('target'),
        download: anchor.hasAttribute('download'),
        origin: window.location.origin,
        currentPath: window.location.pathname,
      });
      if (!leaving) return;
      const destination = leaveDestination(href, window.location.origin);
      if (!destination) return;
      // Stopped here; it only continues if the person answers Yes.
      event.preventDefault();
      event.stopPropagation();
      setPendingPath(destination);
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const stay = useCallback(() => setPendingPath(null), []);
  const confirmLeave = useCallback(() => {
    const destination = pendingPath;
    setPendingPath(null);
    if (destination) navigate(destination);
  }, [navigate, pendingPath]);

  return { pendingPath, confirmLeave, stay };
};
