import React from 'react';

export type BadgeVariant =
  | 'default'
  | 'neutral'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'primary';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  /** Shows a small filled dot before the label — useful for live statuses. */
  dot?: boolean;
}

/**
 * All variants use a tinted background plus a matching border so they stay
 * legible on both the light and dark surfaces without a second palette.
 */
const VARIANTS: Record<BadgeVariant, string> = {
  default: 'bg-surfaceHover text-foreground border-border',
  neutral: 'bg-muted/10 text-muted border-muted/25',
  success: 'bg-success/10 text-success border-success/25',
  warning: 'bg-warning/10 text-warning border-warning/25',
  error: 'bg-destructive/10 text-destructive border-destructive/25',
  info: 'bg-info/10 text-info border-info/25',
  primary: 'bg-primary/10 text-primary border-primary/25',
};

const SIZES = {
  sm: 'px-1.5 py-0.5 text-caption gap-1',
  md: 'px-2 py-0.5 text-xs gap-1.5',
};

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  size = 'md',
  dot = false,
  className = '',
  ...props
}) => (
  <span
    className={[
      'inline-flex items-center rounded-full border font-medium whitespace-nowrap',
      SIZES[size],
      VARIANTS[variant],
      className,
    ].join(' ')}
    {...props}
  >
    {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
    {children}
  </span>
);

export default Badge;
