import { useEffect, useRef } from 'react';
import { Button } from './Button';
import { UNSAVED_CHANGES_MESSAGE } from '../useUnsavedChangesGuard';

/**
 * The centered confirmation shown when someone leaves a page with unsaved
 * changes. "No" is focused first, so pressing Enter by habit keeps their work;
 * Escape and a click outside also stay.
 */
export const UnsavedChangesDialog = ({ open, onYes, onNo }: { open: boolean; onYes: () => void; onNo: () => void }) => {
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    stayRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onNo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onNo]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onNo}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="unsaved-title"
      aria-describedby="unsaved-body"
    >
      <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full animate-spring-up" onClick={(e) => e.stopPropagation()}>
        <h3 id="unsaved-title" className="text-xl font-bold mb-3 text-foreground">Unsaved changes</h3>
        <p id="unsaved-body" className="text-foreground/70 mb-6 leading-relaxed text-sm">{UNSAVED_CHANGES_MESSAGE}</p>
        <div className="flex justify-end gap-3">
          <button
            ref={stayRef}
            type="button"
            onClick={onNo}
            className="px-4 py-2 rounded-md border border-border text-sm font-semibold text-foreground hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            No, stay
          </button>
          <Button variant="danger" onClick={onYes}>Yes, leave</Button>
        </div>
      </div>
    </div>
  );
};
