import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getTotalPages } from '../../utils/pagination';

interface Props {
  currentPage: number;
  rowsPerPage: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onRowsChange: (rows: number) => void;
}

export const PaginationControls = ({
  currentPage,
  rowsPerPage,
  totalItems,
  onPageChange,
  onRowsChange,
}: Props) => {
  const totalPages = getTotalPages(totalItems, rowsPerPage);
  const start = (currentPage - 1) * rowsPerPage + 1;
  const end = Math.min(currentPage * rowsPerPage, totalItems);

  if (totalItems === 0) return null;

  const navButton =
    'flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground ' +
    'transition-colors duration-micro hover:bg-surfaceHover ' +
    'disabled:opacity-40 disabled:pointer-events-none';

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col items-center justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row"
    >
      <div className="flex items-center gap-2 text-sm text-muted">
        <label htmlFor="rows-per-page">Rows per page</label>
        <select
          id="rows-per-page"
          value={rowsPerPage}
          onChange={(e) => onRowsChange(Number(e.target.value))}
          className="h-8 rounded-md border border-input bg-surface px-2 text-sm text-foreground transition-colors duration-control focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>

      <div className="flex items-center gap-4 text-sm text-muted">
        <span className="tabular-nums">
          {start}–{end} of {totalItems}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage === 1}
            aria-label="Previous page"
            className={navButton}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="min-w-[5.5rem] text-center text-sm font-medium tabular-nums text-foreground">
            Page {currentPage} of {Math.max(totalPages, 1)}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage === totalPages || totalPages === 0}
            aria-label="Next page"
            className={navButton}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
  );
};
