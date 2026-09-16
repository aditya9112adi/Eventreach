export function getTotalPages(totalItems: number, rowsPerPage: number): number {
  if (rowsPerPage <= 0) return 0;
  return Math.ceil(totalItems / rowsPerPage);
}

export function getPaginatedData<T>(items: T[], currentPage: number, rowsPerPage: number): T[] {
  if (!items) return [];
  const start = (currentPage - 1) * rowsPerPage;
  const end = currentPage * rowsPerPage;
  return items.slice(start, end);
}

/**
 * The "#" shown for a row: its position in the full filtered, sorted result,
 * not its index within the page. Row 1 of page 2 at 40 rows per page is 41.
 *
 * `indexOnPage` is the row's index within the rows currently rendered. That is
 * the right input for both kinds of list in this app:
 *  - client-paginated lists render a slice that is already filtered and sorted,
 *    so the index within the slice plus the page offset is the overall position;
 *  - server-paginated lists receive a page the server already filtered and
 *    sorted, so the same arithmetic holds.
 * A list that is not paginated at all is simply page 1.
 */
export function getSerialNumber(currentPage: number, rowsPerPage: number, indexOnPage: number): number {
  const page = Number.isFinite(currentPage) && currentPage >= 1 ? Math.floor(currentPage) : 1;
  const size = Number.isFinite(rowsPerPage) && rowsPerPage >= 1 ? Math.floor(rowsPerPage) : 0;
  return (page - 1) * size + indexOnPage + 1;
}
