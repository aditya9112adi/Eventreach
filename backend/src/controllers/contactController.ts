import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { normalizeIndianPhone } from '../utils/indianPhone';
import { Contact } from '../models/Contact';
import { extractFromExcel, extractFromPDF, RawContact } from '../utils/fileExtractors';
import type { ExtractedContact } from '@eventreach/shared';
import { DEFAULT_COUNTRY_CODE } from '@eventreach/shared';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { isEventAuthorized, getAuthorizedEventIds } from '../services/eventAuthService';

/**
 * Optional server-side pagination for contact listings.
 *
 * Pagination is opt-in: a request that sends neither `page` nor `limit` gets
 * the same plain array it always did, so existing callers that legitimately
 * need every contact (the campaign send preview, the Contact Report export)
 * are unaffected. When either parameter is present the response becomes
 * { data, pagination } instead.
 */
const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 200;

/** Escapes user input before it is used inside a RegExp. */
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);

const wantsPagination = (req: Request): boolean =>
  req.query.page !== undefined || req.query.limit !== undefined;

/**
 * Adds the name/phone search to a contact query. The search runs in the
 * database rather than in the browser, so a large event no longer has to ship
 * every contact over the wire to filter four characters.
 */
const applyContactSearch = (query: any, rawSearch: unknown): any => {
  const search = typeof rawSearch === 'string' ? rawSearch.trim() : '';
  if (!search) return query;
  const safe = escapeRegex(search);
  return {
    ...query,
    $or: [
      { fullName: { $regex: safe, $options: 'i' } },
      { phoneNumber: { $regex: safe, $options: 'i' } },
    ],
  };
};

const readPageParams = (req: Request) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
  const requested = parseInt(String(req.query.limit ?? PAGE_SIZE_DEFAULT), 10) || PAGE_SIZE_DEFAULT;
  // Capped so a caller cannot ask for the whole collection in one page.
  const limit = Math.min(PAGE_SIZE_MAX, Math.max(1, requested));
  return { page, limit };
};

