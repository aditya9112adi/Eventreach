import axios from 'axios';
import fs from 'fs';

/**
 * Outcome of handing one message to WhatsApp.
 *
 * `wamid` is WhatsApp's own message id. It is the ONLY key the delivery
 * webhook sends back, so without storing it a later "delivered"/"read"/
 * "failed" callback cannot be matched to a recipient.
 */
export interface WhatsAppSendResult {
  /** "wamid.…", or null if Meta accepted the call without returning one. */
  wamid: string | null;
  raw: any;
}

/** Carries Meta's own error code so a report can show why a send was refused. */
export class WhatsAppSendError extends Error {
  readonly code?: number;
  readonly details?: string;

  constructor(message: string, code?: number, details?: string) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.code = code;
    this.details = details;
  }
}

/** An attachment that has already been uploaded to Meta and has a media ID. */
export interface PreparedMedia {
  metaMediaId: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  filename: string;
  supportsCaption: boolean;
}

const prepared = (a: any): PreparedMedia | null =>
  a && typeof a.metaMediaId === 'string' && a.metaMediaId
    ? {
        metaMediaId: a.metaMediaId,
        kind: a.type,
        filename: a.filename,
        supportsCaption: a.supportsCaption !== false && a.type !== 'audio',
      }
    : null;

const textPayload = (to: string, body: string) => ({
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: to.replace('+', ''),
  type: 'text',
  text: { preview_url: false, body },
});

/**
 * The media object for one attachment. `document` additionally carries the
 * original filename, which is what the recipient sees and downloads as —
 * without it WhatsApp shows the opaque media ID.
 */
const mediaObject = (media: PreparedMedia, caption?: string) => {
  const body: any = { id: media.metaMediaId };
  if (media.kind === 'document') body.filename = media.filename;
  if (caption && media.supportsCaption) body.caption = caption;
  return body;
};

/**
 * The single message that represents this campaign to one recipient.
 *
 * With no media it is the campaign text. With media it is the first
 * attachment, carrying the text as a caption where the type allows one.
 */
export const buildPrimaryPayload = (to: string, messageText: string, attachments: any[] = []) => {
  const first = (attachments || []).map(prepared).find(Boolean) as PreparedMedia | undefined;
  if (!first) return textPayload(to, messageText || '');

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace('+', ''),
    type: first.kind,
    [first.kind]: mediaObject(first, messageText || undefined),
  };
};

/**
 * Messages the primary could not absorb: the campaign text when the primary
 * was an audio file (WhatsApp accepts no caption there), plus any attachments
 * beyond the first. Empty for the common text-only or single-image campaign.
 */
export const buildFollowUpPayloads = (to: string, messageText: string, attachments: any[] = []) => {
  const all = (attachments || []).map(prepared).filter(Boolean) as PreparedMedia[];
  if (all.length === 0) return [];

  const payloads: any[] = [];
  const [first, ...rest] = all;

  // Text was not carried as a caption, so it needs its own message.
  if (messageText && !first.supportsCaption) payloads.push(textPayload(to, messageText));

  for (const media of rest) {
    payloads.push({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace('+', ''),
      type: media.kind,
      [media.kind]: mediaObject(media),
    });
  }

  return payloads;
};

export class WhatsAppService {
  private isMockMode: boolean;
  private token: string | undefined;
  private phoneId: string | undefined;
  private apiVersion: string;

  constructor() {
    this.token = process.env.WHATSAPP_TOKEN;
    this.phoneId = process.env.WHATSAPP_PHONE_ID;
    this.apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';

    // Fall back to Mock mode if credentials are not provided
    this.isMockMode = !this.token || !this.phoneId;

    console.log(
      `WhatsAppService: ${this.isMockMode ? 'MOCK' : 'PRODUCTION'} mode (api ${this.apiVersion})`
    );
  }

