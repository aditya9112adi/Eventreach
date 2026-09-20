import { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  sendTemplateMessage,
  WhatsAppTemplateError,
  type TemplateMessageInput,
  type TemplateMessageResult,
} from '../services/whatsappTemplateService';
import { fetchTemplateDefinition } from '../services/whatsappTemplateCatalog';
import {
  buildEventTemplateVariables,
  resolveEventTemplate,
  EventTemplateError,
  type TemplateVariable,
} from '../services/eventTemplateMessage';
import { isEventAuthorized } from '../services/eventAuthService';
import { AuditService } from '../services/AuditService';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { normalizeIndianPhone } from '../utils/indianPhone';

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

// ── single-guest template send from the Campaign Composer ────────────────────

/**
 * How long an identical send (same sender, event, guest and template) is
 * refused for. The Composer already blocks a second click; this also covers a
 * resubmitted request or a second browser tab.
 *
 * In memory, so it is per instance: it stops accidental duplicates, it is not
 * a distributed lock. The endpoint additionally sits behind actionLimiter.
 */
export const DUPLICATE_SEND_WINDOW_MS = 60_000;

const recentSends = new Map<string, number>();

/** Exported for tests. */
export const clearRecentEventTemplateSends = () => recentSends.clear();

export interface ResolvedEventTemplate {
  event: any;
  contact: any;
  templateName: string;
  languageCode: string;
  variables: TemplateVariable[];
}

const requireObjectId = (value: unknown, field: string, label: string): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw new EventTemplateError('VALIDATION_ERROR', `${label} must be selected.`, 400, field);
  }
  return id;
};

/**
 * Loads the event and the guest, applies the SAME authorization rule the rest
 * of the campaign flow uses (isEventAuthorized), and derives the template
 * variables from the stored documents.
 *
 * The guest is looked up by id AND event, so a contact belonging to another
 * event can never be messaged through an event the caller does have access to.
 * The language is the one the template was approved in; the client does not
 * get to choose it, and no variable value is read from the request body.
 */
export const resolveEventTemplateRequest = async (
  input: { eventId?: unknown; contactId?: unknown; templateName?: unknown },
  user: any
): Promise<ResolvedEventTemplate> => {
  const { name, spec } = resolveEventTemplate(input.templateName);
  const eventId = requireObjectId(input.eventId, 'eventId', 'An event');
  const contactId = requireObjectId(input.contactId, 'contactId', 'A guest');

  if (!(await isEventAuthorized(user, eventId))) {
    throw new EventTemplateError(
      'ACCESS_DENIED',
      'Access denied. You do not have access to this event.',
      403
    );
  }

  const event = await Event.findById(eventId).lean();
  if (!event) throw new EventTemplateError('EVENT_NOT_FOUND', 'Event not found.', 404, 'eventId');
  if (event.eventStatus !== 'Upcoming') {
    throw new EventTemplateError(
      'EVENT_NOT_ACTIVE',
      `This event is ${String(event.eventStatus).toLowerCase()}. Messages can only be sent for an upcoming event.`,
      409,
      'eventId'
    );
  }

  const contact = await Contact.findOne({ _id: contactId, eventId }).lean();
  if (!contact) {
    throw new EventTemplateError(
      'CONTACT_NOT_FOUND',
      'That guest is not part of the selected event.',
      404,
      'contactId'
    );
  }

  return {
    event,
    contact,
    templateName: name,
    languageCode: spec.languageCode,
    variables: buildEventTemplateVariables(name, event, contact),
  };
};

const errorResponse = (res: Response, error: unknown, context: string) => {
  if (error instanceof EventTemplateError || error instanceof WhatsAppTemplateError) {
    return res.status(error.httpStatus).json(error.toResponse());
  }
  console.error(`${context} error:`, (error as any)?.message);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Failed to send the WhatsApp template message.' },
  });
};

/**
 * GET /api/whatsapp/event-template-preview
 *
 * What this guest would actually receive: the approved body text as Meta holds
 * it, plus the values resolved for {{1}}…{{5}}. If the body cannot be read
 * (WHATSAPP_WABA_ID unset, or Meta refuses the lookup) bodyText is null and
 * the caller shows the values alone — this never invents template wording.
 */
