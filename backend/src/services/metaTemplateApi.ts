import axios from 'axios';
import { safeMetaError, type SafeMetaError } from './whatsappTemplateService';
import { readWhatsAppConnection, type WhatsAppConnection } from './whatsappConnection';

/**
 * The WhatsApp Business Management API calls for templates [Meta]:
 *   POST /{WABA_ID}/message_templates  -> { id, status, category }
 *   GET  /{WABA_ID}/message_templates?name=…  -> { data: [{ id, name, language, status, category, … }] }
 *
 * The token travels only in the Authorization header. Nothing from the request
 * or the axios error object is logged or returned - only Meta's own error
 * fields, scrubbed of the token (safeMetaError).
 *
 * Every failure is classified by what it means for a retry:
 *   REJECTED        Meta answered with an error: nothing was created. Fix and retry.
 *   AUTHENTICATION  the server's credentials were refused: nothing was created.
 *   RATE_LIMITED    Meta's limit: nothing was created. Retry later.
 *   CONFIGURATION   EventReach has no token or WABA id: nothing was sent.
 *   AMBIGUOUS       no answer, or a server error: Meta MAY have created the
 *                   template. Never resubmit - reconcile with a lookup first.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export type MetaTemplateErrorKind = 'REJECTED' | 'AUTHENTICATION' | 'RATE_LIMITED' | 'CONFIGURATION' | 'AMBIGUOUS';

const AUTHENTICATION_CODES = new Set([190, 102, 10, 200, 3]);
/**
 * [Meta, Graph API rate limiting] 80008: the WhatsApp Business Management API
 * limit (templates). 4, 17, 613: app, user and custom limits. 80007 and
 * 130429: the messaging limits, kept from the send path.
 */
const RATE_LIMIT_CODES = new Set([4, 17, 613, 80007, 80008, 130429]);

export class MetaTemplateApiError extends Error {
  readonly kind: MetaTemplateErrorKind;
  readonly meta?: SafeMetaError;
  readonly httpStatus?: number;

  constructor(kind: MetaTemplateErrorKind, message: string, options: { meta?: SafeMetaError; httpStatus?: number } = {}) {
    super(message);
    this.name = 'MetaTemplateApiError';
    this.kind = kind;
    this.meta = options.meta;
    this.httpStatus = options.httpStatus;
  }
}

export type MetaHttpPost = (url: string, body: unknown, options: { headers: Record<string, string>; timeout: number }) => Promise<{ data: any }>;
export type MetaHttpGet = (
  url: string,
  options: { headers: Record<string, string>; params: Record<string, string>; timeout: number }
) => Promise<{ data: any }>;

export interface MetaTemplateApiDeps {
  post?: MetaHttpPost;
  get?: MetaHttpGet;
  connection?: WhatsAppConnection;
}

export interface MetaTemplateNode {
  id: string;
  name: string;
  language: string;
  status: string | null;
  category: string | null;
}

const requireConnection = (deps: MetaTemplateApiDeps) => {
  const connection = deps.connection ?? readWhatsAppConnection();
  const missing = [!connection.accessToken ? 'WHATSAPP_TOKEN' : null, !connection.wabaId ? 'WHATSAPP_WABA_ID' : null].filter(Boolean);
  if (missing.length > 0) {
    // Names only - never values.
    throw new MetaTemplateApiError('CONFIGURATION', `WhatsApp template management is not configured on the server (missing ${missing.join(', ')}).`);
  }
  return connection as Required<Pick<WhatsAppConnection, 'accessToken' | 'wabaId'>> & WhatsAppConnection;
};

const classify = (error: any, accessToken: string, action: string): MetaTemplateApiError => {
  const httpStatus: number | undefined = error?.response?.status;
  const metaError = error?.response?.data?.error;

  if (!error?.response) {
    // Timeout, DNS, connection reset: the request may or may not have arrived.
    const timedOut = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
    console.error(`WhatsApp template ${action}: no response from Meta`, { code: error?.code });
    return new MetaTemplateApiError('AMBIGUOUS', timedOut ? 'WhatsApp did not respond in time.' : 'Could not reach WhatsApp.');
  }

  const meta = metaError ? safeMetaError(metaError, accessToken) : undefined;
  console.error(`WhatsApp template ${action}: Meta returned an error`, {
    httpStatus,
    code: meta?.code,
    subcode: meta?.subcode,
    fbtraceId: meta?.fbtraceId,
  });

  if (meta?.code !== undefined && AUTHENTICATION_CODES.has(meta.code)) {
    return new MetaTemplateApiError('AUTHENTICATION', 'WhatsApp rejected the server credentials. The access token may be expired, revoked or missing a permission.', { meta, httpStatus });
  }
  if ((meta?.code !== undefined && RATE_LIMIT_CODES.has(meta.code)) || httpStatus === 429) {
    return new MetaTemplateApiError('RATE_LIMITED', 'WhatsApp rate limit reached. Try again later.', { meta, httpStatus });
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new MetaTemplateApiError('AUTHENTICATION', 'WhatsApp rejected the server credentials. The access token may be expired, revoked or missing a permission.', { meta, httpStatus });
  }
  // A server-side failure says nothing reliable about whether the template
  // was created, so it is treated like no answer at all.
  if (httpStatus === undefined || httpStatus >= 500) {
    return new MetaTemplateApiError('AMBIGUOUS', 'WhatsApp reported a server error.', { meta, httpStatus });
  }
  return new MetaTemplateApiError('REJECTED', meta?.message || 'WhatsApp rejected the template.', { meta, httpStatus });
};

