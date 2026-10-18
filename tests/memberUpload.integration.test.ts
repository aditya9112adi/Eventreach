import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Uploading a file of guests onto a Sub-Event's member list, over real HTTP
 * against the REAL compiled backend (routes, middleware, controllers, models
 * from backend/dist) on a throwaway database.
 *
 *   POST /api/events/:id/members/upload   preview a .xlsx / .xls / .pdf (saves nothing)
 *   POST /api/events/:id/members          confirm: add the matched contacts
 *
 * What is proved here: the file is read and each row classified; nothing is
 * saved until confirmed; confirming changes THIS sub-event's list only (not the
 * Main Event's guests, nor a sibling's list); no contact is ever created;
 * another organizer's contacts are never matched; and every check is made on
 * the server. Run `npm run build` in backend/ first.
 */

const require = createRequire(import.meta.url);
const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));

const TEST_DB = `mongodb://127.0.0.1:27017/eventreach_memberupload_${Date.now()}`;
process.env.MONGODB_URI = TEST_DB;
process.env.JWT_SECRET = 'integration-test-only-secret';

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const xlsx = backendRequire('xlsx');
const { jsPDF } = backendRequire('jspdf');
const autoTable = backendRequire('jspdf-autotable').default;

const eventRoutes = require('../backend/dist/routes/eventRoutes').default;
const { Contact } = require('../backend/dist/models/Contact');
const { Event } = require('../backend/dist/models/Event');
const { EventMember } = require('../backend/dist/models/EventMember');
const { Admin } = require('../backend/dist/models/Admin');
const { User } = require('../backend/dist/models/User');

let server: any;
let baseUrl = '';
type Res = { status: number; body: any };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const send = (method: string, path: string, token: string | undefined, body?: Buffer, contentType?: string): Promise<Res> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const headers: Record<string, string> = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': contentType!, 'Content-Length': String(body.length) } : {}),
    };
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

const json = (method: string, path: string, token?: string, body?: unknown) =>
  send(method, path, token, body === undefined ? undefined : Buffer.from(JSON.stringify(body)), 'application/json');

interface FilePart { name: string; type: string; content: Buffer; field?: string }
const uploadTo = (eventId: any, token: string | undefined, file: FilePart | null): Promise<Res> => {
  const boundary = `----eventreach${crypto.randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return send('POST', `/api/events/${eventId}/members/upload`, token, Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`);
};

