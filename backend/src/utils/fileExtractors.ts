import * as xlsx from 'xlsx';
const pdf = require('pdf-parse');

export interface RawContact {
  fullName: string;
  phoneNumber: string;
  email?: string;
}

export const extractFromExcel = (buffer: Buffer): RawContact[] => {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  
  // Convert sheet to JSON
  const rows: any[] = xlsx.utils.sheet_to_json(sheet);
  
  const contacts: RawContact[] = [];

  for (const row of rows) {
    // Find keys that might match our fields
    const keys = Object.keys(row);
    
    // Simple heuristic: look for "name" and "phone" in the column headers
    const nameKey = keys.find(k => k.toLowerCase().includes('name'));
    const phoneKey = keys.find(k => k.toLowerCase().includes('phone') || k.toLowerCase().includes('mobile') || k.toLowerCase().includes('number'));
    const emailKey = keys.find(k => k.toLowerCase().includes('email'));

    if (phoneKey) {
      contacts.push({
        fullName: nameKey ? String(row[nameKey]).trim() : 'Unknown Guest',
        phoneNumber: String(row[phoneKey]).replace(/[^0-9+]/g, ''),
        email: emailKey ? String(row[emailKey]).trim() : undefined,
      });
    }
  }

  return contacts;
};

export const extractFromPDF = async (buffer: Buffer): Promise<RawContact[]> => {
  const data = await pdf(buffer);
  const text = data.text;
  
  const contacts: RawContact[] = [];
  
  // Basic Regex for phone numbers (looks for international or local formats)
  // This can be improved depending on the exact PDF structures
  const phoneRegex = /(?:\+?\d{1,3}[-\s]?)?\(?\d{3}\)?[-\s]?\d{3}[-\s]?\d{4}/g;
  
  const matches = text.match(phoneRegex);
  
  if (matches) {
    for (const match of matches) {
      contacts.push({
        fullName: 'Unknown Guest (PDF)', // Hard to reliably extract names from unstructured PDF
        phoneNumber: match.replace(/[^0-9+]/g, ''),
      });
    }
  }
  
  // Remove duplicates from the raw extraction
  const uniqueContacts = Array.from(new Map(contacts.map(c => [c.phoneNumber, c])).values());
  
  return uniqueContacts;
};