/** Runs a contact listing, paginated or not, and sends the response. */
const sendContactList = async (req: Request, res: Response, baseQuery: any) => {
  const query = applyContactSearch(baseQuery, req.query.search);

  if (!wantsPagination(req)) {
    const contacts = await Contact.find(query).sort({ createdAt: -1 }).lean();
    return res.json(contacts);
  }

  const { page, limit } = readPageParams(req);
  const [contacts, total] = await Promise.all([
    Contact.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Contact.countDocuments(query),
  ]);

  return res.json({
    data: contacts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
};

import crypto from 'crypto';

/**
 * One definition of a contact's editable fields, shared by add and update so
 * the two endpoints cannot drift apart. Previously `updateContact` read
 * req.body with no validation at all, so a 10,000-character name or a
 * malformed e-mail could be written straight to the database.
 *
 * `fullName` mirrors the 50-character limit the contact form already enforces.
 * `phoneNumber` is deliberately only checked for presence here; the real rule
 * is normalizeIndianPhone, applied per endpoint because the two paths differ:
 * the manual form rejects an unusable number outright, while bulk import
 * keeps the row flagged 'Invalid' so the uploader can see which lines failed
 * instead of having them silently dropped. `email` uses a generic address
 * check rather than the form's @gmail.com rule, because imported contacts
 * legitimately carry other domains.
 */
const contactFieldsSchema = z.object({
  fullName: z.string().min(1, 'Full name is required').max(50, 'Full name max 50 characters'),
  phoneNumber: z.string().min(1, 'Phone number is required').max(30, 'Phone number is too long'),
  countryCode: z.string().min(1, 'Country code is required').max(8, 'Country code is too long'),
  email: z.string().email('Invalid email address').max(120, 'Email max 120 characters').optional().or(z.literal('')),
});

const createContactSchema = contactFieldsSchema.extend({
  eventId: z.string().min(1, 'Event ID is required'),
});

const updateContactSchema = contactFieldsSchema;

export const addContact = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = createContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    // countryCode is accepted by the schema for backward compatibility but is
    // deliberately not read: this system is India-only, so the stored value is
    // always IN regardless of what a caller sends.
    const { fullName, phoneNumber, email, eventId } = parsed.data;

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    /**
     * A number typed into the form has to be valid before it is stored: an
     * unusable contact in a campaign list is worse than a rejected save,
     * because it is only discovered when the send fails. (Bulk import still
     * keeps unusable rows, flagged Invalid, so an upload is not silently
     * thinned out — those are never messaged.)
     */
    const phone = normalizeIndianPhone(phoneNumber);
    if (!phone.ok) {
      return res.status(400).json({ error: phone.reason });
    }

    let status = 'Valid';
    let validationReason = undefined;
    const normalizedPhone = phone.e164;

    const existing = await Contact.findOne({ eventId, phoneNumber: normalizedPhone });
    if (existing) {
      status = 'Duplicate';
      validationReason = 'Number already exists in this event';
    }

    const contact = await Contact.create({
      fullName,
      phoneNumber: normalizedPhone,
      // Always IN. The number itself is already enforced as Indian, so
      // storing a caller-supplied country would only let the two disagree.
      countryCode: DEFAULT_COUNTRY_CODE,
      email: email || undefined,
      eventId,
      status,
      validationReason,
      source: 'Manual',
    });

    await AuditService.log({
      action: 'CONTACT_CREATED',
      collectionName: 'contacts',
      documentId: contact._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      after: contact,
      description: `Created contact ${contact.fullName} (${contact.phoneNumber})`
    });

    res.status(201).json(contact);
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
};

export const getContactsByEvent = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    return await sendContactList(req, res, { eventId });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

export const uploadAndPreviewContacts = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    let rawContacts: RawContact[] = [];

    if (file.mimetype.includes('pdf')) {
      rawContacts = await extractFromPDF(file.buffer);
    } else {
      rawContacts = extractFromExcel(file.buffer);
    }

    const previewContacts: ExtractedContact[] = [];
    
    const existingContacts = await Contact.find({ eventId }).select('phoneNumber').lean();
    const existingNumbers = new Set(existingContacts.map(c => c.phoneNumber));

    for (let i = 0; i < rawContacts.length; i++) {
      const raw = rawContacts[i];
      let status: 'Valid' | 'Invalid' | 'Duplicate' = 'Valid';
      let validationReason = undefined;
      let normalizedPhone = raw.phoneNumber;

      // Imported rows are kept even when unusable, flagged Invalid, so the
      // uploader can see exactly which lines were rejected and why. Only
      // Valid contacts are ever messaged.
      const imported = normalizeIndianPhone(raw.phoneNumber);
      if (imported.ok) {
        normalizedPhone = imported.e164;
      } else {
        status = 'Invalid';
        validationReason = imported.reason;
      }

      if (status === 'Valid' && existingNumbers.has(normalizedPhone)) {
        status = 'Duplicate';
        validationReason = 'Already in event';
      }

      if (status === 'Valid') {
        const isDuplicateInBatch = previewContacts.some(
          c => c.phoneNumber === normalizedPhone && c.status === 'Valid'
        );
        if (isDuplicateInBatch) {
          status = 'Duplicate';
          validationReason = 'Duplicate in file';
        }
      }

      previewContacts.push({
        id: `temp_${Date.now()}_${i}`,
        fullName: raw.fullName,
        phoneNumber: normalizedPhone,
        countryCode: DEFAULT_COUNTRY_CODE,
        email: raw.email,
        status,
        validationReason
      });
    }

    res.json(previewContacts);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process file' });
  }
};

