/**
 * Effective access status for a user/admin access record.
 *
 * The stored `status` field only records the approval decision; whether access
 * is actually usable right now also depends on cancellation and the access
 * window. Both the Just Access screen and the Access Report derive the status
 * from here so the two can never disagree.
 */
export type AccessStatus = 'Rejected' | 'Cancelled' | 'Scheduled' | 'Expired' | 'Active';

export const getAccessStatus = (record: any): AccessStatus => {
  if (record?.status === 'Rejected') return 'Rejected';
  if (record?.isAccessCancelled) return 'Cancelled';
  const now = new Date();
  if (record?.accessStartDate && now < new Date(record.accessStartDate)) return 'Scheduled';
  if (record?.accessExpiryDate && now > new Date(record.accessExpiryDate)) return 'Expired';
  return 'Active';
};
