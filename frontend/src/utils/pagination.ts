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
