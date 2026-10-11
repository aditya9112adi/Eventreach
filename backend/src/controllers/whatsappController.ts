import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  sendTemplateMessage,
  WhatsAppTemplateError,
  type TemplateMessageInput,
  type TemplateMessageResult,
  type TemplateHeaderMedia,
} from '../services/whatsappTemplateService';
import fs from 'fs';
import path from 'path';
import { WHATSAPP_MEDIA_RULES } from '@eventreach/shared';
import {
  fetchTemplateDefinition,
  isMediaHeaderFormat,
  type MediaHeaderFormat,
} from '../services/whatsappTemplateCatalog';
import { whatsappService } from '../services/WhatsAppService';
import { UPLOAD_DIR } from '../middleware/mediaUpload';
import {
  buildEventTemplateVariables,
  resolveEventTemplate,
  EventTemplateError,
  type DeclaredHeaderFormat,
  type TemplateVariable,
} from '../services/eventTemplateMessage';
import { isEventAuthorized } from '../services/eventAuthService';
import { AuditService } from '../services/AuditService';
import { Event } from '../models/Event';
import { findEventGuest } from '../services/subEventService';
import { MessageLog } from '../models/MessageLog';
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

// ── template send from the Campaign Composer ────────────────────────────────

/**
 * How long an identical send (same sender, event, guest and template) is
 * refused for. The Composer already blocks a second click; this also covers a
 * resubmitted request or a second browser tab.
 *
 * In memory, so it is per instance: it stops accidental duplicates, it is not
 * a distributed lock. The endpoint additionally sits behind actionLimiter.
 */
export const DUPLICATE_SEND_WINDOW_MS = 60_000;

/**
 * Recipients per request. The Composer lists the guests of a single event, and
 * a ceiling keeps one request from tying up the process indefinitely — the
 * same reasoning as the bulk-delete limit.
 */
export const MAX_TEMPLATE_RECIPIENTS = 50;

/**
 * Messages in flight at once. WhatsApp rate-limits per phone number, so a
 * batch is paced rather than fired all at once; the results are still reported
 * in the order the guests were selected.
 */
const SEND_CONCURRENCY = 5;

const recentSends = new Map<string, number>();

/** Exported for tests. */
export const clearRecentEventTemplateSends = () => recentSends.clear();

/**
 * The attachment a media template needs, as the upload endpoint returned it.
 * The file itself stays on this server; only a Meta media id is ever sent.
 */
const templateAttachmentBody = z
  .object({
    url: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string().min(1).optional(),
  })
  .optional();

/** Meta's header format -> the media kind the sender speaks. */
const HEADER_FORMAT_TO_KIND: Record<MediaHeaderFormat, 'image' | 'video' | 'document'> = {
  IMAGE: 'image',
  VIDEO: 'video',
  DOCUMENT: 'document',
};

const A_FILE_OF_TYPE: Record<MediaHeaderFormat, string> = {
  IMAGE: 'an image',
  VIDEO: 'a video',
  DOCUMENT: 'a document (PDF)',
};

/**
 * Turns the request's attachment into the header media for this template, or
 * refuses the request with a reason that names the real problem.
 *
 * Uploaded ONCE per request, not once per recipient: the media id is reusable
 * for every message in the send, exactly as campaign media is.
 */
export const resolveHeaderMedia = async (
  context: EventTemplateContext,
  attachment: { url: string; filename: string; mimeType?: string } | undefined
): Promise<TemplateHeaderMedia | undefined> => {
  /**
   * What the template declares wins. Reading the definition from Meta is a
   * convenience for the preview and needs WHATSAPP_WABA_ID, which is optional —
   * sending must not depend on it.
   */
  if (context.headerFormat) {
    return uploadHeaderMedia(context, attachment, context.headerFormat);
  }

  const definition = await fetchTemplateDefinition(context.templateName, context.languageCode);

  if (!definition) {
    /**
     * Nothing declared and nothing readable: a text-only template still sends
     * (none of this is needed for it), but an attachment cannot be placed
     * blind, so say what is missing instead of guessing.
     */
    if (attachment) {
      throw new EventTemplateError(
        'CONFIGURATION_ERROR',
        'This template does not declare a media header and the approved definition could not be read from WhatsApp. Set WHATSAPP_WABA_ID on the server, or declare the header in EVENT_TEMPLATES.',
        503
      );
    }
    return undefined;
  }

  const header = definition.header;

  if (header?.format === 'TEXT' && header.required) {
    // A text header with its own {{1}} needs a header text parameter, which
    // this flow does not build. Refusing beats a rejected send.
    throw new EventTemplateError(
      'UNSUPPORTED_TEMPLATE',
      `"${context.templateName}" has a text header with its own placeholder, which this page cannot fill yet.`,
      400,
      'templateName'
    );
  }

  const needsMedia = header != null && isMediaHeaderFormat(header.format);

  if (!needsMedia) {
    if (attachment) {
      throw new EventTemplateError(
        'VALIDATION_ERROR',
        `"${context.templateName}" has no media header, so it cannot carry an attachment.`,
        400,
        'attachment'
      );
    }
    return undefined;
  }

  return uploadHeaderMedia(context, attachment, header!.format as MediaHeaderFormat);
};

