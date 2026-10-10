/**
 * Effective access status of a User/Admin access record - the server's copy
 * of frontend/src/utils/accessStatus.ts, so the Access Report's Status filter
 * can run on the server (over the queried, role-scoped records) and agree with
 * what the page shows.
 *
 * The stored `status` field only records the approval decision; whether access
 * is usable right now also depends on cancellation and the access window. The
 * two copies are held identical by tests/accessStatusParity.test.ts.
 */
export const ACCESS_STATUSES = ['Active', 'Scheduled', 'Expired', 'Cancelled', 'Rejected'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export const getAccessStatus = (record: any, now: Date = new Date()): AccessStatus => {
  if (record?.status === 'Rejected') return 'Rejected';
  if (record?.isAccessCancelled) return 'Cancelled';
  if (record?.accessStartDate && now < new Date(record.accessStartDate)) return 'Scheduled';
  if (record?.accessExpiryDate && now > new Date(record.accessExpiryDate)) return 'Expired';
  return 'Active';
};

/**
 * The statuses a typed Status search means: each status matched from the start
 * of a word, case-insensitively - "act" finds Active, "valid" finds Valid but
 * never Invalid. The same rule as the page's matchesStatusWord
 * (frontend/src/utils/reportSearch.ts), held identical by the parity test.
 */
export const statusesMatching = (statuses: readonly string[], typed: string): string[] => {
  const wanted = typed.trim().toLowerCase();
  if (!wanted) return [...statuses];
  return statuses.filter((status) => {
    const value = status.toLowerCase();
    return value.startsWith(wanted) || value.split(/[^a-z0-9]+/).some((word) => word.startsWith(wanted));
  });
};
