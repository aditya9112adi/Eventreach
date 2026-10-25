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

// ── account listing ─────────────────────────────────────────────────────────

/** One template of the account, as Meta lists it. Only what the UI shows. */
export interface MetaAccountTemplate extends MetaTemplateStatusNode {
  headerFormat: string | null;
  headerText: string | null;
  bodyText: string | null;
  footerText: string | null;
  buttons: { type: string; text: string }[];
}

export const ACCOUNT_PAGE_SIZE_DEFAULT = 25;
export const ACCOUNT_PAGE_SIZE_MAX = 100;
/**
 * Meta's paging cursors are opaque base64-like strings. One is only ever passed
 * back from a previous answer, so anything of another shape is refused rather
 * than forwarded into a request.
 */
export const META_CURSOR_PATTERN = /^[A-Za-z0-9+/=_.-]{1,512}$/;

const clip = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.slice(0, max) : null);

const summarizeAccountTemplate = (t: any): MetaAccountTemplate | null => {
  const idOk = typeof t?.id === 'string' || typeof t?.id === 'number';
  if (!idOk || typeof t?.name !== 'string' || typeof t?.language !== 'string') return null;
  const components: any[] = Array.isArray(t.components) ? t.components : [];
  const part = (type: string) => components.find((c) => c?.type === type);
  const header = part('HEADER');
  const buttons: any[] = Array.isArray(part('BUTTONS')?.buttons) ? part('BUTTONS').buttons : [];
  return {
    id: String(t.id),
    name: t.name.slice(0, 512),
    language: t.language.slice(0, 20),
    status: typeof t.status === 'string' ? t.status : null,
    category: typeof t.category === 'string' ? t.category : null,
    rejectedReason: typeof t.rejected_reason === 'string' ? t.rejected_reason : null,
    headerFormat: clip(header?.format, 20),
    headerText: clip(header?.text, 1024),
    bodyText: clip(part('BODY')?.text, 1100),
    footerText: clip(part('FOOTER')?.text, 120),
    // Type and label only: a link's address and a phone number are not needed to list.
    buttons: buttons.filter((b) => typeof b?.type === 'string').map((b) => ({ type: String(b.type).slice(0, 30), text: clip(b.text, 60) ?? '' })),
  };
};

/**
 * One page of the account's templates [Meta: GET /{WABA_ID}/message_templates,
 * fields id,name,language,status,category,components, cursor paging with
 * `after`]. A read: nothing is created or changed. An entry that does not look
 * like a template is skipped and counted, never guessed at. The next cursor is
 * returned only when Meta says there is a next page.
 */
