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

export interface TemplateDefinition {
  name: string;
  languageCode: string;
  /** Meta's review status, e.g. "APPROVED", "PENDING", "REJECTED". */
  status: string | null;
  /** The approved body text, still containing {{1}}, {{2}}, … */
  bodyText: string;
  /** How many distinct placeholders the body uses. */
  placeholderCount: number;
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

  const body = (chosen.components || []).find(
    (c: any) => typeof c?.type === 'string' && c.type.toUpperCase() === 'BODY'
  );
  const bodyText = typeof body?.text === 'string' ? body.text : '';
  if (!bodyText) return null;

  return {
    name: chosen.name,
    languageCode: chosen.language,
    status: typeof chosen.status === 'string' ? chosen.status : null,
    bodyText,
    placeholderCount: countPlaceholders(bodyText),
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