const graphUrl = (connection: WhatsAppConnection, path: string) => `https://graph.facebook.com/${connection.apiVersion}/${path}`;

/** Creates a template. The returned status is Meta's, usually PENDING. */
export const createMetaTemplate = async (payload: unknown, deps: MetaTemplateApiDeps = {}) => {
  const connection = requireConnection(deps);
  const post = deps.post ?? (axios.post as unknown as MetaHttpPost);

  let data: any;
  try {
    const response = await post(graphUrl(connection, `${connection.wabaId}/message_templates`), payload, {
      headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response?.data;
  } catch (error: any) {
    throw classify(error, connection.accessToken, 'create');
  }

  const id = data?.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '') {
    // Meta answered 2xx without an id: something may have been created.
    throw new MetaTemplateApiError('AMBIGUOUS', 'WhatsApp accepted the request but returned no template id.');
  }
  return {
    id: String(id),
    status: typeof data?.status === 'string' ? data.status : null,
    category: typeof data?.category === 'string' ? data.category : null,
  };
};

/**
 * Every language version of a template name in the account. Meta documents
 * read-after-write for this edge, so a template created moments ago is listed.
 */
export const findMetaTemplatesByName = async (name: string, deps: MetaTemplateApiDeps = {}): Promise<MetaTemplateNode[]> => {
  const connection = requireConnection(deps);
  const get = deps.get ?? (axios.get as unknown as MetaHttpGet);

  let data: any;
  try {
    const response = await get(graphUrl(connection, `${connection.wabaId}/message_templates`), {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      params: { name, fields: 'id,name,language,status,category', limit: '50' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response?.data;
  } catch (error: any) {
    throw classify(error, connection.accessToken, 'lookup');
  }

  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  return list
    // Meta's name filter is not documented as exact; match exactly here.
    .filter((t) => t?.name === name && typeof t?.language === 'string' && (typeof t?.id === 'string' || typeof t?.id === 'number'))
    .map((t) => ({
      id: String(t.id),
      name: t.name,
      language: t.language,
      status: typeof t.status === 'string' ? t.status : null,
      category: typeof t.category === 'string' ? t.category : null,
    }));
};

/** Meta template ids are numeric strings. */
export const META_TEMPLATE_ID_PATTERN = /^\d{1,30}$/;

export interface MetaTemplateStatusNode extends MetaTemplateNode {
  rejectedReason: string | null;
}

/**
 * One template by its id [Meta: GET /{WHATSAPP-MESSAGE-TEMPLATE-ID}, fields
 * id, name, language, status, category, rejected_reason]. A read: nothing is
 * created, edited or deleted. The answer is returned as Meta gave it; the
 * caller checks that it is the template it asked for.
 */
export const getMetaTemplateById = async (templateId: string, deps: MetaTemplateApiDeps = {}): Promise<MetaTemplateStatusNode> => {
  if (!META_TEMPLATE_ID_PATTERN.test(templateId)) {
    // Never sent: an id of the wrong form is a local data problem.
    throw new MetaTemplateApiError('CONFIGURATION', 'The stored WhatsApp template id is not valid.');
  }
  const connection = requireConnection(deps);
  const get = deps.get ?? (axios.get as unknown as MetaHttpGet);

  let data: any;
  try {
    const response = await get(graphUrl(connection, templateId), {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      params: { fields: 'id,name,language,status,category,rejected_reason' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response?.data;
  } catch (error: any) {
    throw classify(error, connection.accessToken, 'status lookup');
  }

  return {
    id: typeof data?.id === 'string' || typeof data?.id === 'number' ? String(data.id) : '',
    name: typeof data?.name === 'string' ? data.name : '',
    language: typeof data?.language === 'string' ? data.language : '',
    status: typeof data?.status === 'string' ? data.status : null,
    category: typeof data?.category === 'string' ? data.category : null,
    rejectedReason: typeof data?.rejected_reason === 'string' ? data.rejected_reason : null,
  };
};