export const previewEventTemplate = async (req: Request, res: Response) => {
  try {
    const context = await resolveEventTemplateRequest(
      {
        eventId: req.query.eventId,
        contactId: req.query.contactId,
        templateName: req.query.templateName,
      },
      (req as any).user
    );

    const definition = await fetchTemplateDefinition(context.templateName, context.languageCode);
    const phone = normalizeIndianPhone(context.contact.phoneNumber);

    res.json({
      success: true,
      templateName: context.templateName,
      languageCode: context.languageCode,
      templateStatus: definition?.status ?? null,
      bodyText: definition?.bodyText ?? null,
      bodySource: definition ? 'meta' : 'unavailable',
      // A body taking a different number of placeholders than this flow fills
      // would be rejected by Meta (132000) — say so before anything is sent.
      placeholderMismatch:
        definition != null && definition.placeholderCount !== context.variables.length,
      variables: context.variables,
      recipient: {
        contactId: String(context.contact._id),
        fullName: context.contact.fullName,
        phoneNumber: phone.ok ? phone.e164 : String(context.contact.phoneNumber),
        phoneValid: phone.ok,
        ...(phone.ok ? {} : { phoneError: phone.reason }),
      },
      event: {
        eventId: String(context.event._id),
        eventName: context.event.eventName,
      },
    });
  } catch (error) {
    errorResponse(res, error, 'WhatsApp event-template preview');
  }
};

/**
 * POST /api/whatsapp/event-template
 *
 * Sends ONE approved template message to ONE guest of one event — the
 * single-guest test that precedes bulk sending. The request chooses the event,
 * the guest and the template; every value in the message comes from the
 * database.
 */
export const buildEventTemplateHandler = (
  send: Sender = sendTemplateMessage,
  now: () => number = Date.now
) =>
  async (req: Request, res: Response) => {
    let reservedKey: string | null = null;
    try {
      const user = (req as any).user;
      const context = await resolveEventTemplateRequest(req.body, user);

      for (const [key, at] of recentSends) {
        if (now() - at >= DUPLICATE_SEND_WINDOW_MS) recentSends.delete(key);
      }

      const dedupeKey = [
        user?.id ?? 'anonymous',
        String(context.event._id),
        String(context.contact._id),
        context.templateName,
      ].join(':');

      const last = recentSends.get(dedupeKey);
      if (last !== undefined) {
        const wait = Math.ceil((DUPLICATE_SEND_WINDOW_MS - (now() - last)) / 1000);
        throw new EventTemplateError(
          'DUPLICATE_SEND',
          `This template was just sent to ${context.contact.fullName}. Wait ${wait}s before sending it again.`,
          409
        );
      }
      recentSends.set(dedupeKey, now());
      reservedKey = dedupeKey;

      const result = await send({
        to: context.contact.phoneNumber,
        templateName: context.templateName,
        languageCode: context.languageCode,
        variables: context.variables.map((variable) => variable.value),
      });

      // Every other send in the app is audited; a real WhatsApp message sent
      // from this page is no different. AuditService.log never throws.
      await AuditService.log({
        action: 'WHATSAPP_TEMPLATE_SENT',
        collectionName: 'contacts',
        documentId: String(context.contact._id),
        actor: AuditService.getActorFromReq(req),
        request: AuditService.getRequestInfo(req),
        description: `Sent WhatsApp template "${context.templateName}" to ${context.contact.fullName} for event ${context.event.eventName}`,
        metadata: {
          eventId: String(context.event._id),
          templateName: context.templateName,
          languageCode: context.languageCode,
          messageId: result.messageId,
          singleRecipientTest: true,
        },
      });

      res.json({
        success: true,
        messageId: result.messageId,
        status: result.status,
        recipient: result.recipient,
        templateName: context.templateName,
        languageCode: context.languageCode,
        sentTo: {
          contactId: String(context.contact._id),
          fullName: context.contact.fullName,
        },
        variables: context.variables,
      });
    } catch (error) {
      // A send that never reached Meta must not block the retry; a duplicate
      // rejection keeps the window it just tripped over.
      if (reservedKey && !(error instanceof EventTemplateError && error.code === 'DUPLICATE_SEND')) {
        recentSends.delete(reservedKey);
      }
      errorResponse(res, error, 'WhatsApp event-template send');
    }
  };

export const sendEventTemplate = buildEventTemplateHandler();
