import axios from 'axios';

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
      const payload: any = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to.replace('+', ''), // WhatsApp API expects number without +
        type: "text",
        text: {
          preview_url: false,
          body: messageText
        }
      };

      // If there are media attachments, the API handles them slightly differently.
      // Usually, you send media via a template or separate media message.
      // For MVP text messages with simple media, if it's not a pre-approved template,
      // you would send an image message type. We'll stick to text-only payload for now in Real mode
      // unless we implement full template management.
      
      const response = await axios.post(
        `https://graph.facebook.com/${this.apiVersion}/${this.phoneId}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          // Without a cap, one wedged socket stalls the whole campaign batch
          // indefinitely. Generous enough that a merely slow Graph API call
          // still succeeds.
          timeout: 30_000,
        }
      );

      // Meta answers with { messages: [{ id: "wamid.…" }] }. That id is the
      // only handle the delivery webhook will refer to later.
      const wamid = response.data?.messages?.[0]?.id ?? null;
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