export const bulkImportContacts = async (req: RequestWithId, res: Response) => {
  const bulkOperationId = `BULK-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
  try {
    const { eventId } = req.params;
    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    const { contacts } = req.body as { contacts: ExtractedContact[] };

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' });
    }

    // The client sends back the preview rows it was given, including a `status`
    // field. That status is untrusted input — a crafted request could mark
    // malformed or duplicate numbers as "Valid". Everything is therefore
    // re-validated here from scratch and the client's status is ignored.
    const existingContacts = await Contact.find({ eventId }).select('phoneNumber').lean();
    const seenNumbers = new Set<string>(existingContacts.map((c: any) => c.phoneNumber));

    const documentsToInsert: any[] = [];

    for (const candidate of contacts) {
      const fullName = typeof candidate?.fullName === 'string' ? candidate.fullName.trim() : '';
      const rawPhone = typeof candidate?.phoneNumber === 'string' ? candidate.phoneNumber.trim() : '';
      const email = typeof candidate?.email === 'string' ? candidate.email.trim() : '';

      if (!fullName || fullName.length > 200 || !rawPhone) continue;

      const confirmed = normalizeIndianPhone(rawPhone);
      if (!confirmed.ok) continue;
      const normalizedPhone = confirmed.e164;

      // Reject duplicates already stored for this event and repeats within the batch.
      if (seenNumbers.has(normalizedPhone)) continue;
      seenNumbers.add(normalizedPhone);

      documentsToInsert.push({
        fullName,
        phoneNumber: normalizedPhone,
        countryCode: DEFAULT_COUNTRY_CODE,
        email: email || undefined,
        eventId,
        status: 'Valid',
        source: 'Bulk Import',
      });
    }

    if (documentsToInsert.length === 0) {
      return res.status(400).json({
        error: 'No valid contacts to import. All rows were invalid or already present.',
      });
    }

    const validContacts = documentsToInsert;

    const result = await Contact.insertMany(documentsToInsert, { ordered: false });

    await AuditService.log({
      action: 'BULK_CONTACT_IMPORTED',
      collectionName: 'contacts',
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      bulkOperationId,
      bulk: {
        isBulk: true,
        operationType: 'IMPORT',
        totalRecords: validContacts.length,
        successfulRecords: result.length,
        failedRecords: validContacts.length - result.length
      },
      description: `Bulk imported ${result.length} contacts`
    });

    res.status(201).json({ 
      importedCount: result.length, 
      totalProcessed: validContacts.length 
    });
  } catch (error: any) {
    if (error.code === 11000) {
      const imported = error.insertedDocs?.length || 0;
      await AuditService.log({
        action: 'BULK_CONTACT_IMPORTED',
        collectionName: 'contacts',
        actor: AuditService.getActorFromReq(req),
        request: AuditService.getRequestInfo(req),
        bulkOperationId,
        bulk: {
          isBulk: true,
          operationType: 'IMPORT',
          successfulRecords: imported
        },
        description: `Bulk imported ${imported} contacts with some duplicates ignored`
      });

      return res.status(207).json({ 
        message: 'Partial success. Some records were ignored due to duplicates.',
        importedCount: imported
      });
    }
    console.error('Bulk import error:', error);
    res.status(500).json({ error: 'Failed to bulk import contacts' });
  }
};

/**
 * Deletes one guest and records it in the audit log.
 *
 * Shared by the single and bulk endpoints so a bulk deletion leaves exactly the
 * same per-guest CONTACT_DELETED trail as deleting them one at a time.
 *
 * Message logs are deliberately left in place. They are the delivery history
 * behind campaign reports, and MessageLog keeps its own contactName and
 * phoneNumber precisely so a report still names the recipient after the guest
 * is gone (the report falls back to those when contactId no longer resolves).
 * Removing them would silently rewrite past campaign results.
 *
 * The caller is responsible for authorizing the guest's event first.
 */
const performContactDeletion = async (
  contact: any,
  req: RequestWithId,
  bulkContext?: { bulkOperationId: string }
): Promise<void> => {
  await Contact.findByIdAndDelete(contact._id);

  await AuditService.log({
    action: 'CONTACT_DELETED',
    collectionName: 'contacts',
    documentId: contact._id.toString(),
    actor: AuditService.getActorFromReq(req),
    request: AuditService.getRequestInfo(req),
    before: contact,
    description: `Deleted contact ${contact.fullName}`,
    ...(bulkContext ? { bulkOperationId: bulkContext.bulkOperationId } : {}),
  });
};

export const deleteContact = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;
    // A malformed id used to reach Contact.findById and throw a CastError,
    // which surfaced as a 500. The request is simply bad, so it is rejected as one.
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, contact.eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    await performContactDeletion(contact, req);

    res.json({ message: 'Contact deleted' });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

/** Same bounds as event bulk delete: one full page at the largest page size. */
const bulkDeleteContactsBody = z.object({
  ids: z
    .array(z.string())
    .min(1, 'Select at least one guest to delete')
    .max(100, 'Cannot delete more than 100 guests in one request'),
});

/**
 * Deletes several guests in one request.
 *
 * Authorization follows deleteContact exactly: each guest is checked against
 * its own event's scope, so batching can never reach a guest the caller could
 * not delete individually. Failures are reported per id, and the response is
 * 207 only when the outcome is genuinely mixed.
 */
export const bulkDeleteContacts = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = bulkDeleteContactsBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    // Duplicates would otherwise read as a "not found" failure the second time.
    const ids = Array.from(new Set(parsed.data.ids));
    const currentUser = (req as any).user;
    const bulkOperationId = `BULK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    const deletedIds: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of ids) {
      try {
        if (!mongoose.Types.ObjectId.isValid(id)) {
          failed.push({ id, reason: 'Invalid contact id' });
          continue;
        }
        const contact = await Contact.findById(id);
        if (!contact) {
          failed.push({ id, reason: 'Contact not found' });
          continue;
        }
        if (!(await isEventAuthorized(currentUser, contact.eventId))) {
          failed.push({ id, reason: 'Access denied' });
          continue;
        }

        await performContactDeletion(contact, req, { bulkOperationId });
        deletedIds.push(id);
      } catch (err) {
        // One bad guest must not abort the rest of the batch.
        console.error(`Bulk delete failed for contact ${id}:`, err);
        failed.push({ id, reason: 'Failed to delete contact' });
      }
    }

    // Summary alongside the per-guest records, as bulk contact import does.
    await AuditService.log({
      action: 'BULK_CONTACT_DELETED',
      collectionName: 'contacts',
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      bulkOperationId,
      bulk: {
        isBulk: true,
        operationType: 'DELETE',
        totalRecords: ids.length,
        successfulRecords: deletedIds.length,
        failedRecords: failed.length,
      },
      description: `Bulk deleted ${deletedIds.length} of ${ids.length} contacts`,
      success: failed.length === 0,
    });

    // 207 only for a genuinely mixed outcome. When nothing was deleted, a batch
    // refused purely on access is a 403 like the single endpoint; any other
    // all-failed batch (bad or missing ids) is a 400.
    const allDenied = failed.length > 0 && failed.every((f) => f.reason === 'Access denied');
    const status =
      failed.length === 0 ? 200 : deletedIds.length > 0 ? 207 : allDenied ? 403 : 400;
    res.status(status).json({ deletedCount: deletedIds.length, deletedIds, failed });
  } catch (error) {
    console.error('Bulk delete contacts error:', error);
    res.status(500).json({ error: 'Failed to delete contacts' });
  }
};

