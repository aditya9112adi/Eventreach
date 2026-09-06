/**
 * Where the frontend lives.
 *
 * `FRONTEND_URL` is the supported way to configure this (comma-separate to allow
 * several CORS origins; the first entry is used to build links in outgoing
 * email). It is read in one place here so CORS, Socket.IO and email can never
 * disagree about which origin is current.
 *
 * If it is not set we fall back to a sensible default *for the current
 * environment*. Previously the email helper always fell back to localhost, which
 * meant an unset variable in production silently produced password-reset links
 * pointing at `http://localhost:5173` — the link looked fine but was unusable.
 */

export const DEV_FRONTEND_ORIGIN = 'http://localhost:5173';
export const PRODUCTION_FRONTEND_ORIGIN = 'https://eventreach-frontend-zeta.vercel.app';

const isProduction = () => process.env.NODE_ENV === 'production';

const parseConfigured = (): string[] =>
  (process.env.FRONTEND_URL || '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

/** Origins accepted by CORS and the Socket.IO handshake. */
export const getAllowedOrigins = (): string[] => {
  const configured = parseConfigured();
  if (configured.length > 0) return configured;
  return [DEV_FRONTEND_ORIGIN, PRODUCTION_FRONTEND_ORIGIN];
};

/**
 * Base URL used to build links in outgoing email (password reset, approval
 * notifications). Never returns a localhost URL when running in production.
 */
export const getFrontendBaseUrl = (): string => {
  const configured = parseConfigured();
  if (configured.length > 0) return configured[0];
  return isProduction() ? PRODUCTION_FRONTEND_ORIGIN : DEV_FRONTEND_ORIGIN;
};

/** True when the origin came from configuration rather than a built-in default. */
export const isFrontendUrlConfigured = (): boolean => parseConfigured().length > 0;
