import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp } from 'lucide-react';

export type StatTone = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';

const TONES: Record<StatTone, string> = {
  default: 'bg-surfaceHover text-muted',
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-destructive/10 text-destructive',
  info: 'bg-info/10 text-info',
};

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  tone?: StatTone;
  /** Small caption under the value, e.g. "vs. last week". */
  hint?: string;
  /** Percentage change. Positive renders green, negative red. */
  delta?: number;
  onClick?: () => void;
  className?: string;
}

export const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  icon: Icon,
  tone = 'default',
  hint,
  delta,
  onClick,
  className = '',
}) => {
  const interactive = typeof onClick === 'function';
  const Root = interactive ? 'button' : 'div';

  return (
    <Root
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={[
        interactive ? 'card-interactive text-left' : 'card',
        'p-5',
        interactive ? 'cursor-pointer' : '',
        className,
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="label-caption">{label}</p>
        {Icon && (
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
      </div>

      <p className="mt-3 text-h1 font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </p>

      {(hint || typeof delta === 'number') && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
          {typeof delta === 'number' && (
            <span
              className={`inline-flex items-center gap-0.5 font-medium ${
                delta >= 0 ? 'text-success' : 'text-destructive'
              }`}
            >
              {delta >= 0 ? (
                <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {Math.abs(delta)}%
            </span>
          )}
          {hint && <span className="text-muted">{hint}</span>}
        </div>
      )}
    </Root>
  );
};

export default StatCard;
