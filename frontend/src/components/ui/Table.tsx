import React from 'react';

/**
 * Table shell.
 *
 * The wrapper is the only element that scrolls horizontally, which keeps wide
 * tables from forcing the whole page sideways on small screens.
 */
export const TableWrapper: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <div className={`w-full overflow-x-auto ${className}`} {...props}>
    {children}
  </div>
);

export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <table className={`w-full border-collapse text-left text-sm ${className}`} {...props}>
    {children}
  </table>
);

export const THead: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <thead className={`bg-surfaceHover/60 ${className}`} {...props}>
    {children}
  </thead>
);

interface ThProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
}

export const Th: React.FC<ThProps> = ({ className = '', align = 'left', children, ...props }) => (
  <th
    scope="col"
    className={[
      'whitespace-nowrap border-b border-border px-4 py-2.5',
      'text-caption font-semibold uppercase tracking-wider text-muted',
      align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
      className,
    ].join(' ')}
    {...props}
  >
    {children}
  </th>
);

export const TBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <tbody className={`divide-y divide-border ${className}`} {...props}>
    {children}
  </tbody>
);

interface TrProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Adds hover feedback and a pointer cursor for clickable rows. */
  interactive?: boolean;
}

export const Tr: React.FC<TrProps> = ({ className = '', interactive = false, children, ...props }) => (
  <tr
    className={[
      'transition-colors duration-micro',
      interactive ? 'cursor-pointer hover:bg-surfaceHover' : 'hover:bg-surfaceHover/60',
      className,
    ].join(' ')}
    {...props}
  >
    {children}
  </tr>
);

interface TdProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  /** Renders the cell in the body text colour instead of muted. */
  emphasis?: boolean;
}

export const Td: React.FC<TdProps> = ({
  className = '',
  align = 'left',
  emphasis = false,
  children,
  ...props
}) => (
  <td
    className={[
      'px-4 py-3 align-middle',
      emphasis ? 'font-medium text-foreground' : 'text-foreground/80',
      align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
      className,
    ].join(' ')}
    {...props}
  >
    {children}
  </td>
);

export default Table;
