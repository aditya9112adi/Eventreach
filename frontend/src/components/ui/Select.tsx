import React, { useId } from 'react';
import { ChevronDown } from 'lucide-react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
}

/** A native `<select>` styled to match Input, keeping the OS picker on mobile. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', label, error, hint, id, children, ...props }, ref) => {
    const autoId = useId();
    const selectId = id || autoId;
    const describedBy = error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-foreground">
            {label}
          </label>
        )}

        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={[
              'h-9 w-full appearance-none rounded-md border bg-surface pl-3 pr-9 text-sm text-foreground',
              'transition-[border-color,box-shadow] duration-control ease-out-expo',
              'focus:outline-none focus:ring-2',
              'disabled:cursor-not-allowed disabled:opacity-55 disabled:bg-surfaceHover',
              error
                ? 'border-destructive focus:border-destructive focus:ring-destructive/25'
                : 'border-input hover:border-muted/60 focus:border-primary focus:ring-primary/25',
              className,
            ].join(' ')}
            {...props}
          >
            {children}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
        </div>

        {error ? (
          <p id={`${selectId}-error`} role="alert" className="mt-1.5 text-xs font-medium text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p id={`${selectId}-hint`} className="mt-1.5 text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Select.displayName = 'Select';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', label, error, hint, id, rows = 4, ...props }, ref) => {
    const autoId = useId();
    const areaId = id || autoId;
    const describedBy = error ? `${areaId}-error` : hint ? `${areaId}-hint` : undefined;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={areaId} className="mb-1.5 block text-sm font-medium text-foreground">
            {label}
          </label>
        )}

        <textarea
          ref={ref}
          id={areaId}
          rows={rows}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={[
            'w-full rounded-md border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted/70',
            'transition-[border-color,box-shadow] duration-control ease-out-expo',
            'focus:outline-none focus:ring-2',
            'disabled:cursor-not-allowed disabled:opacity-55 disabled:bg-surfaceHover',
            error
              ? 'border-destructive focus:border-destructive focus:ring-destructive/25'
              : 'border-input hover:border-muted/60 focus:border-primary focus:ring-primary/25',
            className,
          ].join(' ')}
          {...props}
        />

        {error ? (
          <p id={`${areaId}-error`} role="alert" className="mt-1.5 text-xs font-medium text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p id={`${areaId}-hint`} className="mt-1.5 text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';

export default Select;
