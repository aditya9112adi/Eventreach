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

/**
 * Extra exact origins that may call the API, from CORS_EXTRA_ORIGINS
 * (comma-separated) - for example one Vercel preview deployment, whose address
 * is not FRONTEND_URL. They are added to FRONTEND_URL (or the defaults) for CORS
 * and Socket.IO only, and are never used to build email links.
 *
 * Each entry must be a bare origin the project controls: https (http only for
 * localhost), no wildcard, no credentials, and no path, query or fragment. An
 * entry that is not is ignored, never guessed at, and reported by position and
 * reason only - its text is not echoed, in case it held something that should
 * not be logged. There is deliberately no pattern support: allowing
 * "*.vercel.app" would trust every site anyone hosts there.
 */
export const EXTRA_ORIGINS_ENV = 'CORS_EXTRA_ORIGINS';

export interface ExtraOriginsReport {
  /** The accepted origins, in canonical form (scheme://host[:port]), without duplicates. */
  origins: string[];
  /** Entries that were refused: 1-based position and why, never the entry itself. */
  ignored: { position: number; reason: string }[];
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export const parseExtraOrigins = (raw: string | undefined): ExtraOriginsReport => {
  const origins: string[] = [];
  const ignored: ExtraOriginsReport['ignored'] = [];
  (raw || '').split(',').forEach((entry, index) => {
    const value = entry.trim().replace(/\/+$/, '');
    if (!value) return; // a trailing comma is not an entry
    const position = index + 1;
    const ignore = (reason: string) => { ignored.push({ position, reason }); };

    if (value.includes('*')) return ignore('wildcards are not allowed');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return ignore('not a valid URL');
    }
    const local = LOCAL_HOSTNAMES.has(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return ignore('must be https (http is allowed only for localhost)');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return ignore('must be a bare origin: no credentials, path, query or fragment');
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  });
  return { origins, ignored };
};

export const getExtraOriginsReport = (): ExtraOriginsReport => parseExtraOrigins(process.env[EXTRA_ORIGINS_ENV]);

/**
 * Origins accepted by CORS and the Socket.IO handshake: FRONTEND_URL (or the
 * built-in defaults), then any extra origins from CORS_EXTRA_ORIGINS.
 */
export const getAllowedOrigins = (): string[] => {
  const configured = parseConfigured();
  const base = configured.length > 0 ? configured : [DEV_FRONTEND_ORIGIN, PRODUCTION_FRONTEND_ORIGIN];
  return [...base, ...getExtraOriginsReport().origins.filter((origin) => !base.includes(origin))];
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
