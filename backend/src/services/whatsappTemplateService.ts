import axios from 'axios';
import { normalizeIndianPhone } from '../utils/indianPhone';
import { WhatsAppSendError } from './WhatsAppService';

/**
 * Sends one approved WhatsApp message template through the Cloud API.
 *
 * Deliberately generic: it takes the template's positional variables as an
 * ordered list ({{1}}, {{2}}, …), so any approved template can be sent without
 * changes here. The mapping from named fields to positions for a particular
 * template belongs to the caller (see controllers/whatsappController.ts).
 *
 * Configuration is read from the environment on every call, never cached, and
 * uses the SAME variables as the existing WhatsAppService — no second set of
 * WhatsApp credentials to configure or keep in step:
 *   WHATSAPP_TOKEN        secret, backend only — never logged or returned
 *   WHATSAPP_PHONE_ID     the sending number's Phone Number ID
 *   WHATSAPP_API_VERSION  Graph API version, default v22.0
 *
 * Security: the token only ever appears in the Authorization header of the
 * outgoing request. Nothing from the request config, headers or axios error
 * object is logged or returned — only Meta's own error fields, which are also
 * scrubbed of the token as a precaution.
 */

const DEFAULT_API_VERSION = 'v22.0';
const REQUEST_TIMEOUT_MS = 30_000;

/** Meta template names: lowercase letters, digits and underscores. */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** Language codes as Meta uses them: "en", "en_US", "pt_BR", "fil". */
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;
const MAX_VARIABLES = 100;
const MAX_VARIABLE_LENGTH = 1024;

export interface TemplateMessageInput {
  to: unknown;
  templateName: unknown;
  languageCode: unknown;
  /** Positional values: variables[0] fills {{1}}, variables[1] fills {{2}}, … */
  variables: unknown;
}

export interface TemplateMessageResult {
  success: true;
  /** WhatsApp's message id ("wamid.…"), the key the delivery webhook uses. */
  messageId: string;
  /**
   * Meta's acceptance status — normally "accepted". This means Meta took the
   * message, not that it reached the handset; delivery arrives later on the
   * webhook.
   */
  status: string;
  /** The WhatsApp ID Meta resolved the recipient to, if returned. */
  recipient: string | null;
}

export type TemplateErrorCategory =
  | 'VALIDATION_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'TEMPLATE_NOT_AVAILABLE'
  | 'TEMPLATE_PARAMETER_ERROR'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'AUTHENTICATION_ERROR'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'META_API_ERROR';

/** The parts of Meta's error that are safe and useful to pass on. */
export interface SafeMetaError {
  code?: number;
  subcode?: number;
  type?: string;
  message?: string;
  details?: string;
  fbtraceId?: string;
}

/**
 * A failed template send. Extends the existing WhatsAppSendError so code that
 * already understands WhatsApp failures keeps working.
 *
 * `httpStatus` is what this API should answer with. A Meta authentication
 * failure maps to 502, never 401/403 — the frontend treats 401 as "your
 * session expired" and would log the Super Admin out for a server-side
 * credential problem.
 */
export class WhatsAppTemplateError extends WhatsAppSendError {
  readonly category: TemplateErrorCategory;
  readonly httpStatus: number;
  readonly field?: string;
  readonly meta?: SafeMetaError;

  constructor(
    category: TemplateErrorCategory,
    message: string,
    httpStatus: number,
    options: { field?: string; meta?: SafeMetaError } = {}
  ) {
    super(message, options.meta?.code, options.meta?.details);
    this.name = 'WhatsAppTemplateError';
    this.category = category;
    this.httpStatus = httpStatus;
    this.field = options.field;
    this.meta = options.meta;
  }

  /** The error body this API returns. Contains nothing secret. */
  toResponse() {
    return {
      success: false as const,
      error: {
        code: this.category,
        message: this.message,
        ...(this.field ? { field: this.field } : {}),
        ...(this.meta ? { meta: this.meta } : {}),
      },
    };
  }
}

// ── configuration ────────────────────────────────────────────────────────────

export interface TemplateConfig {
  accessToken?: string;
  phoneNumberId?: string;
  apiVersion: string;
}

export const readTemplateConfig = (env: NodeJS.ProcessEnv = process.env): TemplateConfig => ({
  accessToken: env.WHATSAPP_TOKEN?.trim() || undefined,
  phoneNumberId: env.WHATSAPP_PHONE_ID?.trim() || undefined,
  apiVersion: env.WHATSAPP_API_VERSION?.trim() || DEFAULT_API_VERSION,
});

// ── validation ───────────────────────────────────────────────────────────────

export interface ValidatedTemplateMessage {
  /** E.164, e.g. "+919876543210". */
  to: string;
  templateName: string;
  languageCode: string;
  variables: string[];
}