/** Validates the attachment against the header format, then uploads it once. */
const uploadHeaderMedia = async (
  context: EventTemplateContext,
  attachment: { url: string; filename: string; mimeType?: string } | undefined,
  format: MediaHeaderFormat
): Promise<TemplateHeaderMedia | undefined> => {
  if (!attachment) {
    throw new EventTemplateError(
      'ATTACHMENT_REQUIRED',
      `"${context.templateName}" needs ${A_FILE_OF_TYPE[format]} for its header. Attach one and send again.`,
      400,
      'attachment'
    );
  }

  const fileName = path.basename(String(attachment.url || ''));
  if (!fileName) {
    throw new EventTemplateError('VALIDATION_ERROR', 'The attachment has no stored file.', 400, 'attachment');
  }

  // Same resolution the campaign path uses: the stored url is a local path
  // behind an authenticated route, never a link WhatsApp could follow.
  const ext = path.extname(fileName).toLowerCase();
  const mimeType =
    attachment.mimeType ||
    Object.keys(WHATSAPP_MEDIA_RULES).find((m) => WHATSAPP_MEDIA_RULES[m].extensions.includes(ext)) ||
    '';
  const rule = WHATSAPP_MEDIA_RULES[mimeType];
  if (!rule) {
    throw new EventTemplateError(
      'VALIDATION_ERROR',
      `"${attachment.filename}" is not a file type WhatsApp accepts.`,
      400,
      'attachment'
    );
  }

  const expectedKind = HEADER_FORMAT_TO_KIND[format];
  if (rule.kind !== expectedKind) {
    throw new EventTemplateError(
      'VALIDATION_ERROR',
      `"${context.templateName}" needs ${A_FILE_OF_TYPE[format]}, but "${attachment.filename}" is ${rule.kind === 'audio' ? 'an audio file' : `a ${rule.kind}`}.`,
      400,
      'attachment'
    );
  }

  const filePath = path.join(UPLOAD_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    // The host's disk is ephemeral: a file uploaded before a restart is gone.
    throw new EventTemplateError(
      'ATTACHMENT_MISSING',
      `The attached file "${attachment.filename}" is no longer available on the server. Please re-upload it and send again.`,
      400,
      'attachment'
    );
  }

  try {
    const mediaId = await whatsappService.uploadMediaToMeta(filePath, mimeType, attachment.filename);
    return {
      kind: expectedKind,
      mediaId,
      ...(expectedKind === 'document' ? { filename: attachment.filename } : {}),
    };
  } catch (error: any) {
    // Meta's own message only — never the token or the file's bytes.
    throw new EventTemplateError(
      'MEDIA_UPLOAD_FAILED',
      error?.message || 'Failed to upload the attachment to WhatsApp.',
      502,
      'attachment'
    );
  }
};

const sendEventTemplateBody = z.object({
  eventId: z.string().optional(),
  // The list form. `contactId` stays valid for a single guest, so the preview
  // flow and any client that has not been updated keep working.
  contactIds: z.array(z.string()).optional(),
  contactId: z.string().optional(),
  templateName: z.string().optional(),
  attachment: templateAttachmentBody,
});

export interface EventTemplateContext {
  event: any;
  templateName: string;
  languageCode: string;
  /** The approved header format, when the template declares one. */
  headerFormat?: DeclaredHeaderFormat;
}

