import { Request, Response } from 'express';
import {
  sendTemplateMessage,
  WhatsAppTemplateError,
  type TemplateMessageInput,
  type TemplateMessageResult,
} from '../services/whatsappTemplateService';

/**
 * Named request fields for each known template, in {{1}}, {{2}}, … order.
 *
 * Adding a template later is one line here — the service itself is generic and
 * only ever sees the ordered values. A template not listed can still be sent by
 * passing `variables` as an ordered array.
 */
export const TEMPLATE_VARIABLE_FIELDS: Record<string, readonly string[]> = {
  event_reminder: ['recipientName', 'eventName', 'eventDate', 'eventTime', 'eventVenue'],
};

const DEFAULT_LANGUAGE_CODE = 'en';

type Sender = (input: TemplateMessageInput) => Promise<TemplateMessageResult>;

/** Maps the request body onto the service input, naming any missing field. */
export const toTemplateInput = (body: any): TemplateMessageInput => {
  const templateName = typeof body?.templateName === 'string' ? body.templateName.trim() : body?.templateName;
  const fields = typeof templateName === 'string' ? TEMPLATE_VARIABLE_FIELDS[templateName] : undefined;

  let variables: unknown = body?.variables;
  if (fields) {
    for (const field of fields) {
      const value = body?.[field];
      if (typeof value !== 'string' || !value.trim()) {
        throw new WhatsAppTemplateError(
          'VALIDATION_ERROR',
          `${field} is required for template "${templateName}".`,
          400,
          { field }
        );
      }
    }
    variables = fields.map((field) => body[field]);
  }

  return {
    to: body?.to,
    templateName,
    languageCode: body?.languageCode ?? DEFAULT_LANGUAGE_CODE,
    variables,
  };
};

/**
 * POST /api/whatsapp/test-template — Super Admin only.
 *
 * Sends ONE template message to ONE number, for checking the WhatsApp setup
 * against a real handset. The response carries the message id and Meta's
 * acceptance status only; a Meta rejection comes back as a structured error
 * with Meta's code and trace id so it can be diagnosed, and never includes the
 * access token or request headers.
 */
export const buildTestTemplateHandler = (send: Sender = sendTemplateMessage) =>
  async (req: Request, res: Response) => {
    try {
      const result = await send(toTemplateInput(req.body));
      res.json({
        success: true,
        messageId: result.messageId,
        status: result.status,
        recipient: result.recipient,
      });
    } catch (error) {
      if (error instanceof WhatsAppTemplateError) {
        return res.status(error.httpStatus).json(error.toResponse());
      }
      // Unexpected: nothing from the error object is returned.
      console.error('WhatsApp test-template error:', (error as any)?.message);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to send the WhatsApp template message.' },
      });
    }
  };

export const testTemplateMessage = buildTestTemplateHandler();
