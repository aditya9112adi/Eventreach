import React, { useId } from 'react';
import { AlertCircle } from 'lucide-react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  /** Guidance shown under the field when there is no error. */
  hint?: string;
  /** Icon rendered inside the leading edge of the field. */
  icon?: React.ReactNode;
  /** Rendered inside the trailing edge (e.g. a password visibility toggle). */
  trailing?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', label, error, hint, icon, trailing, id, ...props }, ref) => {
    const autoId = useId();
    const inputId = id || autoId;
    const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-foreground mb-1.5">
            {label}
          </label>
        )}

        <div className="relative">
          {icon && (
            <span
              className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted"
              aria-hidden="true"
            >
              {icon}
            </span>
          )}

          <input
            ref={ref}
            id={inputId}
            // Screen readers get the error/hint text, and the invalid state.
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={[
              'w-full rounded-md border bg-surface text-foreground placeholder:text-muted/70',
              'h-9 text-sm',
              icon ? 'pl-9' : 'pl-3',
              trailing ? 'pr-9' : 'pr-3',
              'transition-[border-color,box-shadow] duration-control ease-out-expo',
              'focus:outline-none focus:ring-2 focus:ring-offset-0',
              'disabled:cursor-not-allowed disabled:opacity-55 disabled:bg-surfaceHover',
              error
                ? 'border-destructive focus:border-destructive focus:ring-destructive/25'
                : 'border-input hover:border-muted/60 focus:border-primary focus:ring-primary/25',
              className,
            ].join(' ')}
            {...props}
          />

          {trailing && (
            <span className="absolute inset-y-0 right-0 flex items-center pr-2">{trailing}</span>
          )}
        </div>

        {error ? (
          <p
            id={`${inputId}-error`}
            role="alert"
            className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-destructive"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden="true" />
            {error}
          </p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Input.displayName = 'Input';

export default Input;
