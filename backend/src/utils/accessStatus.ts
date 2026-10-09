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
