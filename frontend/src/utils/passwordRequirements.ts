import { PASSWORD_MIN_LENGTH } from '@eventreach/shared';

/**
 * Whether a candidate password satisfies one requirement from the shared
 * PASSWORD_REQUIREMENTS list.
 *
 * The authoritative check is `validatePassword` on the server; this only drives
 * the per-rule checklist, so the form can show which rule is still outstanding
 * instead of one combined error. Both Register and Change Password use it so
 * the two screens cannot disagree.
 */
export const meetsRequirement = (requirement: string, value: string): boolean => {
  if (!value) return false;
  if (requirement.includes('characters')) return value.length >= PASSWORD_MIN_LENGTH;
  if (requirement.includes('letter')) return /[A-Za-z]/.test(value);
  if (requirement.includes('number')) return /[0-9]/.test(value);
  return false;
};
