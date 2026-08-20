import { Request, Response } from 'express';
import { z } from 'zod';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { Contact } from '../models/Contact';
import { extractFromExcel, extractFromPDF, RawContact } from '../utils/fileExtractors';
import type { ExtractedContact } from '@eventreach/shared';

const createContactSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  countryCode: z.string().min(1, 'Country code is required'),
  email: z.string().email().optional().or(z.literal('')),
  eventId: z.string().min(1, 'Event ID is required'),
});

export const addContact = async (req: Request, res: Response) => {
  try {
    const parsed = createContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { fullName, phoneNumber, countryCode, email, eventId } = parsed.data;

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

    // Check duplicate
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

    res.status(201).json(contact);
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
};

export const getContactsByEvent = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const contacts = await Contact.find({ eventId }).sort({ createdAt: -1 });
    res.json(contacts);
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

export const uploadAndPreviewContacts = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const file = req.file;
    const countryCode = req.body.countryCode || 'US';

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
    
    // Existing numbers in event to check duplicates
    const existingContacts = await Contact.find({ eventId }).select('phoneNumber');
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
      
      // Also check against duplicates IN the file itself
      if (status === 'Valid') {
        const fileDuplicate = previewContacts.find(c => c.phoneNumber === normalizedPhone);
        if (fileDuplicate) {
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

export const bulkImportContacts = async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const { contacts } = req.body as { contacts: ExtractedContact[] };

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts provided' });
    }

    // Only import Valid contacts
    const validContacts = contacts.filter(c => c.status === 'Valid');

    const documentsToInsert = validContacts.map(c => ({
      fullName: c.fullName,
      phoneNumber: c.phoneNumber,
      countryCode: c.countryCode,
      email: c.email || undefined,
      eventId,
      status: 'Valid',
      source: 'Bulk Import',
    }));

    // Use unordered insertMany so if some fail due to unique constraint, others continue
    const result = await Contact.insertMany(documentsToInsert, { ordered: false });

    res.status(201).json({ 
      importedCount: result.length, 
      totalProcessed: validContacts.length 
    });
  } catch (error: any) {
    if (error.code === 11000) {
      // Bulk write error for duplicates
      console.error('Bulk import duplicate error');
      return res.status(207).json({ 
        message: 'Partial success. Some records were ignored due to duplicates.',
        importedCount: error.insertedDocs?.length || 0 
      });
    }
    console.error('Bulk import error:', error);
    res.status(500).json({ error: 'Failed to bulk import contacts' });
  }
};

export const deleteContact = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const contact = await Contact.findByIdAndDelete(id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    res.json({ message: 'Contact deleted' });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

export const updateContact = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { fullName, phoneNumber, countryCode, email } = req.body;

    // Re-validate phone number
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

    const contact = await Contact.findByIdAndUpdate(
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

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json(contact);
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};
