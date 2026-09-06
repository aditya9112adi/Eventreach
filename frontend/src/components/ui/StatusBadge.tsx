import React from 'react';
import { Badge, type BadgeVariant } from './Badge';

/**
 * Single source of truth for status colour.
 *
 * Every page was mapping its own statuses to colours, so the same word could
 * be amber on one screen and green on another. Keys are lower-cased on lookup
 * so backend casing changes cannot silently fall through to the grey default.
 */
const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  // Account / access
  active: 'success',
  approved: 'success',
  pending: 'warning',
  rejected: 'error',
  cancelled: 'neutral',
  canceled: 'neutral',
  expired: 'neutral',
  suspended: 'error',
  scheduled: 'info',

  // Events
  upcoming: 'info',
  ongoing: 'primary',
  completed: 'success',

  // Campaigns and messages
  draft: 'neutral',
  queued: 'warning',
  sending: 'primary',
  sent: 'success',
  delivered: 'success',
  read: 'success',
  failed: 'error',
  undelivered: 'error',

  // Roles
  superadmin: 'primary',
  admin: 'info',
  user: 'neutral',
};

interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: string | null;
  size?: 'sm' | 'md';
  dot?: boolean;
  /** Text to show when `status` is empty. */
  fallback?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  size = 'md',
  dot = false,
  fallback = 'Unknown',
  ...props
}) => {
  const label = status?.trim() || fallback;
  const variant = STATUS_VARIANTS[label.toLowerCase().replace(/\s+/g, '')] ?? 'default';

  return (
    <Badge variant={variant} size={size} dot={dot} {...props}>
      {label}
    </Badge>
  );
};

export default StatusBadge;