  /** One POST to the messages endpoint. The token never leaves this method. */
  private postMessage(payload: any) {
    return axios.post(
      `https://graph.facebook.com/${this.apiVersion}/${this.phoneId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        // Without a cap, one wedged socket stalls the whole campaign batch
        // indefinitely. Generous enough that a merely slow Graph API call
        // still succeeds.
        timeout: 30_000,
      }
    );
  }

  /**
   * Upload one file to WhatsApp and return its media ID.
   *
   * Done once per campaign, not once per recipient: the ID is reusable for
   * every message in the send, and re-uploading the same file hundreds of
   * times would be slow and wasteful. Meta keeps an uploaded media ID usable
   * for roughly 30 days, far longer than a campaign takes to go out.
   *
   * Returns the ID only — the Authorization header and the file's bytes are
   * never logged.
   */
  async uploadMediaToMeta(filePath: string, mimeType: string, filename: string): Promise<string> {
    if (this.isMockMode) {
      return `mock-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    try {
      const bytes = await fs.promises.readFile(filePath);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mimeType);
      form.append('file', new Blob([bytes], { type: mimeType }), filename);

      const response = await axios.post(
        `https://graph.facebook.com/${this.apiVersion}/${this.phoneId}/media`,
        form,
        {
          headers: { 'Authorization': `Bearer ${this.token}` },
          // A 100 MB PDF needs longer than a message post.
          timeout: 120_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      const mediaId = response.data?.id;
      if (!mediaId) {
        throw new WhatsAppSendError('WhatsApp accepted the upload but returned no media id.');
      }
      return mediaId;
    } catch (error: any) {
      if (error instanceof WhatsAppSendError) throw error;
      const metaError = error.response?.data?.error;
      // Meta's own error only — never the token, the header or the file bytes.
      console.error('WhatsApp media upload error:', metaError || error.message);
      throw new WhatsAppSendError(
        metaError?.message || error.message || 'Failed to upload media to WhatsApp',
        typeof metaError?.code === 'number' ? metaError.code : undefined,
        metaError?.error_data?.details
      );
    }
  }

  /**
   * Hand one message to WhatsApp.
   *
   * Resolving means Meta ACCEPTED the message, not that it arrived — the
   * handset outcome only shows up later on the webhook. Callers must not
   * treat a resolved promise as proof of delivery.
   */
  async sendMessage(to: string, messageText: string, mediaAttachments: any[]): Promise<WhatsAppSendResult> {
    if (this.isMockMode) {
      return this.sendMockMessage(to, messageText, mediaAttachments);
    }

    // Real API Implementation
    // WhatsApp Cloud API: POST https://graph.facebook.com/<version>/<Phone-Number-ID>/messages
    // where <version> is configurable via WHATSAPP_API_VERSION (default v22.0).
    try {
      /**
       * Media is sent by media ID, never by URL. WhatsApp would have to fetch
       * a URL itself, and this application's /uploads route is authenticated
       * and sits on an ephemeral disk, so no link it could follow exists.
       * Uploading to Meta first (see uploadMediaToMeta) avoids needing public
       * storage at all and keeps campaign media private.
       *
       * Exactly one message is sent here, so one recipient still maps to one
       * MessageLog with one wamid. Where WhatsApp allows a caption, the
       * campaign text rides along on the media message rather than being sent
       * again as its own message — sending both would deliver the text twice.
       */
      const primary = buildPrimaryPayload(to, messageText, mediaAttachments);

      const response = await this.postMessage(primary);

      // Meta answers with { messages: [{ id: "wamid.…" }] }. That id is the
      // only handle the delivery webhook will refer to later.
      const wamid = response.data?.messages?.[0]?.id ?? null;

      /**
       * Anything the primary message could not carry: audio takes no caption,
       * so campaign text follows as its own message, and any further
       * attachments are sent after the first. These are best-effort — the
       * recipient's reporting row tracks the primary wamid, so a follow-up
       * failing is logged but does not turn a delivered campaign into a
       * failed one.
       */
      for (const followUp of buildFollowUpPayloads(to, messageText, mediaAttachments)) {
        try {
          await this.postMessage(followUp);
        } catch (err: any) {
          console.error('WhatsApp follow-up message failed:', err?.response?.data?.error || err?.message);
        }
      }

      return { wamid, raw: response.data };
    } catch (error: any) {
      const metaError = error.response?.data?.error;
      // Logs Meta's own error, never the token or the message body.
      console.error('WhatsApp API Error:', metaError || error.message);
      throw new WhatsAppSendError(
        metaError?.message || error.message || 'Failed to send WhatsApp message',
        typeof metaError?.code === 'number' ? metaError.code : undefined,
        metaError?.error_data?.details
      );
    }
  }

  private async sendMockMessage(to: string, messageText: string, mediaAttachments: any[]): Promise<WhatsAppSendResult> {
    // Simulate network delay (500ms - 1500ms)
    const delay = Math.floor(Math.random() * 1000) + 500;
    await new Promise(resolve => setTimeout(resolve, delay));

    // Simulate 5% random failure rate for realism in testing
    if (Math.random() < 0.05) {
      throw new Error('Simulated network timeout from Mock WhatsApp API');
    }

    console.log(`[MOCK WA] Accepted message for ${to}`);
    // Shaped like a real acceptance, including a wamid, so the reporting and
    // webhook-correlation paths behave identically in mock mode.
    const wamid = `wamid.mock.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    return {
      wamid,
      raw: {
        messaging_product: "whatsapp",
        contacts: [{ input: to, wa_id: to.replace('+', '') }],
        messages: [{ id: wamid }]
      },
    };
  }
}

export const whatsappService = new WhatsAppService();