export interface ResolvedEventTemplate extends EventTemplateContext {
  contact: any;
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
 * The recipients of one request, deduplicated and order-preserving.
 *
 * The same guest listed twice would otherwise be sent to twice, or reported as
 * a duplicate failure that the user never caused.
 */
export const readRecipientIds = (body: { contactIds?: unknown; contactId?: unknown }): string[] => {
  const raw = Array.isArray(body.contactIds)
    ? body.contactIds
    : typeof body.contactId === 'string'
      ? [body.contactId]
      : [];

  const ids = Array.from(
    new Set(raw.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))
  );

  if (ids.length === 0) {
    throw new EventTemplateError('VALIDATION_ERROR', 'Select at least one guest.', 400, 'contactIds');
  }
  if (ids.length > MAX_TEMPLATE_RECIPIENTS) {
    throw new EventTemplateError(
      'VALIDATION_ERROR',
      `Cannot send to more than ${MAX_TEMPLATE_RECIPIENTS} guests in one request.`,
      400,
      'contactIds'
    );
  }
  return ids;
};

/**
 * The event side of a request: the template, the per-event authorization the
 * rest of the campaign flow uses, and the Upcoming-only rule.
 *
 * Resolved once per request, before any guest is looked at — a caller who may
 * not use this event is refused outright rather than per recipient.
 */
export const resolveEventContext = async (
  input: { eventId?: unknown; templateName?: unknown },
  user: any
): Promise<EventTemplateContext> => {
  const { name, spec } = resolveEventTemplate(input.templateName);
  const eventId = requireObjectId(input.eventId, 'eventId', 'An event');

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

  return {
    event,
    templateName: name,
    languageCode: spec.languageCode,
    headerFormat: spec.headerFormat,
  };
};

/**
 * One guest of that event, with the template variables derived from the stored
 * documents.
 *
 * The guest is looked up by id AND event, so a contact belonging to another
 * event can never be messaged through an event the caller does have access to.
 * For a Sub-Event, "belongs" means on its member list.
 * No variable value is read from the request body.
 */
export const resolveGuestVariables = async (
  context: EventTemplateContext,
  contactId: unknown
): Promise<ResolvedEventTemplate> => {
  const id = requireObjectId(contactId, 'contactId', 'A guest');
  // A Sub-Event's guest must be on its member list (findEventGuest).
  const contact = await findEventGuest(context.event, id);
  if (!contact) {
    throw new EventTemplateError(
      'CONTACT_NOT_FOUND',
      'That guest is not part of the selected event.',
      404,
      'contactId'
    );
  }

  return {
    ...context,
    contact,
    variables: buildEventTemplateVariables(context.templateName, context.event, contact),
  };
};