const invalid = (field: string, message: string) =>
  new WhatsAppTemplateError('VALIDATION_ERROR', message, 400, { field });

export const validateTemplateMessage = (input: TemplateMessageInput): ValidatedTemplateMessage => {
  if (input.to === undefined || input.to === null || (typeof input.to === 'string' && !input.to.trim())) {
    throw invalid('to', 'Recipient phone number is required.');
  }
  // One phone rule for the whole app: 9876543210, 919876543210 and
  // +919876543210 all become +919876543210; anything else is rejected.
  const phone = normalizeIndianPhone(input.to);
  if (!phone.ok) throw invalid('to', `Invalid recipient phone number: ${phone.reason}`);

  if (typeof input.templateName !== 'string' || !input.templateName.trim()) {
    throw invalid('templateName', 'Template name is required.');
  }
  const templateName = input.templateName.trim();
  if (!TEMPLATE_NAME_PATTERN.test(templateName)) {
    throw invalid('templateName', 'Template name may contain only lowercase letters, digits and underscores.');
  }

  if (typeof input.languageCode !== 'string' || !input.languageCode.trim()) {
    throw invalid('languageCode', 'Template language code is required.');
  }
  const languageCode = input.languageCode.trim();
  if (!LANGUAGE_CODE_PATTERN.test(languageCode)) {
    throw invalid('languageCode', 'Template language code must look like "en" or "en_US".');
  }

  if (!Array.isArray(input.variables)) {
    throw invalid('variables', 'Template variables must be a list of values in {{1}}, {{2}}, … order.');
  }
  if (input.variables.length > MAX_VARIABLES) {
    throw invalid('variables', `A template takes at most ${MAX_VARIABLES} variables.`);
  }

  const variables = input.variables.map((value, i) => {
    const field = `variables[${i}]`;
    if (typeof value !== 'string') throw invalid(field, `Template variable {{${i + 1}}} must be text.`);
    const text = value.trim();
    if (!text) throw invalid(field, `Template variable {{${i + 1}}} must not be empty.`);
    if (text.length > MAX_VARIABLE_LENGTH) {
      throw invalid(field, `Template variable {{${i + 1}}} must be at most ${MAX_VARIABLE_LENGTH} characters.`);
    }
    // Meta refuses template parameters containing new lines, tabs or more than
    // four consecutive spaces (error 132018). Catching it here gives a clear
    // message instead of a rejected send.
    if (/[\n\r\t]/.test(text) || / {5,}/.test(text)) {
      throw invalid(field, `Template variable {{${i + 1}}} must not contain line breaks, tabs or more than four spaces in a row.`);
    }
    return text;
  });

  return { to: phone.e164, templateName, languageCode, variables };
};

// ── payload ──────────────────────────────────────────────────────────────────

/** The Cloud API body for a template message. Variables keep their order. */
export const buildTemplatePayload = (message: ValidatedTemplateMessage) => ({
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: message.to,
  type: 'template',
  template: {
    name: message.templateName,
    language: { code: message.languageCode },
    ...(message.variables.length > 0
      ? {
          components: [
            {
              type: 'body',
              parameters: message.variables.map((text) => ({ type: 'text', text })),
            },
          ],
        }
      : {}),
  },
});

// ── Meta error handling ──────────────────────────────────────────────────────

/** Template missing, not approved yet (e.g. still In review), paused or disabled. */
const TEMPLATE_NOT_AVAILABLE = new Set([132001, 132015, 132016]);
/** Wrong number or format of parameters for the template. */
const TEMPLATE_PARAMETER = new Set([132000, 132005, 132007, 132012, 132018, 131008, 131009]);
/** Recipient not reachable — e.g. not on a test number's allowed list. */
const RECIPIENT_NOT_ALLOWED = new Set([131030, 131026]);
/** Token expired, revoked or lacking permission. */
const AUTHENTICATION = new Set([190, 102, 10, 200, 3]);
/** Throughput or pair-rate limits. */
const RATE_LIMITED = new Set([4, 80007, 130429, 131048, 131056]);

/** Removes the token from any text before it can be logged or returned. */
const scrub = (text: unknown, secret?: string): string | undefined => {
  if (typeof text !== 'string') return undefined;
  return secret ? text.split(secret).join('[REDACTED]') : text;
};

const safeMetaError = (metaError: any, secret?: string): SafeMetaError => ({
  ...(typeof metaError?.code === 'number' ? { code: metaError.code } : {}),
  ...(typeof metaError?.error_subcode === 'number' ? { subcode: metaError.error_subcode } : {}),
  ...(typeof metaError?.type === 'string' ? { type: metaError.type } : {}),
  ...(scrub(metaError?.message, secret) ? { message: scrub(metaError.message, secret) } : {}),
  ...(scrub(metaError?.error_data?.details, secret) ? { details: scrub(metaError.error_data.details, secret) } : {}),
  ...(typeof metaError?.fbtrace_id === 'string' ? { fbtraceId: metaError.fbtrace_id } : {}),
});

