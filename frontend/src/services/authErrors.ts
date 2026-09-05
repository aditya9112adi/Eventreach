/**
 * Decide whether a failed response means the stored session is no longer valid
 * and should be cleared.
 *
 * A 401 from the sign-in / registration endpoints means "these credentials are
 * wrong", not "your session expired". Treating those as session expiry caused a
 * full page reload that wiped the Login screen's error message, so a failed
 * sign-in looked like the form silently resetting.
 *
 * Extracted from the axios interceptor so it can be unit tested without a DOM.
 */
export const shouldClearSession = (status: number | undefined, url: string): boolean => {
  if (status !== 401) return false;
  const isCredentialAttempt = url.includes('/auth/login') || url.includes('/auth/register');
  return !isCredentialAttempt;
};
