import axios from 'axios';
import { safeMetaError, type SafeMetaError } from './whatsappTemplateService';

/**
 * Every Meta Graph API call the WhatsApp Embedded Signup onboarding makes, in
 * one place, so each contract can be checked against Meta's current
 * documentation and corrected here without touching the flow.
 *
 * VERIFY BEFORE PRODUCTION. Meta's pages could not be opened from the
 * development machine (TLS to Meta's domains was intercepted); these were
 * checked against excerpts of the official pages (see
 * docs/whatsapp-embedded-signup.md). Confirmed there: the 30-second code and its
 * server-side exchange for a business integration system user token,
 * subscribed_apps, and register with { messaging_product, pin }. NOT confirmed:
 * the exact oauth/access_token parameters, and the phone_numbers / phone number
 * node field names. Each call names the doc it follows:
 *
 *   exchangeCodeForToken  GET  /oauth/access_token?client_id&client_secret&code
 *                         -> { access_token } (a business integration system
 *                         user token scoped to the assets the business granted)
 *                         [Embedded Signup: "Exchange the token code"]
 *   listWabaPhoneNumbers  GET  /{waba-id}/phone_numbers?fields=...
 *                         [WhatsApp Business Account > Phone Numbers]
 *   subscribeAppToWaba    POST /{waba-id}/subscribed_apps -> { success: true }
 *                         [Embedded Signup: "Subscribe to webhooks on the
 *                         customer's WABA"]
 *   registerPhoneNumber   POST /{phone-number-id}/register
 *                         { messaging_product: "whatsapp", pin } -> { success }
 *                         [Cloud API > Registration]
 *   getPhoneNumber        GET  /{phone-number-id}?fields=...
 *                         [Phone Number node]
 *
 * Tokens and the app secret travel only in the request (header or query, as
 * the endpoint requires) and are scrubbed from anything logged or returned.
 * Failures are classified for the caller: REJECTED (Meta said no; fix and
 * retry), AUTHENTICATION (credentials refused), RATE_LIMITED, UNAVAILABLE (no
 * answer or a server error: the outcome is unknown), MALFORMED (an answer that
 * could not be read).
 */

const TIMEOUT_MS = 30_000;
export const META_ID_PATTERN = /^\d{5,30}$/;

export type MetaOnboardingErrorKind = 'REJECTED' | 'AUTHENTICATION' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'MALFORMED';

export class MetaOnboardingError extends Error {
  readonly kind: MetaOnboardingErrorKind;
  readonly meta?: SafeMetaError;
  constructor(kind: MetaOnboardingErrorKind, message: string, meta?: SafeMetaError) {
    super(message);
    this.name = 'MetaOnboardingError';
    this.kind = kind;
    this.meta = meta;
  }
}

export interface MetaHttp {
  get: (url: string, options: { params?: Record<string, string>; headers?: Record<string, string>; timeout: number }) => Promise<{ data: any }>;
  post: (url: string, body: unknown, options: { headers?: Record<string, string>; timeout: number }) => Promise<{ data: any }>;
}

export interface MetaOnboardingConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
}

const defaultHttp: MetaHttp = {
  get: (url, options) => axios.get(url, options),
  post: (url, body, options) => axios.post(url, body, options),
};

const AUTH_CODES = new Set([190, 102, 10, 200, 3]);
const RATE_CODES = new Set([4, 17, 32, 613, 80007, 80008, 130429]);

const classify = (error: any, secrets: string[], action: string): MetaOnboardingError => {
  if (!error?.response) {
    console.error(`WhatsApp onboarding ${action}: no answer from Meta`, { code: error?.code });
    return new MetaOnboardingError('UNAVAILABLE', 'WhatsApp could not be reached. Try again shortly.');
  }
  const status: number = error.response.status;
  let meta: SafeMetaError | undefined;
  if (error.response.data?.error) {
    meta = safeMetaError(error.response.data.error);
    // Scrub every secret from anything that may be shown or logged.
    for (const secret of secrets) {
      if (!secret) continue;
      if (meta.message) meta.message = meta.message.split(secret).join('[REDACTED]');
      if (meta.details) meta.details = meta.details.split(secret).join('[REDACTED]');
    }
  }
  console.error(`WhatsApp onboarding ${action}: Meta returned an error`, { status, code: meta?.code, subcode: meta?.subcode, fbtraceId: meta?.fbtraceId });
  if (meta?.code !== undefined && RATE_CODES.has(meta.code)) return new MetaOnboardingError('RATE_LIMITED', 'WhatsApp rate limit reached. Try again later.', meta);
  if ((meta?.code !== undefined && AUTH_CODES.has(meta.code)) || status === 401 || status === 403) {
    return new MetaOnboardingError('AUTHENTICATION', 'WhatsApp refused the authorization. Start the connection again.', meta);
  }
  if (status >= 500) return new MetaOnboardingError('UNAVAILABLE', 'WhatsApp reported a server error. Try again shortly.', meta);
  return new MetaOnboardingError('REJECTED', meta?.message || 'WhatsApp refused the request.', meta);
};

const url = (config: MetaOnboardingConfig, path: string) => `https://graph.facebook.com/${config.apiVersion}/${path}`;