/** The single-guest resolution the preview endpoint uses. */
export const resolveEventTemplateRequest = async (
  input: { eventId?: unknown; contactId?: unknown; templateName?: unknown },
  user: any
): Promise<ResolvedEventTemplate> => {
  const context = await resolveEventContext(input, user);
  return resolveGuestVariables(context, input.contactId);
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
 * What one guest would actually receive: the approved body text as Meta holds
 * it, plus the values resolved for {{1}}…{{5}}. If the body cannot be read
 * (WHATSAPP_WABA_ID unset, or Meta refuses the lookup) bodyText is null and
 * the caller shows the values alone — this never invents template wording.
 *
 * A batch previews its first recipient; the other guests receive the same
 * template with their own name filled in.
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
      // What the approved template expects above the body, so the composer can
      // ask for the right kind of file (or none at all).
      // The declared header is authoritative; the definition only fills in for
      // a template that declares none.
      header: context.headerFormat
        ? { format: context.headerFormat, required: true, isMedia: true }
        : definition?.header
          ? {
              format: definition.header.format,
              required: definition.header.required,
              isMedia: isMediaHeaderFormat(definition.header.format),
            }
          : null,
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

interface SentRecipient {
  contactId: string;
  fullName: string;
  messageId: string;
  status: string;
}

interface FailedRecipient {
  contactId: string;
  fullName: string | null;
  reason: string;
  code: string;
  /** Meta's own error number, when the rejection came from Meta. */
  metaCode?: number;
  httpStatus: number;
}

/**
 * Runs `worker` over the recipients a few at a time, keeping the results in
 * the order the guests were selected.
 */
const mapWithConcurrency = async <T>(
  ids: string[],
  limit: number,
  worker: (id: string, index: number) => Promise<T>
): Promise<T[]> => {
  const results = new Array<T>(ids.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await worker(ids[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

/**
 * POST /api/whatsapp/event-template
 *
 * Sends one approved template message to each selected guest of one event.
 *
 * Event-level problems — no access, event missing, event not Upcoming — refuse
 * the whole request with the usual single error body. Guest-level problems are
 * per recipient: one guest who cannot be messaged never stops the others, and
 * the response reports exactly who was sent to and who was not (200 all sent,
 * 207 partial, and the shared status when every recipient failed the same way).
 */
export const buildEventTemplateHandler = (
  send: Sender = sendTemplateMessage,
  now: () => number = Date.now
) =>
  async (req: Request, res: Response) => {
    try {
      const parsed = sendEventTemplateBody.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0].message },
        });
      }

      const user = (req as any).user;
      const contactIds = readRecipientIds(parsed.data);
      const context = await resolveEventContext(parsed.data, user);

      /**
       * Uploaded once for the whole request, before any recipient is
       * messaged: the media id is reusable, and re-uploading the same file per
       * recipient would be slow and pointless. A failure here refuses the
       * whole send, because no recipient can be messaged as composed.
       */
      const headerMedia = await resolveHeaderMedia(context, parsed.data.attachment);

      for (const [key, at] of recentSends) {
        if (now() - at >= DUPLICATE_SEND_WINDOW_MS) recentSends.delete(key);
      }

      const bulkOperationId =
        contactIds.length > 1
          ? `BULK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
          : null;

      const outcomes = await mapWithConcurrency(contactIds, SEND_CONCURRENCY, async (contactId) => {
        let reservedKey: string | null = null;
        let guest: ResolvedEventTemplate | null = null;
        let logId: any = null;
        try {
          guest = await resolveGuestVariables(context, contactId);

          const dedupeKey = [
            user?.id ?? 'anonymous',
            String(context.event._id),
            String(guest.contact._id),
            context.templateName,
          ].join(':');

          const last = recentSends.get(dedupeKey);
          if (last !== undefined) {
            const wait = Math.ceil((DUPLICATE_SEND_WINDOW_MS - (now() - last)) / 1000);
            throw new EventTemplateError(
              'DUPLICATE_SEND',
              `This template was just sent to ${guest.contact.fullName}. Wait ${wait}s before sending it again.`,
              409
            );
          }
          recentSends.set(dedupeKey, now());
          reservedKey = dedupeKey;

          /**
           * The reporting row is created BEFORE the request, not after it.
           * Meta can deliver a status callback the moment it accepts a
           * message, and the webhook correlates on wamid against an existing
           * row — one written afterwards would miss an early callback and sit
           * at Sent forever. Pending is the state the campaign flow uses for
           * exactly this window.
           *
           * Logging never decides whether a message is sent: a failure here is
           * recorded and stepped over.
           */
          try {
            const log = await MessageLog.create({
              eventId: context.event._id,
              contactId: guest.contact._id,
              contactName: guest.contact.fullName,
              phoneNumber: guest.contact.phoneNumber,
              templateName: context.templateName,
              status: 'Pending',
            });
            logId = log._id;
          } catch (logError: any) {
            console.error('WhatsApp template: could not create the delivery record:', logError?.message);
          }

          const result = await send({
            to: guest.contact.phoneNumber,
            templateName: context.templateName,
            languageCode: context.languageCode,
            variables: guest.variables.map((variable) => variable.value),
            ...(headerMedia ? { headerMedia } : {}),
          });

          /**
           * Accepted by Meta. Recording that must never turn a delivered
           * message into a failed one, so a write failure is logged and the
           * send still counts as the success it was.
           */
          if (logId) {
            try {
              await MessageLog.updateOne(
                { _id: logId },
                { $set: { wamid: result.messageId, status: 'Sent', sentAt: new Date() } }
              );
            } catch (logError: any) {
              console.error('WhatsApp template: could not record the accepted message:', logError?.message);
            }
          }

          // Every other send in the app is audited; a real WhatsApp message
          // sent from this page is no different. AuditService.log never throws.
          await AuditService.log({
            action: 'WHATSAPP_TEMPLATE_SENT',
            collectionName: 'contacts',
            documentId: String(guest.contact._id),
            actor: AuditService.getActorFromReq(req),
            request: AuditService.getRequestInfo(req),
            bulkOperationId,
            description: `Sent WhatsApp template "${context.templateName}" to ${guest.contact.fullName} for event ${context.event.eventName}`,
            metadata: {
              eventId: String(context.event._id),
              templateName: context.templateName,
              languageCode: context.languageCode,
              messageId: result.messageId,
              recipientCount: contactIds.length,
              ...(headerMedia
                ? { headerMedia: { kind: headerMedia.kind, filename: headerMedia.filename ?? null } }
                : {}),
            },
          });

          const sent: SentRecipient = {
            contactId: String(guest.contact._id),
            fullName: guest.contact.fullName,
            messageId: result.messageId,
            status: result.status,
          };
          return { sent, variables: guest.variables };
        } catch (error) {
          // A send that never reached Meta must not block the retry; a
          // duplicate rejection keeps the window it just tripped over.
          const isDuplicate = error instanceof EventTemplateError && error.code === 'DUPLICATE_SEND';
          if (reservedKey && !isDuplicate) recentSends.delete(reservedKey);

          const known = error instanceof EventTemplateError || error instanceof WhatsAppTemplateError;
          if (!known) {
            console.error('WhatsApp event-template send error:', (error as any)?.message);
          }
          // WhatsAppTemplateError inherits a numeric `code` from
          // WhatsAppSendError (Meta's own error code), so the category is what
          // names the failure here; Meta's number is reported separately.
          const metaCode = error instanceof WhatsAppTemplateError ? error.meta?.code : undefined;
          /**
           * Meta refused it. The same row is closed out as Failed with Meta's
           * own code, so the Delivery Log shows why — and, as above, a write
           * failure here changes nothing about the send.
           */
          if (logId) {
            try {
              await MessageLog.updateOne(
                { _id: logId },
                {
                  $set: {
                    status: 'Failed',
                    failedAt: new Date(),
                    ...(typeof metaCode === 'number' ? { errorCode: metaCode } : {}),
                    errorReason: known
                      ? (error as Error).message
                      : 'Failed to send the WhatsApp template message.',
                  },
                }
              );
            } catch (logError: any) {
              console.error('WhatsApp template: could not record the failure:', logError?.message);
            }
          }

          const failed: FailedRecipient = {
            contactId,
            fullName: guest?.contact?.fullName ?? null,
            reason: known ? (error as Error).message : 'Failed to send the WhatsApp template message.',
            code:
              error instanceof WhatsAppTemplateError
                ? error.category
                : error instanceof EventTemplateError
                  ? error.code
                  : 'INTERNAL_ERROR',
            ...(typeof metaCode === 'number' ? { metaCode } : {}),
            httpStatus: known ? (error as any).httpStatus : 500,
          };
          return { failed };
        }
      });

      const sent = outcomes.flatMap((outcome: any) => (outcome.sent ? [outcome.sent] : []));
      const failed = outcomes.flatMap((outcome: any) => (outcome.failed ? [outcome.failed] : []));

      // Every recipient failing the same way answers with that failure's own
      // status, so a single-guest send still reports 404/409/504 as before.
      const sharedStatus =
        failed.length > 0 && failed.every((f) => f.httpStatus === failed[0].httpStatus)
          ? failed[0].httpStatus
          : 400;
      const status = failed.length === 0 ? 200 : sent.length > 0 ? 207 : sharedStatus;

      const firstVariables = outcomes.find((outcome: any) => outcome.sent)?.variables ?? [];

      res.status(status).json({
        success: failed.length === 0,
        templateName: context.templateName,
        languageCode: context.languageCode,
        // The media id itself is an internal handle; the kind and filename are
        // what the sender needs to see confirmed.
        headerMedia: headerMedia
          ? { kind: headerMedia.kind, filename: headerMedia.filename ?? null }
          : null,
        bulkOperationId,
        requestedCount: contactIds.length,
        sentCount: sent.length,
        failedCount: failed.length,
        sent,
        failed: failed.map(({ httpStatus, ...rest }) => rest),
        // Single-recipient shorthand, unchanged from before this endpoint took
        // a list — a client that sends one guest can keep reading these.
        ...(contactIds.length === 1 && sent.length === 1
          ? {
              messageId: sent[0].messageId,
              status: sent[0].status,
              sentTo: { contactId: sent[0].contactId, fullName: sent[0].fullName },
              variables: firstVariables,
            }
          : {}),
      });
    } catch (error) {
      errorResponse(res, error, 'WhatsApp event-template send');
    }
  };

export const sendEventTemplate = buildEventTemplateHandler();
