/**
 * Effective access status for a user/admin access record.
 *
 * The stored `status` field only records the approval decision; whether access
 * is actually usable right now also depends on cancellation and the access
 * window. Both the Just Access screen and the Access Report derive the status
 * from here so the two can never disagree.
 */
export type AccessStatus = 'Rejected' | 'Cancelled' | 'Scheduled' | 'Expired' | 'Active';

/** Every status, in the order the Access Report's Status filter offers them. */
export const ACCESS_STATUSES: ReadonlyArray<AccessStatus> = ['Active', 'Scheduled', 'Expired', 'Cancelled', 'Rejected'];

export const getAccessStatus = (record: any): AccessStatus => {
  if (record?.status === 'Rejected') return 'Rejected';
  if (record?.isAccessCancelled) return 'Cancelled';
  const now = new Date();
  if (record?.accessStartDate && now < new Date(record.accessStartDate)) return 'Scheduled';
  if (record?.accessExpiryDate && now > new Date(record.accessExpiryDate)) return 'Expired';
  return 'Active';
};

/**
 * The status an Access Report record was generated with: the server works it
 * out once, when the report is generated, and sends it as accessStatus. The
 * table, the Status filter and the downloads read that value, so a report
 * never recalculates a time-dependent status after it was generated. A record
 * without one (any other listing) falls back to deriving it here.
 */
export const accessStatusOf = (record: any): AccessStatus =>
  (ACCESS_STATUSES as ReadonlyArray<string>).includes(record?.accessStatus)
    ? (record.accessStatus as AccessStatus)
    : getAccessStatus(record);
