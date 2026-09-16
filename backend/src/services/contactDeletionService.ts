import { Contact } from '../models/Contact';
import { AuditService } from './AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';

/**
 * Guest (contact) deletion shared by every path that removes guests: deleting
 * one guest, bulk-deleting guests, and deleting an event along with its guests.
 * Keeping it in one place means each removed guest leaves the same
 * CONTACT_DELETED audit record however it was removed.
 *
 * Message logs are deliberately not touched. They are the delivery history
 * behind campaign reports, and MessageLog stores its own contactName and
 * phoneNumber so a report still names the recipient once the guest is gone.
 *
 * Callers are responsible for authorization.
 */

export interface ContactDeletionContext {
  bulkOperationId?: string;
  /** Set when the guest is removed because its event was deleted. */
  deletedWithEvent?: { eventId?: string; eventName?: string };
}

/** Writes the CONTACT_DELETED audit record for a guest that has been removed. */
export const auditContactDeletion = async (
  contact: any,
  req: RequestWithId,
  context: ContactDeletionContext = {}
): Promise<void> => {
  const withEvent = context.deletedWithEvent;
  await AuditService.log({
    action: 'CONTACT_DELETED',
    collectionName: 'contacts',
    documentId: contact._id.toString(),
    actor: AuditService.getActorFromReq(req),
    request: AuditService.getRequestInfo(req),
    before: contact,
    description: withEvent
      ? `Deleted contact ${contact.fullName} with event ${withEvent.eventId || withEvent.eventName || ''}`.trim()
      : `Deleted contact ${contact.fullName}`,
    ...(context.bulkOperationId ? { bulkOperationId: context.bulkOperationId } : {}),
    ...(withEvent ? { metadata: { reason: 'EVENT_DELETED', eventId: withEvent.eventId ?? null } } : {}),
  });
};

/** How many audit records are written concurrently for a large guest list. */
const AUDIT_CONCURRENCY = 25;

/**
 * Audit records for many removed guests. An event can hold thousands of guests
 * from a bulk import, so records are written in parallel batches rather than
 * one round trip at a time. AuditService.log never throws.
 */
export const auditContactDeletions = async (
  contacts: any[],
  req: RequestWithId,
  context: ContactDeletionContext = {}
): Promise<void> => {
  for (let i = 0; i < contacts.length; i += AUDIT_CONCURRENCY) {
    await Promise.all(
      contacts.slice(i, i + AUDIT_CONCURRENCY).map((c) => auditContactDeletion(c, req, context))
    );
  }
};

/** Deletes one guest and records it. Used by single and bulk guest deletion. */
export const performContactDeletion = async (
  contact: any,
  req: RequestWithId,
  context: ContactDeletionContext = {}
): Promise<void> => {
  await Contact.findByIdAndDelete(contact._id);
  await auditContactDeletion(contact, req, context);
};