const xlsxFile = (rows: any[][], name = 'guests.xlsx'): FilePart => {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Sheet1');
  return { name, type: XLSX_MIME, content: xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
};

const pdfFile = (rows: (string | number)[][], name = 'guests.pdf'): FilePart => {
  const doc = new jsPDF();
  autoTable(doc, { head: [['Sr.No', 'Guest Name', 'Contact Number']], body: rows });
  return { name, type: 'application/pdf', content: Buffer.from(doc.output('arraybuffer')) };
};

const HEADER = ['Sr.No', 'Guest Name', 'Contact Number'];
const tokenFor = (account: any, role: string) =>
  jwt.sign({ id: account._id, email: account.email, role }, process.env.JWT_SECRET, { expiresIn: '1d' });
const at = (iso: string) => new Date(`${iso}T06:00:00.000Z`);
const fx: any = {};

const mkAdmin = (name: string, role: string) =>
  Admin.create({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`, passwordHash: 'x', role, status: 'Active' });
const mkEvent = (eventName: string, extra: Record<string, any>) =>
  Event.create({
    organizerName: 'Organiser', organizerMobile: BigInt('9112472833'), eventName, eventType: 'Wedding',
    eventDate: at('2027-01-15'), eventTime: at('2027-01-15'), eventVenue: 'Hall', eventStatus: 'Upcoming', ...extra,
  });
const mkContact = (event: any, fullName: string, phoneNumber: string) =>
  Contact.create({ fullName, phoneNumber, countryCode: 'IN', eventId: event._id, source: 'Manual', status: 'Valid' });

// Fictional numbers, one per contact.
const ASHA = '+919876543210';   // Wedding (main of both sub-events)
const DEV = '+919123456780';    // Wedding
const CHITRA = '+919000000003'; // Wedding - already on Reception, never on Haldi
const BALA = '+919000000004';   // Other event of the same organizer
const ESHA = '+919000000005';   // ANOTHER organizer's event

before(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([Event.init(), EventMember.init(), Contact.init()]);

  fx.adminX = await mkAdmin('Admin X', 'Admin');
  fx.adminY = await mkAdmin('Admin Y', 'Admin');
  fx.superAdmin = await mkAdmin('Super', 'SuperAdmin');

  fx.W = await mkEvent('Wedding', { adminId: fx.adminX._id, createdBy: fx.adminX._id });
  fx.O = await mkEvent('Other X Event', { adminId: fx.adminX._id, createdBy: fx.adminX._id });
  fx.B = await mkEvent('Y Birthday', { adminId: fx.adminY._id, createdBy: fx.adminY._id });
  fx.haldi = await mkEvent('Haldi', { adminId: fx.adminX._id, createdBy: fx.adminX._id, parentEventId: fx.W._id });
  fx.reception = await mkEvent('Reception', { adminId: fx.adminX._id, createdBy: fx.adminX._id, parentEventId: fx.W._id });
  fx.haldiY = await mkEvent('Y Sangeet', { adminId: fx.adminY._id, createdBy: fx.adminY._id, parentEventId: fx.B._id });

  fx.asha = await mkContact(fx.W, 'Asha Rao', ASHA);
  fx.dev = await mkContact(fx.W, 'Dev Patel', DEV);
  fx.chitra = await mkContact(fx.W, 'Chitra Nair', CHITRA);
  fx.bala = await mkContact(fx.O, 'Bala Kumar', BALA);
  fx.esha = await mkContact(fx.B, 'Esha Shah', ESHA);

  // Reception already has a member; the uploads below must never change it.
  await EventMember.create({ eventId: fx.reception._id, contactId: fx.chitra._id });

  fx.userW = await User.create({ name: 'Wedding Helper', email: 'helper@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.W._id });
  fx.userO = await User.create({ name: 'Other Helper', email: 'otherhelper@example.com', passwordHash: 'x', status: 'Active', adminId: fx.adminX._id, assignedEventId: fx.O._id });

  fx.x = tokenFor(fx.adminX, 'Admin');
  fx.y = tokenFor(fx.adminY, 'Admin');
  fx.super = tokenFor(fx.superAdmin, 'SuperAdmin');
  fx.userWToken = tokenFor(fx.userW, 'User');
  fx.userOToken = tokenFor(fx.userO, 'User');

  const app = express();
  app.use(express.json());
  app.use('/api/events', eventRoutes);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Everything a preview or an upload must leave exactly as it was. */
const snapshot = async () => ({
  contacts: await Contact.countDocuments({}),
  mainGuests: (await Contact.find({ eventId: fx.W._id }).select('_id').lean()).map((c: any) => String(c._id)).sort(),
  haldi: (await EventMember.find({ eventId: fx.haldi._id }).select('contactId').lean()).map((m: any) => String(m.contactId)).sort(),
  reception: (await EventMember.find({ eventId: fx.reception._id }).select('contactId').lean()).map((m: any) => String(m.contactId)).sort(),
  haldiY: await EventMember.countDocuments({ eventId: fx.haldiY._id }),
  memberships: await EventMember.countDocuments({}),
});

const mixedRows = () => [
  HEADER,
  [1, 'Asha Rao', '9876543210'],        // a contact
  [2, 'Dev Patel', '+91 91234 56780'],  // a contact, written another way
  [3, 'Bala K', '09000000004'],         // a contact of another event of the same organizer
  [4, 'Esha S', '9000000005'],          // ANOTHER organizer's contact: not available
  [5, 'Nobody', '9000000009'],          // not a contact at all
  [6, 'Bad Number', '1234567890'],      // not an Indian mobile
  [7, '', '9000000010'],                // no name
  [8, 'Asha Again', '919876543210'],    // repeats row 1
];

const byStatus = (rows: any[]) => rows.map((r) => r.status);

describe('preview: an Excel file', () => {
  test('every row is classified, and nothing is saved', async () => {
    const before = await snapshot();
    const res = await uploadTo(fx.haldi._id, fx.x, xlsxFile(mixedRows()));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(byStatus(res.body.rows), ['Valid', 'Valid', 'Valid', 'NotFound', 'NotFound', 'Invalid', 'Invalid', 'Duplicate']);
    assert.deepEqual(res.body.counts, { total: 8, valid: 3, duplicate: 1, notFound: 2, invalid: 2 });
    assert.deepEqual(await snapshot(), before, 'a preview writes nothing');
  });

  test('a valid row names the existing contact it matched, in the +91 form contacts are stored in', async () => {
    const res = await uploadTo(fx.haldi._id, fx.x, xlsxFile(mixedRows()));
    const [asha, dev, bala] = res.body.rows;
    assert.equal(asha.contactId, String(fx.asha._id));
    assert.equal(asha.phoneNumber, ASHA);
    assert.equal(asha.matchedName, 'Asha Rao');
    assert.equal(dev.contactId, String(fx.dev._id));
    assert.equal(bala.contactId, String(fx.bala._id), "another event of the same organizer is offered, as in Add Members");
  });

  test('reasons are stated: not a contact, not an Indian mobile, no name, repeated', async () => {
    const res = await uploadTo(fx.haldi._id, fx.x, xlsxFile(mixedRows()));
    const reason = (i: number) => res.body.rows[i].validationReason;
    assert.equal(reason(3), 'Not in your contacts');
    assert.equal(reason(4), 'Not in your contacts');
    assert.match(reason(5), /Indian mobile/);
    assert.equal(reason(6), 'Guest Name is missing.');
    assert.equal(reason(7), 'Duplicate in file');
    assert.equal(res.body.rows[3].contactId, undefined, 'no id is handed out for a number that is not a contact');
  });

  test('an .xls file is read the same way', async () => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADER, [1, 'Asha Rao', '9876543210']]), 'Sheet1');
    const content = xlsx.write(wb, { type: 'buffer', bookType: 'biff8' });
    const res = await uploadTo(fx.haldi._id, fx.x, { name: 'guests.xls', type: 'application/vnd.ms-excel', content });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(byStatus(res.body.rows), ['Valid']);
  });
});

describe('preview: a PDF file', () => {
  test('rows are read and classified like the Excel ones, and nothing is saved', async () => {
    const before = await snapshot();
    const res = await uploadTo(fx.haldi._id, fx.x, pdfFile([
      [1, 'Asha Rao', '+919876543210'],
      [2, 'Esha S', '+919000000005'],
      [3, 'Nobody', '+919000000009'],
      [4, 'Bad Number', '+911234567890'],
      [5, 'Asha Again', '+919876543210'],
    ]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(byStatus(res.body.rows), ['Valid', 'NotFound', 'NotFound', 'Invalid', 'Duplicate']);
    assert.equal(res.body.rows[0].contactId, String(fx.asha._id));
    assert.deepEqual(await snapshot(), before);
  });

  test('a PDF with no guest rows is refused', async () => {
    const res = await uploadTo(fx.haldi._id, fx.x, pdfFile([[1, 'Guest list', 'to follow']]));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'No guests were found in the file.');
  });
});

describe('refused files', () => {
  const refused = async (file: FilePart | null, expected: RegExp) => {
    const before = await snapshot();
    const res = await uploadTo(fx.haldi._id, fx.x, file);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body.error), expected);
    assert.deepEqual(await snapshot(), before);
  };

  test('no file', () => refused(null, /No file provided/));
  test('a file in the wrong form field', () => refused({ ...xlsxFile(mixedRows()), field: 'upload' }, /single file|could not be accepted/));
  test('a CSV or text file (type refused)', async () => {
    await refused({ name: 'guests.csv', type: 'text/csv', content: Buffer.from('Asha,9876543210') }, /Invalid file type/);
    await refused({ name: 'guests.txt', type: 'text/plain', content: Buffer.from('Asha 9876543210') }, /Invalid file type/);
  });
  test('an executable or script named as a sheet', () =>
    refused({ name: 'guests.exe', type: XLSX_MIME, content: xlsxFile(mixedRows()).content }, /Unsupported file type/));
  test('an extension that disagrees with the declared type', () =>
    refused({ ...xlsxFile(mixedRows()), name: 'guests.pdf' }, /does not match its \.pdf extension/));
  test('an empty file', () => refused({ name: 'guests.xlsx', type: XLSX_MIME, content: Buffer.alloc(0) }, /empty/));
  test('content that is not an Excel file, named .xlsx', () =>
    refused({ name: 'guests.xlsx', type: XLSX_MIME, content: Buffer.from('Asha Rao,9876543210\n') }, /not a valid Excel/));
  test('content that is not a PDF, named .pdf', () =>
    refused({ name: 'guests.pdf', type: 'application/pdf', content: Buffer.from('Asha Rao 9876543210') }, /not a valid PDF/));
  test('a file over 10 MB', () =>
    refused({ name: 'guests.xlsx', type: XLSX_MIME, content: Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(10 * 1024 * 1024)]) }, /larger than 10 MB/));
  test('a damaged file with the right first bytes', () =>
    refused({ name: 'guests.xlsx', type: XLSX_MIME, content: Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(200)]) }, /could not be read|No guests|column|Contact Number|Guest Name/i));
  test('a sheet with no Contact Number column names the format', () =>
    refused(xlsxFile([['Sr.No', 'Guest Name'], [1, 'Asha Rao']]), /Contact Number/));
  test('a sheet with no Guest Name column', () =>
    refused(xlsxFile([['Sr.No', 'Contact Number'], [1, '9876543210']]), /Guest Name/));
  test('unrecognised headings are repeated back', () =>
    refused(xlsxFile([['Column A', 'Column B'], ['x', 'y']]), /Column A, Column B/));
  test('a sheet with only a header row', () => refused(xlsxFile([HEADER]), /No guests were found/));
  test('more rows than one upload may carry', () => {
    const rows: any[][] = [HEADER];
    for (let i = 0; i < 5001; i++) rows.push([i + 1, `Guest ${i}`, '9000000009']);
    return refused(xlsxFile(rows), /more than 5000 rows/);
  });
});

describe('confirming adds to THIS sub-event only', () => {
  test('the matched contacts become members of Haldi; nothing else changes and no contact is created', async () => {
    const before = await snapshot();
    const preview = await uploadTo(fx.haldi._id, fx.x, xlsxFile(mixedRows()));
    const ids = preview.body.rows.filter((r: any) => r.status === 'Valid').map((r: any) => r.contactId);
    assert.equal(ids.length, 3);

    const confirm = await json('POST', `/api/events/${fx.haldi._id}/members`, fx.x, { contactIds: ids });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.equal(confirm.body.addedCount, 3);
    assert.equal(confirm.body.alreadyMemberCount, 0);
    assert.equal(confirm.body.memberCount, 3);

    const after = await snapshot();
    assert.deepEqual(after.haldi, [String(fx.asha._id), String(fx.dev._id), String(fx.bala._id)].sort(), 'Haldi has exactly the uploaded matches');
    assert.deepEqual(after.mainGuests, before.mainGuests, "the Main Event's guest list is unchanged");
    assert.equal(after.contacts, before.contacts, 'no contact was created');
    assert.deepEqual(after.reception, before.reception, "a sibling sub-event's list is unchanged");
    assert.equal(after.haldiY, before.haldiY, "another organizer's sub-event is unchanged");
    assert.equal(after.memberships, before.memberships + 3);
  });

  test('uploading the same file again finds every matched row already a member, and adds nothing', async () => {
    const before = await snapshot();
    const res = await uploadTo(fx.haldi._id, fx.x, xlsxFile(mixedRows()));
    assert.deepEqual(byStatus(res.body.rows), ['Duplicate', 'Duplicate', 'Duplicate', 'NotFound', 'NotFound', 'Invalid', 'Invalid', 'Duplicate']);
    assert.equal(res.body.rows[0].validationReason, 'Already a member of this sub-event');
    assert.equal(res.body.counts.valid, 0);

    // Even if a client confirms the ids anyway, nobody is duplicated.
    const ids = res.body.rows.filter((r: any) => r.contactId).map((r: any) => r.contactId);
    const again = await json('POST', `/api/events/${fx.haldi._id}/members`, fx.x, { contactIds: ids });
    assert.equal(again.status, 200);
    assert.equal(again.body.addedCount, 0);
    assert.equal(again.body.alreadyMemberCount, 3);
    assert.deepEqual(await snapshot(), before);
  });

  test("existing members are kept when more are uploaded - the list is never replaced", async () => {
    const res = await uploadTo(fx.haldi._id, fx.x, xlsxFile([HEADER, [1, 'Chitra Nair', '9000000003']]));
    assert.deepEqual(byStatus(res.body.rows), ['Valid']);
    const add = await json('POST', `/api/events/${fx.haldi._id}/members`, fx.x, { contactIds: [res.body.rows[0].contactId] });
    assert.equal(add.body.addedCount, 1);
    assert.equal(add.body.memberCount, 4);
    const list = await json('GET', `/api/events/${fx.haldi._id}/members`, fx.x);
    assert.deepEqual(list.body.map((c: any) => c.fullName).sort(), ['Asha Rao', 'Bala Kumar', 'Chitra Nair', 'Dev Patel']);
    // Chitra is now on both lists; Reception still has just her.
    const reception = await json('GET', `/api/events/${fx.reception._id}/members`, fx.x);
    assert.deepEqual(reception.body.map((c: any) => c.fullName), ['Chitra Nair']);
  });

  test('a partial confirm is reported per id: one added, one refused, nothing assumed', async () => {
    // Reception gets Asha through a valid id; the other organizer's contact is refused by the server.
    const before = await snapshot();
    const res = await json('POST', `/api/events/${fx.reception._id}/members`, fx.x, { contactIds: [String(fx.asha._id), String(fx.esha._id)] });
    assert.equal(res.status, 207, JSON.stringify(res.body));
    assert.equal(res.body.addedCount, 1);
    assert.equal(res.body.rejected.length, 1);
    assert.equal(res.body.rejected[0].id, String(fx.esha._id));
    assert.equal(res.body.rejected[0].reason, 'Access denied');
    const after = await snapshot();
    assert.equal(after.memberships, before.memberships + 1);
    assert.equal(after.haldi.length, before.haldi.length, 'Haldi is untouched by an add to Reception');
  });

  test("a contact id of another organizer cannot be confirmed even if a client makes one up", async () => {
    const before = await snapshot();
    const res = await json('POST', `/api/events/${fx.haldi._id}/members`, fx.x, { contactIds: [String(fx.esha._id)] });
    assert.equal(res.status, 403);
    assert.deepEqual(await snapshot(), before);
  });
});

describe('what is matched depends on who is uploading', () => {
  test("another organizer's contact is never matched, even for a Super Admin", async () => {
    for (const token of [fx.x, fx.super]) {
      const res = await uploadTo(fx.haldi._id, token, xlsxFile([HEADER, [1, 'Esha S', '9000000005']]));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.rows[0].status, 'NotFound');
    }
  });

  test('another organizer uploads to their own sub-event and matches only their own contacts', async () => {
    const res = await uploadTo(fx.haldiY._id, fx.y, xlsxFile([HEADER, [1, 'Esha S', '9000000005'], [2, 'Asha Rao', '9876543210']]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(byStatus(res.body.rows), ['Valid', 'NotFound']);
    assert.equal(res.body.rows[0].contactId, String(fx.esha._id));
  });

  test("a number held by two of the caller's events resolves to this sub-event's own Main Event", async () => {
    const twin = await mkContact(fx.O, 'Asha At Other', ASHA);
    try {
      const res = await uploadTo(fx.reception._id, fx.x, xlsxFile([HEADER, [1, 'Asha', '9876543210']]));
      assert.equal(res.body.rows[0].contactId, String(fx.asha._id), "the Wedding's Asha, not the other event's");
      assert.notEqual(res.body.rows[0].contactId, String(twin._id));
    } finally {
      await Contact.deleteOne({ _id: twin._id });
    }
  });
});

describe('authorization is enforced on the server', () => {
  const file = () => xlsxFile(mixedRows());

  test('no token is refused', async () => {
    assert.equal((await uploadTo(fx.haldi._id, undefined, file())).status, 401);
  });

  test("another organizer's Admin cannot upload to this sub-event", async () => {
    const before = await snapshot();
    const res = await uploadTo(fx.haldi._id, fx.y, file());
    assert.equal(res.status, 403);
    assert.deepEqual(await snapshot(), before);
  });

  test("a User assigned to a different event cannot", async () => {
    assert.equal((await uploadTo(fx.haldi._id, fx.userOToken, file())).status, 403);
  });

  test("a User assigned to the Main Event may preview, as they may work on its members", async () => {
    const res = await uploadTo(fx.haldi._id, fx.userWToken, file());
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test('a Main Event has no member list to upload to', async () => {
    const res = await uploadTo(fx.W._id, fx.x, file());
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Only a sub-event has a member list/);
  });

  test('a malformed or unknown event id', async () => {
    assert.equal((await uploadTo('not-an-id', fx.x, file())).status, 400);
    assert.equal((await uploadTo(new mongoose.Types.ObjectId(), fx.super, file())).status, 404);
  });

  test('a refused request saves nothing', async () => {
    const before = await snapshot();
    await uploadTo(fx.haldi._id, fx.y, file());
    await uploadTo(fx.W._id, fx.x, file());
    assert.deepEqual(await snapshot(), before);
  });
});