export const updateContact = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;

    // Same rules as addContact — this endpoint previously accepted raw req.body.
    const parsed = updateContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    // countryCode intentionally unread — see addContact.
    const { fullName, phoneNumber, email } = parsed.data;

    const beforeContact = await Contact.findById(id);
    if (!beforeContact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, beforeContact.eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    // Same rule as creating one: an edit must not turn a working contact into
    // an unusable one.
    const phone = normalizeIndianPhone(phoneNumber);
    if (!phone.ok) {
      return res.status(400).json({ error: phone.reason });
    }

    const status = 'Valid';
    const validationReason = undefined;
    const normalizedPhone = phone.e164;

    const afterContact = await Contact.findByIdAndUpdate(
      id,
      {
        fullName,
        phoneNumber: normalizedPhone,
        // Always IN, for the same reason as on create.
        countryCode: DEFAULT_COUNTRY_CODE,
        email: email || undefined,
        status,
        validationReason
      },
      { new: true }
    );

    await AuditService.log({
      action: 'CONTACT_UPDATED',
      collectionName: 'contacts',
      documentId: id,
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: beforeContact,
      after: afterContact,
      description: `Updated contact ${fullName}`
    });

    res.json(afterContact);
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};

export const getAllContacts = async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    const authorizedIds = await getAuthorizedEventIds(currentUser);

    const query: any = {};
    if (authorizedIds !== null) {
      query.eventId = { $in: authorizedIds };
    }

    return await sendContactList(req, res, query);
  } catch (error) {
    console.error('Get all contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};