export const listMetaTemplates = async (
  options: { after?: string | null; limit?: number } = {},
  deps: MetaTemplateApiDeps = {}
): Promise<{ templates: MetaAccountTemplate[]; nextCursor: string | null; skipped: number }> => {
  if (options.after && !META_CURSOR_PATTERN.test(options.after)) {
    throw new MetaTemplateApiError('CONFIGURATION', 'The page cursor is not valid.');
  }
  const connection = requireConnection(deps);
  const get = deps.get ?? (axios.get as unknown as MetaHttpGet);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? ACCOUNT_PAGE_SIZE_DEFAULT) || ACCOUNT_PAGE_SIZE_DEFAULT, 1), ACCOUNT_PAGE_SIZE_MAX);

  let data: any;
  try {
    const response = await get(graphUrl(connection, `${connection.wabaId}/message_templates`), {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      params: {
        fields: 'id,name,language,status,category,rejected_reason,components',
        limit: String(limit),
        ...(options.after ? { after: options.after } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response?.data;
  } catch (error: any) {
    throw classify(error, connection.accessToken, 'list');
  }

  if (!Array.isArray(data?.data)) {
    throw new MetaTemplateApiError('AMBIGUOUS', 'WhatsApp returned a template list that could not be read.');
  }
  const templates: MetaAccountTemplate[] = [];
  let skipped = 0;
  for (const entry of data.data) {
    const summary = summarizeAccountTemplate(entry);
    if (summary) templates.push(summary);
    else skipped += 1;
  }
  const after = data?.paging?.cursors?.after;
  const nextCursor = data?.paging?.next && typeof after === 'string' && META_CURSOR_PATTERN.test(after) ? after : null;
  return { templates, nextCursor, skipped };
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

// ── one template with its components, for linking ───────────────────────────

export interface MetaTemplateButton {
  type: string;
  text: string;
  url: string | null;
  phoneNumber: string | null;
}

/** A template's components as Meta holds them, reduced to what EventReach can store and send. */
export interface MetaTemplateComponents {
  /** "POSITIONAL" ({{1}}) or "NAMED" ({{guest_name}}); null when Meta did not say. */
  parameterFormat: string | null;
  /** Component types other than HEADER, BODY, FOOTER and BUTTONS (carousels, limited-time offers, ...). */
  otherComponents: string[];
  headerFormat: string | null;
  headerText: string | null;
  bodyText: string | null;
  /** The first example row Meta holds for a numbered body, in placeholder order. */
  bodyExamples: string[];
  footerText: string | null;
  buttons: MetaTemplateButton[];
}

export interface MetaTemplateForLink extends MetaTemplateStatusNode {
  components: MetaTemplateComponents;
}

const KNOWN_COMPONENTS = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);

const upper = (value: unknown): string | null => (typeof value === 'string' && value ? value.toUpperCase() : null);
const plain = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.slice(0, max) : null);

/** Pure: reads Meta's `components` (and `parameter_format`) without guessing or dropping what it cannot place. */
export const parseTemplateComponents = (data: any): MetaTemplateComponents => {
  const components: any[] = Array.isArray(data?.components) ? data.components : [];
  const typeOf = (c: any) => upper(c?.type) ?? 'UNKNOWN';
  const part = (type: string) => components.find((c) => typeOf(c) === type);
  const header = part('HEADER');
  const body = part('BODY');
  const footer = part('FOOTER');
  const buttons: any[] = Array.isArray(part('BUTTONS')?.buttons) ? part('BUTTONS').buttons : [];
  const row = body?.example?.body_text;

  return {
    parameterFormat: upper(data?.parameter_format),
    otherComponents: [...new Set(components.map(typeOf).filter((t) => !KNOWN_COMPONENTS.has(t)))],
    headerFormat: header ? upper(header.format) ?? 'UNKNOWN' : null,
    headerText: header ? plain(header.text, 5000) : null,
    bodyText: plain(body?.text, 5000),
    bodyExamples: Array.isArray(row) && Array.isArray(row[0]) ? row[0].filter((x: unknown): x is string => typeof x === 'string') : [],
    footerText: plain(footer?.text, 5000),
    buttons: buttons.map((b) => ({
      type: upper(b?.type) ?? 'UNKNOWN',
      text: plain(b?.text, 200) ?? '',
      url: plain(b?.url, 2000),
      phoneNumber: plain(b?.phone_number, 40),
    })),
  };
};

/**
 * One template by its id, with its components [Meta: GET /{WHATSAPP-MESSAGE-TEMPLATE-ID}, fields id, name, language,
 * status, category, rejected_reason, parameter_format, components]. A READ: nothing is created, edited or deleted.
 * The answer is returned as Meta gave it; the caller checks that it is the template it asked for and that it belongs
 * to the configured account.
 */
export const getMetaTemplateForLink = async (templateId: string, deps: MetaTemplateApiDeps = {}): Promise<MetaTemplateForLink> => {
  if (!META_TEMPLATE_ID_PATTERN.test(templateId)) {
    throw new MetaTemplateApiError('CONFIGURATION', 'The WhatsApp template id is not valid.');
  }
  const connection = requireConnection(deps);
  const get = deps.get ?? (axios.get as unknown as MetaHttpGet);

  let data: any;
  try {
    const response = await get(graphUrl(connection, templateId), {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      params: { fields: 'id,name,language,status,category,rejected_reason,parameter_format,components' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response?.data;
  } catch (error: any) {
    throw classify(error, connection.accessToken, 'template lookup');
  }

  return {
    id: typeof data?.id === 'string' || typeof data?.id === 'number' ? String(data.id) : '',
    name: typeof data?.name === 'string' ? data.name : '',
    language: typeof data?.language === 'string' ? data.language : '',
    status: typeof data?.status === 'string' ? data.status : null,
    category: typeof data?.category === 'string' ? data.category : null,
    rejectedReason: typeof data?.rejected_reason === 'string' ? data.rejected_reason : null,
    components: parseTemplateComponents(data),
  };
};
