import React from 'react';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Tailwind width class, e.g. "w-32" or "w-full". */
  width?: string;
  /** Tailwind height class, e.g. "h-4". */
  height?: string;
  rounded?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  width = 'w-full',
  height = 'h-4',
  rounded = 'rounded-md',
  className = '',
  ...props
}) => (
  <div
    className={`skeleton ${width} ${height} ${rounded} ${className}`}
    aria-hidden="true"
    {...props}
  />
);

/** Placeholder rows for a table body, matched to the real column count. */
export const SkeletonTable: React.FC<{ rows?: number; columns?: number }> = ({
  rows = 5,
  columns = 4,
}) => (
  <div role="status" aria-label="Loading" className="divide-y divide-border">
    {Array.from({ length: rows }).map((_, r) => (
      <div key={r} className="flex items-center gap-4 px-4 py-3.5">
        {Array.from({ length: columns }).map((_, c) => (
          <Skeleton
            key={c}
            // The first column is usually a name, so make it visibly wider.
            className={c === 0 ? 'flex-[2]' : 'flex-1'}
            width=""
            height="h-3.5"
          />
        ))}
      </div>
    ))}
  </div>
);

/** Placeholder for a row of stat tiles. */
export const SkeletonStats: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div
    role="status"
    aria-label="Loading"
    className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
  >
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="card p-5">
        <Skeleton width="w-24" height="h-3" />
        <Skeleton width="w-16" height="h-7" className="mt-3" />
      </div>
    ))}
  </div>
);

/** Generic block placeholder for cards and panels. */
export const SkeletonCard: React.FC<{ lines?: number; className?: string }> = ({
  lines = 3,
  className = '',
}) => (
  <div role="status" aria-label="Loading" className={`card p-5 ${className}`}>
    <Skeleton width="w-1/3" height="h-4" />
    <div className="mt-4 space-y-2.5">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? 'w-2/3' : 'w-full'} height="h-3" />
      ))}
    </div>
  </div>
);

export default Skeleton;
