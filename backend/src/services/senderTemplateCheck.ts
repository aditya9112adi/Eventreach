import axios from 'axios';
import { WhatsAppSender } from '../models/WhatsAppSender';
import { EventTemplateError } from './eventTemplateMessage';
import { selectTemplate, type CatalogHttpGet } from './whatsappTemplateCatalog';
import type { DeclaredHeaderFormat } from './eventTemplateMessage';

/**
 * Message templates belong to one WhatsApp Business Account. EventReach's
 * template catalog and its approved templates live in the configured account
 * (WHATSAPP_WABA_ID); a number a business connected itself (Embedded Signup)
 * sends from THAT business's account, which has its own templates.
 *
 * So before a template is sent from a connected number, the template is looked
 * up in the number's own account, with its own credential, and must be there
 * APPROVED, in exactly the language EventReach sends, taking the same number of
 * body values and the same kind of header EventReach fills. Otherwise the whole
 * request is refused - before any upload or message - with a reason the person
 * can act on. Nothing is created, submitted or approved here, and the send never
 * switches to another sender to get around it.
 *
 * Read per request (one Graph call), never cached across requests, so an
 * approval or a pause at Meta takes effect on the next send.
 *
 * [Meta] GET /{waba-id}/message_templates?name=…&fields=name,language,status,components
 * - the same call the catalog makes for the configured account.
 */

const TIMEOUT_MS = 15_000;

export interface SenderTemplateCheck {
  senderId: string;
  accessToken: string;
  templateName: string;
  languageCode: string;
  /** How many body values EventReach fills for this template. */
  expectedPlaceholders: number;
  /** The media header EventReach fills, when the template declares one. */
  headerFormat?: DeclaredHeaderFormat;
}

const NOTHING_SENT = 'Nothing was sent.';

export const assertTemplateUsableFromSender = async (check: SenderTemplateCheck, deps: { get?: CatalogHttpGet; apiVersion?: string } = {}) => {
  const sender: any = await WhatsAppSender.findById(check.senderId).select('wabaId displayPhoneNumber').lean();
  if (!sender) throw new EventTemplateError('SENDER_UNAVAILABLE', `The assigned WhatsApp sender no longer exists. ${NOTHING_SENT}`, 409);
  const where = `the WhatsApp Business Account of ${sender.displayPhoneNumber}`;
  const name = `"${check.templateName}" (${check.languageCode})`;

  const get = deps.get ?? (axios.get as unknown as CatalogHttpGet);
  const apiVersion = deps.apiVersion ?? (process.env.WHATSAPP_API_VERSION?.trim() || 'v22.0');
  let list: any[];
  try {
    const response = await get(`https://graph.facebook.com/${apiVersion}/${sender.wabaId}/message_templates`, {
      headers: { Authorization: `Bearer ${check.accessToken}` },
      params: { name: check.templateName, fields: 'name,language,status,components', limit: '50' },
      timeout: TIMEOUT_MS,
    });
    list = Array.isArray(response?.data?.data) ? response.data.data : [];
  } catch (error: any) {
    // Meta's code only - never the request, its headers or the token.
    console.warn('WhatsApp template check for a connected sender failed:', { code: error?.response?.data?.error?.code ?? error?.code });
    throw new EventTemplateError('TEMPLATE_CHECK_FAILED', `Could not confirm template ${name} with WhatsApp for ${where}. ${NOTHING_SENT} Try again shortly.`, 502, 'templateName');
  }

  // Exactly this language: "en" and "en_US" are different templates to Meta, and
  // a message names the language it sends.
  const exact = list.filter((t) => t?.language === check.languageCode);
  const definition = selectTemplate(exact, check.templateName, check.languageCode);
  if (!definition) {
    throw new EventTemplateError(
      'TEMPLATE_NOT_IN_SENDER_ACCOUNT',
      `Template ${name} does not exist in ${where}. Templates belong to one WhatsApp Business Account: create it there and get it approved, or assign a different sender to this event. ${NOTHING_SENT}`,
      409,
      'templateName'
    );
  }
  if (definition.status !== 'APPROVED') {
    throw new EventTemplateError(
      'TEMPLATE_NOT_APPROVED_IN_SENDER_ACCOUNT',
      `Template ${name} is ${definition.status ?? 'not approved'} in ${where}, so it cannot be sent from that number yet. ${NOTHING_SENT}`,
      409,
      'templateName'
    );
  }
  if (definition.placeholderCount !== check.expectedPlaceholders) {
    throw new EventTemplateError(
      'TEMPLATE_MISMATCH_IN_SENDER_ACCOUNT',
      `Template ${name} in ${where} takes ${definition.placeholderCount} value(s), but EventReach fills ${check.expectedPlaceholders}. Align the template there before sending. ${NOTHING_SENT}`,
      409,
      'templateName'
    );
  }
  const theirs = definition.header && definition.header.format !== 'TEXT' ? definition.header.format : null;
  const ours = check.headerFormat ?? null;
  if (theirs !== ours || (definition.header?.format === 'TEXT' && definition.header.required)) {
    throw new EventTemplateError(
      'TEMPLATE_MISMATCH_IN_SENDER_ACCOUNT',
      `Template ${name} in ${where} has a ${theirs ? `${theirs.toLowerCase()} header` : definition.header?.required ? 'text header with a placeholder' : 'different header'}, which differs from what EventReach sends${ours ? ` (a ${ours.toLowerCase()} header)` : ''}. ${NOTHING_SENT}`,
      409,
      'templateName'
    );
  }
};
