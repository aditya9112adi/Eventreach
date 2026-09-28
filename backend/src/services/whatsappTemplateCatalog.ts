import axios from 'axios';
import { readTemplateConfig, type TemplateConfig } from './whatsappTemplateService';

/**
 * Reads an approved template's own body text from Meta, so the Composer can
 * preview what the guest will actually receive instead of wording invented in
 * this codebase.
 *
 * This is a read-only lookup on the WhatsApp Business Account. It is optional:
 * without WHATSAPP_WABA_ID (or if Meta refuses the read) it returns null and
 * the caller falls back to showing the resolved {{1}}…{{5}} values on their
 * own. Sending never depends on it.
 *
 * Same credentials as everything else here — WHATSAPP_TOKEN, WHATSAPP_WABA_ID,
 * WHATSAPP_API_VERSION. The token travels only in the Authorization header and
 * is never logged or returned.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Header formats Meta allows on a template. There is no audio header. */
export type TemplateHeaderFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';

/** The media header formats this application can fill. */
export const MEDIA_HEADER_FORMATS = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const;
export type MediaHeaderFormat = (typeof MEDIA_HEADER_FORMATS)[number];

export const isMediaHeaderFormat = (format: unknown): format is MediaHeaderFormat =>
  typeof format === 'string' && (MEDIA_HEADER_FORMATS as readonly string[]).includes(format);

export interface TemplateHeader {
  format: TemplateHeaderFormat;
  /** TEXT headers only: the approved text, still containing {{1}} if it has one. */
  text?: string;
  /** Placeholders in a TEXT header. Media headers carry no text. */
  placeholderCount: number;
  /**
   * Whether a header parameter must be supplied on every send.
   *
   * A media header always needs one — the example image Meta reviewed is not
   * what gets sent. A TEXT header only needs one if it contains a placeholder.
   */
  required: boolean;
}

export interface TemplateDefinition {
  name: string;
  languageCode: string;
  /** Meta's review status, e.g. "APPROVED", "PENDING", "REJECTED". */
  status: string | null;
  /** The approved body text, still containing {{1}}, {{2}}, … */
  bodyText: string;
  /** How many distinct placeholders the body uses. Body only — never the header. */
  placeholderCount: number;
  /** The approved header, or null when the template has none. */
  header: TemplateHeader | null;
}

export type CatalogHttpGet = (
  url: string,
  options: { headers: Record<string, string>; params: Record<string, string>; timeout: number }
) => Promise<{ data: any }>;

export interface CatalogDeps {
  get?: CatalogHttpGet;
  config?: TemplateConfig & { wabaId?: string };
  now?: () => number;
}

export const readCatalogConfig = (env: NodeJS.ProcessEnv = process.env) => ({
  ...readTemplateConfig(env),
  wabaId: env.WHATSAPP_WABA_ID?.trim() || undefined,
});

const cache = new Map<string, { at: number; value: TemplateDefinition | null }>();

/** Exported for tests; also lets a deployment drop a stale definition. */
export const clearTemplateCatalogCache = () => cache.clear();

export const countPlaceholders = (bodyText: string): number => {
  const seen = new Set<number>();
  for (const match of bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    seen.add(Number(match[1]));
  }
  return seen.size;
};

/**
 * The HEADER component, if the template has one.
 *
 * Meta already returns this in `components` — it was previously discarded,
 * which is why a media template could not be sent: its header parameter was
 * never built, and Meta rejected the message for a missing parameter.
 */
const readHeader = (component: any): TemplateHeader | null => {
  const format = typeof component?.format === 'string' ? component.format.toUpperCase() : '';
  if (!format) return null;

  if (format === 'TEXT') {
    const text = typeof component.text === 'string' ? component.text : '';
    const placeholderCount = countPlaceholders(text);
    return { format: 'TEXT', text, placeholderCount, required: placeholderCount > 0 };
  }

  return {
    format: format as TemplateHeaderFormat,
    placeholderCount: 0,
    // A media header is filled per message, so it is always required.
    required: isMediaHeaderFormat(format),
  };
};

/** Picks the requested language out of Meta's list of template versions. */
export const selectTemplate = (
  list: any[],
  name: string,
  languageCode: string
): TemplateDefinition | null => {
  const matches = (list || []).filter(
    (t) => t?.name === name && typeof t?.language === 'string'
  );
  const exact = matches.find((t) => t.language === languageCode);
  // "en" and "en_US" are different templates to Meta but the same to a user
  // picking "English", so fall back to the same base language.
  const base = languageCode.split('_')[0];
  const chosen = exact ?? matches.find((t) => t.language.split('_')[0] === base);
  if (!chosen) return null;

  const components: any[] = Array.isArray(chosen.components) ? chosen.components : [];
  const componentOfType = (type: string) =>
    components.find((c: any) => typeof c?.type === 'string' && c.type.toUpperCase() === type);

  const body = componentOfType('BODY');
  const bodyText = typeof body?.text === 'string' ? body.text : '';
  if (!bodyText) return null;

  return {
    name: chosen.name,
    languageCode: chosen.language,
    status: typeof chosen.status === 'string' ? chosen.status : null,
    bodyText,
    placeholderCount: countPlaceholders(bodyText),
    header: readHeader(componentOfType('HEADER')),
  };
};

export const fetchTemplateDefinition = async (
  name: string,
  languageCode: string,
  deps: CatalogDeps = {}
): Promise<TemplateDefinition | null> => {
  const config = deps.config ?? readCatalogConfig();
  if (!config.accessToken || !config.wabaId) return null;

  const now = deps.now ?? Date.now;
  const key = `${config.wabaId}:${name}:${languageCode}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;

  const get = deps.get ?? (axios.get as unknown as CatalogHttpGet);
  let value: TemplateDefinition | null = null;
  try {
    const response = await get(
      `https://graph.facebook.com/${config.apiVersion}/${config.wabaId}/message_templates`,
      {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        params: { name, fields: 'name,language,status,components', limit: '20' },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
    value = selectTemplate(response?.data?.data, name, languageCode);
  } catch (error: any) {
    // Meta's own code only — never the request, its headers or the token. The
    // preview degrades to the variable list; sending is unaffected.
    console.warn('WhatsApp template lookup failed:', {
      code: error?.response?.data?.error?.code ?? error?.code,
    });
    value = null;
  }

  cache.set(key, { at: now(), value });
  return value;
};
