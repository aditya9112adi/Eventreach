import axios from 'axios';

export class WhatsAppService {
  private isMockMode: boolean;
  private token: string | undefined;
  private phoneId: string | undefined;

  constructor() {
    this.token = process.env.WHATSAPP_TOKEN;
    this.phoneId = process.env.WHATSAPP_PHONE_ID;
    
    // Fall back to Mock mode if credentials are not provided
    this.isMockMode = !this.token || !this.phoneId;
    
    if (this.isMockMode) {
      console.log('WhatsAppService is running in MOCK mode.');
    } else {
      console.log('WhatsAppService is running in PRODUCTION mode.');
    }
  }

  async sendMessage(to: string, messageText: string, mediaAttachments: any[]): Promise<any> {
    if (this.isMockMode) {
      return this.sendMockMessage(to, messageText, mediaAttachments);
    }

    // Real API Implementation
    // According to WhatsApp Cloud API docs:
    // https://graph.facebook.com/v17.0/{{Phone-Number-ID}}/messages
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
        `https://graph.facebook.com/v17.0/${this.phoneId}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error: any) {
      console.error('WhatsApp API Error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp message');
    }
  }

  private async sendMockMessage(to: string, messageText: string, mediaAttachments: any[]): Promise<any> {
    // Simulate network delay (500ms - 1500ms)
    const delay = Math.floor(Math.random() * 1000) + 500;
    await new Promise(resolve => setTimeout(resolve, delay));

    // Simulate 5% random failure rate for realism in testing
    if (Math.random() < 0.05) {
      throw new Error('Simulated network timeout from Mock WhatsApp API');
    }

    console.log(`[MOCK WA] Sent message to ${to}`);
    return {
      messaging_product: "whatsapp",
      contacts: [{ input: to, wa_id: to.replace('+', '') }],
      messages: [{ id: `wamid.mock.${Date.now()}` }]
    };
  }
}

export const whatsappService = new WhatsAppService();
