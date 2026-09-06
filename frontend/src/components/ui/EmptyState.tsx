import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './Button';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  /** One line explaining why it is empty and what to do next. */
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Secondary action, e.g. "Clear filters". */
  secondaryLabel?: string;
  onSecondary?: () => void;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  className = '',
}) => (
  <div className={`flex flex-col items-center justify-center px-6 py-14 text-center ${className}`}>
    {Icon && (
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surfaceHover">
        <Icon className="h-5 w-5 text-muted" aria-hidden="true" />
      </div>
    )}
    <h3 className="text-md font-semibold text-foreground">{title}</h3>
    {description && <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>}
    {(actionLabel || secondaryLabel) && (
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {actionLabel && onAction && <Button onClick={onAction}>{actionLabel}</Button>}
        {secondaryLabel && onSecondary && (
          <Button variant="secondary" onClick={onSecondary}>
            {secondaryLabel}
          </Button>
        )}
      </div>
    )}
  </div>
);

interface ErrorStateProps {
  title?: string;
  /** Safe, human-readable message. Never render a raw server payload here. */
  message?: string;
  onRetry?: () => void;
  className?: string;
}

/** The failure counterpart of EmptyState: says what broke and offers a retry. */
export const ErrorState: React.FC<ErrorStateProps> = ({
  title = "That didn't load",
  message = 'Something went wrong while fetching this data. Please try again.',
  onRetry,
  className = '',
}) => (
  <div
    role="alert"
    className={`flex flex-col items-center justify-center px-6 py-14 text-center ${className}`}
  >
    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
      <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
    </div>
    <h3 className="text-md font-semibold text-foreground">{title}</h3>
    <p className="mt-1.5 max-w-sm text-sm text-muted">{message}</p>
    {onRetry && (
      <Button variant="secondary" className="mt-5" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Try again
      </Button>
    )}
  </div>
);

export default EmptyState;