export interface MetaPhoneNumberNode {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: string | null;
  qualityRating: string | null;
  codeVerificationStatus: string | null;
  nameStatus: string | null;
  platformType: string | null;
}

const PHONE_FIELDS = 'id,display_phone_number,verified_name,status,quality_rating,code_verification_status,name_status,platform_type';

const str = (value: unknown, max = 200): string | null => (typeof value === 'string' && value ? value.slice(0, max) : null);

const toPhoneNode = (raw: any): MetaPhoneNumberNode | null => {
  const id = typeof raw?.id === 'string' || typeof raw?.id === 'number' ? String(raw.id) : '';
  if (!META_ID_PATTERN.test(id)) return null;
  return {
    id,
    displayPhoneNumber: str(raw.display_phone_number, 40),
    verifiedName: str(raw.verified_name, 200),
    status: str(raw.status, 40),
    qualityRating: str(raw.quality_rating, 20),
    codeVerificationStatus: str(raw.code_verification_status, 40),
    nameStatus: str(raw.name_status, 60),
    platformType: str(raw.platform_type, 40),
  };
};

export const createMetaOnboardingApi = (config: MetaOnboardingConfig, http: MetaHttp = defaultHttp) => {
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  return {
    /** The one-time code from the Embedded Signup popup, for a business token. Done server-side only. */
    async exchangeCodeForToken(code: string): Promise<string> {
      let data: any;
      try {
        ({ data } = await http.get(url(config, 'oauth/access_token'), {
          params: { client_id: config.appId, client_secret: config.appSecret, code },
          timeout: TIMEOUT_MS,
        }));
      } catch (error) {
        throw classify(error, [config.appSecret, code], 'code exchange');
      }
      const token = data?.access_token;
      if (typeof token !== 'string' || token.length < 20) throw new MetaOnboardingError('MALFORMED', 'WhatsApp returned no usable authorization.');
      return token;
    },

    /** The phone numbers the business token can see in that WABA - proof the asset was granted. */
    async listWabaPhoneNumbers(token: string, wabaId: string): Promise<MetaPhoneNumberNode[]> {
      const nodes: MetaPhoneNumberNode[] = [];
      let after: string | null = null;
      // Cursor paging (`after`), bounded: an account with more numbers than this is refused, not guessed at.
      for (let page = 0; page < 10; page += 1) {
        let data: any;
        try {
          ({ data } = await http.get(url(config, `${wabaId}/phone_numbers`), {
            params: { fields: PHONE_FIELDS, limit: '100', ...(after ? { after } : {}) },
            headers: bearer(token),
            timeout: TIMEOUT_MS,
          }));
        } catch (error) {
          throw classify(error, [token], 'phone number lookup');
        }
        if (!Array.isArray(data?.data)) throw new MetaOnboardingError('MALFORMED', 'WhatsApp returned a phone number list that could not be read.');
        nodes.push(...(data.data.map(toPhoneNode).filter(Boolean) as MetaPhoneNumberNode[]));
        const next = data?.paging?.cursors?.after;
        if (!data?.paging?.next || typeof next !== 'string' || !next) return nodes;
        after = next;
      }
      throw new MetaOnboardingError('MALFORMED', 'This WhatsApp Business Account lists more phone numbers than EventReach checks.');
    },

    /** Subscribes this app to the WABA's webhooks (message statuses for its numbers). */
    async subscribeAppToWaba(token: string, wabaId: string): Promise<void> {
      let data: any;
      try {
        ({ data } = await http.post(url(config, `${wabaId}/subscribed_apps`), {}, { headers: bearer(token), timeout: TIMEOUT_MS }));
      } catch (error) {
        throw classify(error, [token], 'webhook subscription');
      }
      if (data?.success !== true) throw new MetaOnboardingError('MALFORMED', 'WhatsApp did not confirm the webhook subscription.');
    },

    /** Registers the number with Cloud API using the business's two-step verification PIN. */
    async registerPhoneNumber(token: string, phoneNumberId: string, pin: string): Promise<void> {
      let data: any;
      try {
        ({ data } = await http.post(url(config, `${phoneNumberId}/register`), { messaging_product: 'whatsapp', pin }, { headers: bearer(token), timeout: TIMEOUT_MS }));
      } catch (error) {
        throw classify(error, [token, pin], 'registration');
      }
      if (data?.success !== true) throw new MetaOnboardingError('MALFORMED', 'WhatsApp did not confirm the registration.');
    },

    /** The number as Meta reports it now. */
    async getPhoneNumber(token: string, phoneNumberId: string): Promise<MetaPhoneNumberNode> {
      let data: any;
      try {
        ({ data } = await http.get(url(config, phoneNumberId), { params: { fields: PHONE_FIELDS }, headers: bearer(token), timeout: TIMEOUT_MS }));
      } catch (error) {
        throw classify(error, [token], 'phone number status');
      }
      const node = toPhoneNode(data);
      if (!node || node.id !== phoneNumberId) throw new MetaOnboardingError('MALFORMED', 'WhatsApp returned a different or unreadable phone number.');
      return node;
    },
  };
};

export type MetaOnboardingApi = ReturnType<typeof createMetaOnboardingApi>;
