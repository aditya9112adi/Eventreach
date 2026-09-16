import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';

/**
 * Selection and deletion controls shared by every list that supports deleting
 * records.
 *
 * These were written for the Events table and lifted out unchanged once a
 * second list needed them, so that "select, confirm, delete" looks and behaves
 * the same everywhere instead of each page carrying its own copy. The markup
 * and classes are the Events originals.
 *
 * Nothing here decides who may delete. Pages hide these controls for roles that
 * cannot use them, but the server enforces that independently on every request.
 */

const CHECKBOX_CLASS = 'rounded border-border bg-background text-accent focus:ring-accent/20 cursor-pointer';

/** Header checkbox: checked, unchecked or indeterminate. */
export const SelectAllCheckbox = ({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  label: string;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` is a DOM property with no HTML attribute, so it has to be
  // assigned imperatively.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label} className={CHECKBOX_CLASS} />
  );
};

export const RowSelectCheckbox = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) => <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} className={CHECKBOX_CLASS} />;

/** The trash icon at the end of a row. `label` names the record, for screen readers. */
export const DeleteIconButton = ({
  onClick,
  title,
  label,
  disabled,
}: {
  onClick: () => void;
  title: string;
  label: string;
  disabled?: boolean;
}) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={label}
    disabled={disabled}
    className="p-1.5 rounded-md text-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
  >
    <Trash2 className="w-4 h-4" />
  </button>
);

/**
 * Shown above a table only while something is selected, so the destructive
 * action never sits there inert waiting to be misread.
 */
export const BulkDeleteBar = ({
  count,
  noun,
  onDelete,
}: {
  count: number;
  /** Singular record name, e.g. "event" or "guest". */
  noun: string;
  onDelete: () => void;
}) => {
  if (count <= 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
      <span className="text-xs text-foreground/70">
        {count} {noun}{count === 1 ? '' : 's'} selected on this page
      </span>
      <button
        onClick={onDelete}
        className="flex items-center gap-2 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-red-500/20 transition-colors hover:bg-red-600"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete Selected ({count})
      </button>
    </div>
  );
};

/**
 * Confirmation for a destructive action. Nothing is deleted until the confirm
 * button is pressed, and both buttons are disabled while the request is in
 * flight so a double click cannot send a second deletion.
 */
export const ConfirmDeleteDialog = ({
  open,
  title,
  message,
  confirmLabel,
  isDeleting,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-spring-up"
      >
        <h3 className="text-xl font-bold mb-3 text-foreground flex items-center">
          <Trash2 className="w-5 h-5 mr-2 text-red-500" /> {title}
        </h3>
        <p className="text-foreground/70 mb-8 leading-relaxed">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="px-5 py-2.5 rounded-lg bg-foreground/5 hover:bg-foreground/10 text-foreground font-medium transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="px-5 py-2.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 shadow-lg shadow-red-500/20 transition-colors flex items-center disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4 mr-2" /> {isDeleting ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
