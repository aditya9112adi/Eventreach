import { Request, Response } from 'express';
import { z } from 'zod';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
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

const createContactSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  countryCode: z.string().min(1, 'Country code is required'),
  email: z.string().email().optional().or(z.literal('')),
  eventId: z.string().min(1, 'Event ID is required'),
});

export const addContact = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = createContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { fullName, phoneNumber, countryCode, email, eventId } = parsed.data;

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    let status = 'Valid';
    let validationReason = undefined;
    let normalizedPhone = phoneNumber;

    try {
      const phoneNumberObj = parsePhoneNumberWithError(phoneNumber, countryCode as any);
      if (!phoneNumberObj.isValid()) {
        status = 'Invalid';
        validationReason = 'Invalid phone number format for country';
      } else {
        normalizedPhone = phoneNumberObj.format('E.164');
      }
    } catch (error: any) {
      status = 'Invalid';
      validationReason = error.message || 'Error parsing phone number';
    }

    const existing = await Contact.findOne({ eventId, phoneNumber: normalizedPhone });
    if (existing) {
      status = 'Duplicate';
      validationReason = 'Number already exists in this event';
    }

    const contact = await Contact.create({
      fullName,
      phoneNumber: normalizedPhone,
      countryCode,
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
    const countryCode = req.body.countryCode || DEFAULT_COUNTRY_CODE;

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

      try {
        const phoneNumberObj = parsePhoneNumberWithError(raw.phoneNumber, countryCode as any);
        if (!phoneNumberObj.isValid()) {
          status = 'Invalid';
          validationReason = 'Invalid format';
        } else {
          normalizedPhone = phoneNumberObj.format('E.164');
        }
      } catch (error: any) {
        status = 'Invalid';
        validationReason = 'Error parsing';
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
        countryCode,
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
      const countryCode =
        typeof candidate?.countryCode === 'string' && candidate.countryCode.trim()
          ? candidate.countryCode.trim()
          : DEFAULT_COUNTRY_CODE;
      const email = typeof candidate?.email === 'string' ? candidate.email.trim() : '';

      if (!fullName || fullName.length > 200 || !rawPhone) continue;

      let normalizedPhone: string;
      try {
        const phoneNumberObj = parsePhoneNumberWithError(rawPhone, countryCode as any);
        if (!phoneNumberObj.isValid()) continue;
        normalizedPhone = phoneNumberObj.format('E.164');
      } catch {
        continue;
      }

      // Reject duplicates already stored for this event and repeats within the batch.
      if (seenNumbers.has(normalizedPhone)) continue;
      seenNumbers.add(normalizedPhone);

      documentsToInsert.push({
        fullName,
        phoneNumber: normalizedPhone,
        countryCode,
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

export const deleteContact = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;
    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, contact.eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }
    
    await Contact.findByIdAndDelete(id);

    await AuditService.log({
      action: 'CONTACT_DELETED',
      collectionName: 'contacts',
      documentId: id,
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: contact,
      description: `Deleted contact ${contact.fullName}`
    });

    res.json({ message: 'Contact deleted' });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

export const updateContact = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;
    const { fullName, phoneNumber, countryCode, email } = req.body;

    const beforeContact = await Contact.findById(id);
    if (!beforeContact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const currentUser = (req as any).user;
    const authorized = await isEventAuthorized(currentUser, beforeContact.eventId);
    if (!authorized) {
      return res.status(403).json({ error: 'Access denied. You do not have access to this event.' });
    }

    let status = 'Valid';
    let validationReason = undefined;
    let normalizedPhone = phoneNumber;

    try {
      const phoneNumberObj = parsePhoneNumberWithError(phoneNumber, countryCode as any);
      if (!phoneNumberObj.isValid()) {
        status = 'Invalid';
        validationReason = 'Invalid phone number format';
      } else {
        normalizedPhone = phoneNumberObj.format('E.164');
      }
    } catch (error: any) {
      status = 'Invalid';
      validationReason = error.message || 'Error parsing phone number';
    }

    const afterContact = await Contact.findByIdAndUpdate(
      id,
      {
        fullName,
        phoneNumber: normalizedPhone,
        countryCode,
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
