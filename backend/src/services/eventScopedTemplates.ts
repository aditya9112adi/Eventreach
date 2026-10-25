import mongoose from 'mongoose';
import { WhatsAppTemplate } from '../models/WhatsAppTemplate';
import { EventTemplateError } from './eventTemplateMessage';
import { isTemplateSendable } from './templateDefinition';
import { LANGUAGE_CODE_PATTERN } from './whatsappTemplateService';
import type { MappedVariable } from './templateVariables';

/**
 * Event-specific WhatsApp templates in the Campaign Composer.
 *
 * A template managed under WhatsApp Templates is tied to one event when it is
 * created (eventObjectId + eventId, both taken from the event the server looked
 * up - see templateService.resolveEvent). Here it may be listed and sent only
 * for that event, and only while Meta reports it approved.
 *
 * Nothing about the association is taken from the browser: the event is the one
 * the request was authorized for, and a template is accepted only if the stored
 * ids match THAT event's current ids. The same check runs on every send, so a
 * stale screen, a hand-made request, or a template that was paused or moved
 * since it was listed cannot get a message out.
 *
 * A template with no association (made before templates were tied to an event)
 * matches no event: it is neither listed nor sendable here, and is never
 * assigned to an event on its own.
 */

export interface ScopedTemplate {
  id: string;
  name: string;
  languageCode: string;
  wabaId: string;
  body: string;
  footer: string | null;
  headerText: string | null;
  /** The media the header takes, declared when the template was linked; null for a template with no media header. */
  headerFormat: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
  mapping: MappedVariable[];
}

const NOT_FOR_EVENT = 'This template is not available for the selected event.';

/** True when the template is stored as belonging to exactly this event. */
export const isAssociatedWithEvent = (template: { eventObjectId?: unknown; eventId?: unknown }, event: { _id: unknown; eventId?: unknown }): boolean =>
  Boolean(template.eventObjectId) &&
  typeof event.eventId === 'string' &&
  typeof template.eventId === 'string' &&
  String(template.eventObjectId) === String(event._id) &&
  template.eventId === event.eventId;

const mappingOf = (template: any): MappedVariable[] =>
  (template.variables || []).map((v: any) => ({
    position: v.position,
    label: v.label,
    source: v.source,
    ...(v.fixedValue !== undefined ? { fixedValue: v.fixedValue } : {}),
    ...(v.fallback !== undefined ? { fallback: v.fallback } : {}),
  }));

/** The approved templates for one event, for the Composer's template list. */
export const listApprovedEventTemplates = async (event: { _id: unknown; eventId?: unknown }) => {
  if (typeof event.eventId !== 'string') return [];
  const templates: any[] = await WhatsAppTemplate.find({
    eventObjectId: event._id,
    eventId: event.eventId,
    localState: 'Approved',
    metaStatus: 'APPROVED',
  })
    .sort({ displayName: 1, _id: 1 })
    .limit(200)
    .lean();

  return templates
    .filter((t) => isTemplateSendable(t) && isAssociatedWithEvent(t, event) && LANGUAGE_CODE_PATTERN.test(String(t.language)))
    .map((t) => ({
      id: String(t._id),
      name: t.name,
      displayName: t.displayName,
      language: t.language,
      category: t.category,
      body: t.body,
      headerText: t.headerText ?? null,
      // A media header means a file is attached at send time.
      headerFormat: t.headerFormat ?? null,
      footer: t.footer ?? null,
      variableCount: (t.variables || []).length,
    }));
};

/**
 * The template a send asks for, checked against the event it is sent for.
 * Throws - sending nothing - unless it exists, belongs to this event and is
 * approved by Meta. "Not found" and "someone else's" answer identically.
 */
export const loadEventTemplate = async (event: { _id: unknown; eventId?: unknown }, templateId: unknown): Promise<ScopedTemplate> => {
  if (typeof templateId !== 'string' || !mongoose.Types.ObjectId.isValid(templateId.trim())) {
    throw new EventTemplateError('VALIDATION_ERROR', 'A valid template must be selected.', 400, 'templateId');
  }
  const template: any = await WhatsAppTemplate.findById(templateId.trim()).lean();
  if (!template || !isAssociatedWithEvent(template, event)) {
    throw new EventTemplateError('TEMPLATE_NOT_FOR_EVENT', NOT_FOR_EVENT, 403, 'templateId');
  }
  if (!isTemplateSendable(template)) {
    throw new EventTemplateError(
      'TEMPLATE_NOT_APPROVED',
      `This template cannot be sent: WhatsApp has not approved it (${template.localState}).`,
      409,
      'templateId'
    );
  }
  if (!LANGUAGE_CODE_PATTERN.test(String(template.language))) {
    throw new EventTemplateError('TEMPLATE_NOT_APPROVED', 'This template has no valid language code.', 409, 'templateId');
  }
  return {
    id: String(template._id),
    name: template.name,
    languageCode: template.language,
    wabaId: String(template.wabaId),
    body: template.body,
    footer: template.footer ?? null,
    headerText: template.headerText ?? null,
    headerFormat: template.headerFormat ?? null,
    mapping: mappingOf(template),
  };
};

/**
 * A template belongs to one WhatsApp Business Account. Sent from the
 * environment sender it must be that sender's account; a connected number is
 * checked against its own account by name (senderTemplateCheck).
 */
export const assertTemplateAccount = (
  template: ScopedTemplate,
  sender: { kind: string; credential?: string },
  environmentWabaId: string | undefined
): void => {
  if (sender.kind === 'assigned' && sender.credential === 'sender') return;
  if (environmentWabaId && environmentWabaId !== template.wabaId) {
    throw new EventTemplateError('TEMPLATE_NOT_APPROVED', 'This template belongs to a different WhatsApp Business Account than the sender.', 409, 'templateId');
  }
};
