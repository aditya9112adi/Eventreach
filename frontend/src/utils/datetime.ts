/**
 * Consistent date/time formatting.
 *
 * The backend always stores UTC instants (Mongoose `timestamps`, plus explicit
 * server-generated `Date`s for approval/rejection). Formatting happens in one
 * place here so every screen renders identically.
 *
 * The month name and AM/PM marker are built explicitly rather than via
 * `toLocaleString`: locale data differs between engines and ICU versions (for
 * example en-GB renders September as "Sept", and some builds insert a narrow
 * no-break space before AM/PM), which would make the output inconsistent across
 * browsers. The local-time getters are still used, so timestamps display in the
 * viewer's own timezone.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const toDate = (value?: string | Date | null): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** e.g. "05 Sep 2026" */
export const formatDate = (value?: string | Date | null, fallback = 'N/A'): string => {
  const d = toDate(value);
  if (!d) return fallback;
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/** e.g. "07:30 PM" */
export const formatTime = (value?: string | Date | null, fallback = 'N/A'): string => {
  const d = toDate(value);
  if (!d) return fallback;
  const hours24 = d.getHours();
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${pad(hours12)}:${pad(d.getMinutes())} ${suffix}`;
};

/** e.g. "05 Sep 2026, 07:30 PM" */
export const formatDateTime = (value?: string | Date | null, fallback = 'N/A'): string => {
  const d = toDate(value);
  if (!d) return fallback;
  return `${formatDate(d)}, ${formatTime(d)}`;
};

/**
 * Compact stamp for download file names, e.g. "21082026" for 21 Aug 2026.
 *
 * Deliberately digits-only: file names travel through email, Windows Explorer
 * and object storage, where spaces and punctuation cause trouble.
 */
export const formatFileStamp = (value: string | Date = new Date()): string => {
  const d = toDate(value) ?? new Date();
  return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}`;
};
