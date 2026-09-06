import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary/secondary buttons for the page, right-aligned. */
  actions?: React.ReactNode;
  /** Renders a "back" link above the title. */
  backTo?: string;
  backLabel?: string;
  className?: string;
}

/**
 * The consistent top block of every page: optional back link, title, one line
 * of context, and the page's actions. Pages should not hand-roll this again.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
  backTo,
  backLabel = 'Back',
  className = '',
}) => (
  <div className={`mb-6 ${className}`}>
    {backTo && (
      <Link
        to={backTo}
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted transition-colors duration-micro hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        {backLabel}
      </Link>
    )}
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-h1 font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  </div>
);

export default PageHeader;
