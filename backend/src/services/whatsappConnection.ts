import { readCatalogConfig } from './whatsappTemplateCatalog';

/**
 * The WhatsApp Business Account connection EventReach uses.
 *
 * There is exactly one, configured in the server environment - the same
 * variables every WhatsApp call already reads:
 *   WHATSAPP_TOKEN        secret, backend only
 *   WHATSAPP_PHONE_ID     the default sender's Phone Number ID (message sends)
 *   WHATSAPP_WABA_ID      the WhatsApp Business Account ID (templates)
 *   WHATSAPP_API_VERSION  Graph API version
 *
 * A WABA ID and a Phone Number ID are different resources: templates belong to
 * the WABA, messages are sent from a phone number. Nothing here is read from,
 * or ever written to, the database.
 */
export interface WhatsAppConnection {
  wabaId?: string;
  phoneNumberId?: string;
  accessToken?: string;
  apiVersion: string;
}

export const readWhatsAppConnection = (env: NodeJS.ProcessEnv = process.env): WhatsAppConnection => {
  const config = readCatalogConfig(env);
  return {
    wabaId: config.wabaId,
    phoneNumberId: config.phoneNumberId,
    accessToken: config.accessToken,
    apiVersion: config.apiVersion,
  };
};

/** The last four characters, for recognising an id without showing it. */
const hint = (value?: string): string | null => (value ? `…${value.slice(-4)}` : null);

export interface WhatsAppConnectionStatus {
  /**
   * `simulated` is what WhatsAppService does without a token and phone id:
   * campaign sends are faked. Shown so an operator can never mistake it for a
   * working connection.
   */
  mode: 'live' | 'simulated';
  configured: {
    accessToken: boolean;
    phoneNumberId: boolean;
    wabaId: boolean;
    appSecret: boolean;
    verifyToken: boolean;
  };
  apiVersion: string;
  phoneNumberIdHint: string | null;
  wabaIdHint: string | null;
}

/**
 * Safe to return to a Super Admin: whether each setting is present, never its
 * value. The token, app secret and verify token are reported as booleans only.
 */
export const describeWhatsAppConnection = (env: NodeJS.ProcessEnv = process.env): WhatsAppConnectionStatus => {
  const connection = readWhatsAppConnection(env);
  const present = (name: string) => Boolean(env[name]?.trim());
  return {
    mode: connection.accessToken && connection.phoneNumberId ? 'live' : 'simulated',
    configured: {
      accessToken: Boolean(connection.accessToken),
      phoneNumberId: Boolean(connection.phoneNumberId),
      wabaId: Boolean(connection.wabaId),
      appSecret: present('WHATSAPP_APP_SECRET'),
      verifyToken: present('WHATSAPP_VERIFY_TOKEN'),
    },
    apiVersion: connection.apiVersion,
    phoneNumberIdHint: hint(connection.phoneNumberId),
    wabaIdHint: hint(connection.wabaId),
  };
};
