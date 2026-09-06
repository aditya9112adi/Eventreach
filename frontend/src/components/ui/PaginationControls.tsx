import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getTotalPages } from '../../utils/pagination';

interface Props {
  currentPage: number;
  rowsPerPage: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onRowsChange: (rows: number) => void;
}

export const PaginationControls = ({ currentPage, rowsPerPage, totalItems, onPageChange, onRowsChange }: Props) => {
  const totalPages = getTotalPages(totalItems, rowsPerPage);
  const start = (currentPage - 1) * rowsPerPage + 1;
  const end = Math.min(currentPage * rowsPerPage, totalItems);

  if (totalItems === 0) return null;

  return (
    <div className="p-4 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4 bg-surface/30">
      <div className="flex items-center gap-2 text-sm text-foreground/70">
        <span>Rows per page:</span>
        <select
          value={rowsPerPage}
          onChange={(e) => onRowsChange(Number(e.target.value))}
          className="bg-surface border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:border-white/40"
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>
      <div className="flex items-center gap-4 text-sm text-foreground/70">
        <span>{start}-{end} of {totalItems}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage === 1}
            className="p-1 rounded hover:bg-surfaceHover text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="px-3 py-1 font-medium text-sm border border-border rounded bg-surface/50">{currentPage}</span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage === totalPages || totalPages === 0}
            className="p-1 rounded hover:bg-surfaceHover text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