const classifyMetaError = (meta: SafeMetaError, templateName: string, languageCode: string): WhatsAppTemplateError => {
  const code = meta.code ?? -1;
  if (TEMPLATE_NOT_AVAILABLE.has(code)) {
    return new WhatsAppTemplateError(
      'TEMPLATE_NOT_AVAILABLE',
      `WhatsApp could not use template "${templateName}" (${languageCode}). It does not exist in that language, ` +
        'or it is not approved yet — a template that is still In review, paused or disabled cannot be sent.',
      422,
      { meta }
    );
  }
  if (TEMPLATE_PARAMETER.has(code)) {
    return new WhatsAppTemplateError(
      'TEMPLATE_PARAMETER_ERROR',
      `WhatsApp rejected the variables for template "${templateName}" — check their number and format.`,
      422,
      { meta }
    );
  }
  if (RECIPIENT_NOT_ALLOWED.has(code)) {
    return new WhatsAppTemplateError(
      'RECIPIENT_NOT_ALLOWED',
      'WhatsApp could not deliver to this recipient. A test phone number can only message numbers on its allowed list.',
      422,
      { meta }
    );
  }
  if (AUTHENTICATION.has(code)) {
    return new WhatsAppTemplateError(
      'AUTHENTICATION_ERROR',
      'WhatsApp rejected the server credentials. The access token may be expired, revoked or missing a permission.',
      502,
      { meta }
    );
  }
  if (RATE_LIMITED.has(code)) {
    return new WhatsAppTemplateError('RATE_LIMITED', 'WhatsApp rate limit reached. Try again shortly.', 429, { meta });
  }
  return new WhatsAppTemplateError('META_API_ERROR', meta.message || 'WhatsApp rejected the message.', 502, { meta });
};

// ── send ─────────────────────────────────────────────────────────────────────

/** The HTTP call, injectable so tests never reach Meta. Defaults to axios. */
export type TemplateHttpPost = (
  url: string,
  body: unknown,
  options: { headers: Record<string, string>; timeout: number }
) => Promise<{ data: any }>;

export interface SendTemplateDeps {
  post?: TemplateHttpPost;
  config?: TemplateConfig;
}

export const sendTemplateMessage = async (
  input: TemplateMessageInput,
  deps: SendTemplateDeps = {}
): Promise<TemplateMessageResult> => {
  const message = validateTemplateMessage(input);

  const config = deps.config ?? readTemplateConfig();
  const missing = [
    !config.accessToken ? 'WHATSAPP_TOKEN' : null,
    !config.phoneNumberId ? 'WHATSAPP_PHONE_ID' : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    // Names only — never values.
    throw new WhatsAppTemplateError(
      'CONFIGURATION_ERROR',
      `WhatsApp is not configured on the server (missing ${missing.join(', ')}).`,
      503
    );
  }

  const post = deps.post ?? (axios.post as TemplateHttpPost);
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;

  let data: any;
  try {
    const response = await post(url, buildTemplatePayload(message), {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response?.data;
  } catch (error: any) {
    const metaError = error?.response?.data?.error;
    if (metaError) {
      const classified = classifyMetaError(
        safeMetaError(metaError, config.accessToken),
        message.templateName,
        message.languageCode
      );
      // Meta's own fields only — never the request, its headers or the token.
      console.error('WhatsApp template send rejected:', {
        category: classified.category,
        code: classified.meta?.code,
        subcode: classified.meta?.subcode,
        fbtraceId: classified.meta?.fbtraceId,
      });
      throw classified;
    }

    // No Meta response at all: timeout, DNS, connection refused.
    const isTimeout = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
    console.error('WhatsApp template send failed before reaching Meta:', { code: error?.code });
    throw new WhatsAppTemplateError(
      'NETWORK_ERROR',
      isTimeout ? 'WhatsApp did not respond in time.' : 'Could not reach WhatsApp.',
      504
    );
  }

  const messageId = data?.messages?.[0]?.id;
  if (typeof messageId !== 'string' || !messageId) {
    throw new WhatsAppTemplateError('META_API_ERROR', 'WhatsApp accepted the request but returned no message id.', 502);
  }

  return {
    success: true,
    messageId,
    status: typeof data?.messages?.[0]?.message_status === 'string' ? data.messages[0].message_status : 'accepted',
    recipient: typeof data?.contacts?.[0]?.wa_id === 'string' ? data.contacts[0].wa_id : null,
  };
};
