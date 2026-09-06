import { PASSWORD_MIN_LENGTH } from '@eventreach/shared';

/**
 * Whether a candidate password satisfies one requirement from the shared
 * PASSWORD_REQUIREMENTS list.
 *
 * The authoritative check is `validatePassword`, which the backend runs on
 * every request; this only drives the per-rule checklist in the UI so someone
 * can see which rule is still outstanding instead of one combined error.
 * Change Password and the Super Admin reset dialog both use it so the two
 * screens cannot disagree about what a valid password looks like.
 */
export const meetsRequirement = (requirement: string, value: string): boolean => {
  if (!value) return false;
  if (requirement.includes('characters')) return value.length >= PASSWORD_MIN_LENGTH;
  if (requirement.includes('letter')) return /[A-Za-z]/.test(value);
  if (requirement.includes('number')) return /[0-9]/.test(value);
  return false;
};
