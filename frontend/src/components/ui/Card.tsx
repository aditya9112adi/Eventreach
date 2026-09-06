import React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Adds a hover lift. Only use when the whole card is clickable. */
  interactive?: boolean;
  /** Removes the default inner padding so headers/tables can sit flush. */
  flush?: boolean;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className = '', interactive = false, flush = false, children, ...props }, ref) => (
    <div
      ref={ref}
      className={[
        interactive ? 'card-interactive' : 'card',
        flush ? '' : 'p-5',
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </div>
  )
);
Card.displayName = 'Card';

// `title` is widened from the DOM's string-only attribute to a node.
interface CardHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons or filters aligned to the right of the title. */
  actions?: React.ReactNode;
}

export const CardHeader: React.FC<CardHeaderProps> = ({
  title,
  description,
  actions,
  className = '',
  ...props
}) => (
  <div
    className={`flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4 ${className}`}
    {...props}
  >
    <div className="min-w-0">
      <h2 className="text-h3 font-semibold text-foreground truncate">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </div>
);

export const CardBody: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <div className={`p-5 ${className}`} {...props}>
    {children}
  </div>
);

export const CardFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <div
    className={`flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3 ${className}`}
    {...props}
  >
    {children}
  </div>
);

export default Card;
