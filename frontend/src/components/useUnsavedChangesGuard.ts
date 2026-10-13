import { useEffect } from 'react';
import { shouldConfirmLeaving } from '../utils/whatsappTemplates';

export const UNSAVED_CHANGES_MESSAGE = 'You have unsaved changes. Leave this page and discard them?';

/**
 * Asks before unsaved changes are lost.
 *
 * Reloading or closing the tab: the browser's own beforeunload prompt.
 * Clicking an in-app link (the sidebar, a breadcrumb): a confirmation, checked
 * in the capture phase so the router never starts the navigation if the user
 * stays. The app uses <BrowserRouter>, which has no navigation blocker, so the
 * browser's Back button is not intercepted.
 */
export const useUnsavedChangesGuard = (dirty: boolean, message = UNSAVED_CHANGES_MESSAGE) => {
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!anchor) return;
      const leaving = shouldConfirmLeaving({
        dirty,
        button: event.button,
        modifier: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        defaultPrevented: event.defaultPrevented,
        href: anchor.getAttribute('href'),
        target: anchor.getAttribute('target'),
        download: anchor.hasAttribute('download'),
        origin: window.location.origin,
        currentPath: window.location.pathname,
      });
      if (leaving && !window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, message]);
};
