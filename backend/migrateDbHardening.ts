/**
 * EventReach — database hardening for ALL collections.
 *
 * Makes MongoDB the final enforcement layer for the rules the UI, the API and
 * Mongoose already apply, backfills the human-readable Event ID, and corrects
 * the two BSON types that are wrong for their purpose.
 *
 * Default mode is --dry-run. Nothing is written unless --apply is passed.
 *
 *   npx ts-node migrateDbHardening.ts            # dry run (default)
 *   npx ts-node migrateDbHardening.ts --dry-run  # explicit
 *   npx ts-node migrateDbHardening.ts --apply    # perform the migration
 *
 * DESIGN RULES FOLLOWED
 * ---------------------
 * - Only rules that already exist in the application are enforced. Nothing is
 *   invented. Where no limit exists today (campaigns.messageText, account
 *   names, messagelogs.errorReason) none is imposed; the dry-run reports the
 *   longest stored value so a limit can be chosen deliberately later.
 * - Historical data is preserved. contacts.phoneNumber keeps no pattern because
 *   unparseable numbers are stored as typed with status 'Invalid' on purpose;
 *   contacts.email keeps no pattern because imported addresses are not all
 *   @gmail.com; contacts.countryCode is not enumerated because bulk import
 *   takes it from the uploaded file.
 * - No silent rounding, truncation, guessing or deletion. A value that cannot
 *   be converted deterministically aborts the migration and is reported.
 * - eventTime stays Int32 minutes-since-midnight (the event's date lives in
 *   eventDate); it is constrained to 0..1439 rather than converted to a Date.
 * - ObjectId references stay ObjectId. eventId is a separate human-readable
 *   identifier and never replaces _id.
 * - auditlogs gets a loose validator only: changes.before / changes.after /
 *   metadata are Schema.Types.Mixed by design and must keep accepting arbitrary
 *   snapshots. A validator must never make audit logging itself fail.
 *
 * BACKUP (run this first — non-negotiable)
 *   mongodump --uri="$MONGODB_URI" --out=./backup-$(date +%Y%m%d-%H%M%S)
 *
 * ROLLBACK
 *   Validators: db.runCommand({ collMod: "<name>", validator: {}, validationLevel: "off" })
 *   Data:       mongorestore --uri="$MONGODB_URI" --drop ./backup-<stamp>
 *   eventId and the counters collection are additive; dropping them is safe.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

// ── Rules that already exist in the application ──────────────────────────────
const EVENT_LIMITS = { organizerName: 50, eventName: 20, eventType: 20, eventVenue: 50, eventDescription: 256 };
const EVENT_STATUSES = ['Upcoming', 'Completed', 'Cancelled'];
const CONTACT_STATUSES = ['Valid', 'Invalid', 'Duplicate'];
const CONTACT_SOURCES = ['Manual', 'Bulk Import'];
const CAMPAIGN_STATUSES = ['Draft', 'Scheduled', 'Sending', 'Completed'];
const MEDIA_TYPES = ['image', 'video', 'audio', 'document'];
const MESSAGE_STATUSES = ['Pending', 'Sent', 'Delivered', 'Failed'];
const ACCOUNT_STATUSES = ['Pending', 'Active', 'Rejected'];
const ADMIN_ROLES = ['SuperAdmin', 'Admin'];
const DURATION_UNITS = ['minutes', 'hours', 'days'];
const SETTINGS_KEYS = ['whatsapp_token', 'whatsapp_phone_id', 'default_country_code', 'company_name', 'webhook_verify_token'];
const SETTINGS_VALUE_MAX = 2000;
const CONTACT_FULLNAME_MAX = 50;

const MOBILE_10 = /^[0-9]{10}$/;
const EVENT_ID_RE = /^EVT-\d{6,}$/;

type Problem = { collection: string; _id: string; field: string; detail: string; blocking: boolean };
const problems: Problem[] = [];
const note = (collection: string, _id: any, field: string, detail: string, blocking = true) =>
  problems.push({ collection, _id: String(_id), field, detail, blocking });

const isObjectId = (v: any) => v instanceof mongoose.Types.ObjectId;
const isDate = (v: any) => v instanceof Date && !isNaN(v.getTime());
const isStr = (v: any) => typeof v === 'string';
const isInt = (v: any) => typeof v === 'number' && Number.isInteger(v);

/** Longest string seen for a field — used to report where no limit exists yet. */
const maxLen: Record<string, number> = {};
const trackLen = (key: string, v: any) => {
  if (isStr(v)) maxLen[key] = Math.max(maxLen[key] ?? 0, v.length);
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (backend/.env)');

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN — no writes'}\n`);

  const col = (n: string) => db.collection(n);
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const has = (n: string) => names.includes(n);

  // ══ 1. AUDIT ══════════════════════════════════════════════════════════════
  console.log('══ Pre-flight audit ══════════════════════════════════════════\n');

  // ── events ───────────────────────────────────────────────────────────────
  const events = has('events') ? await col('events').find({}).sort({ createdAt: 1, _id: 1 }).toArray() : [];
  const seenEventIds = new Map<string, string>();
  let needEventId = 0, needMobileConv = 0;

  for (const e of events) {
    const id = e._id;
    if (e.eventId === undefined) needEventId++;
    else if (!isStr(e.eventId) || !EVENT_ID_RE.test(e.eventId)) note('events', id, 'eventId', `malformed: ${JSON.stringify(e.eventId)}`);
    else if (seenEventIds.has(e.eventId)) note('events', id, 'eventId', `duplicate of ${seenEventIds.get(e.eventId)}: ${e.eventId}`);
    else seenEventIds.set(e.eventId, String(id));

    const m = e.organizerMobile;
    if (isStr(m) && MOBILE_10.test(m)) { /* already correct */ }
    else if (typeof m === 'number' && Number.isInteger(m) && MOBILE_10.test(String(m))) needMobileConv++;
    else note('events', id, 'organizerMobile', `cannot form 10 digits from ${JSON.stringify(m)}`);

    if (!isInt(e.eventTime) || e.eventTime < 0 || e.eventTime > 1439)
      note('events', id, 'eventTime', `not an integer in 0..1439: ${JSON.stringify(e.eventTime)}`);
    if (!isDate(e.eventDate)) note('events', id, 'eventDate', `not a Date: ${JSON.stringify(e.eventDate)}`);
    if (!EVENT_STATUSES.includes(e.eventStatus)) note('events', id, 'eventStatus', `invalid: ${JSON.stringify(e.eventStatus)}`);

    for (const [f, max] of Object.entries(EVENT_LIMITS)) {
      const v = e[f];
      const optional = f === 'eventDescription';
      if (!optional && (!isStr(v) || !v.trim())) note('events', id, f, 'required but empty/missing');
      else if (isStr(v) && v.length > max) note('events', id, f, `length ${v.length} > ${max}`);
    }
    for (const f of ['createdBy', 'adminId', 'assignedUserId']) {
      if (e[f] != null && !isObjectId(e[f])) note('events', id, f, `not an ObjectId: ${JSON.stringify(e[f])}`);
    }
  }

  // ── contacts ─────────────────────────────────────────────────────────────
  const contacts = has('contacts') ? await col('contacts').find({}).toArray() : [];
  for (const c of contacts) {
    const id = c._id;
    if (!isObjectId(c.eventId)) note('contacts', id, 'eventId', `not an ObjectId: ${JSON.stringify(c.eventId)}`);
    if (!isStr(c.fullName) || !c.fullName.trim()) note('contacts', id, 'fullName', 'required but empty/missing');
    else if (c.fullName.length > CONTACT_FULLNAME_MAX) note('contacts', id, 'fullName', `length ${c.fullName.length} > ${CONTACT_FULLNAME_MAX}`);
    if (!isStr(c.phoneNumber)) note('contacts', id, 'phoneNumber', `not a string: ${JSON.stringify(c.phoneNumber)}`);
    if (!isStr(c.countryCode)) note('contacts', id, 'countryCode', `not a string: ${JSON.stringify(c.countryCode)}`);
    if (c.email != null && !isStr(c.email)) note('contacts', id, 'email', 'not a string');
    if (!CONTACT_STATUSES.includes(c.status)) note('contacts', id, 'status', `invalid: ${JSON.stringify(c.status)}`);
    if (!CONTACT_SOURCES.includes(c.source)) note('contacts', id, 'source', `invalid: ${JSON.stringify(c.source)}`);
    if (c.tags != null && (!Array.isArray(c.tags) || c.tags.some((t: any) => !isStr(t))))
      note('contacts', id, 'tags', 'not an array of strings');
    trackLen('contacts.email', c.email);
    trackLen('contacts.phoneNumber', c.phoneNumber);
  }

  // ── campaigns ────────────────────────────────────────────────────────────
  const campaigns = has('campaigns') ? await col('campaigns').find({}).toArray() : [];
  for (const c of campaigns) {
    const id = c._id;
    if (!isObjectId(c.eventId)) note('campaigns', id, 'eventId', `not an ObjectId: ${JSON.stringify(c.eventId)}`);
    if (c.messageText != null && !isStr(c.messageText)) note('campaigns', id, 'messageText', 'not a string');
    if (!CAMPAIGN_STATUSES.includes(c.status)) note('campaigns', id, 'status', `invalid: ${JSON.stringify(c.status)}`);
    const checkAtt = (arr: any, where: string) => {
      if (arr == null) return;
      if (!Array.isArray(arr)) return note('campaigns', id, where, 'not an array');
      for (const a of arr) {
        if (!a || typeof a !== 'object') note('campaigns', id, where, 'item is not an object');
        else if (!isStr(a.url) || !isStr(a.filename) || !MEDIA_TYPES.includes(a.type))
          note('campaigns', id, where, `bad attachment ${JSON.stringify(a)}`);
      }
    };
    checkAtt(c.mediaAttachments, 'mediaAttachments');
    if (c.history != null) {
      if (!Array.isArray(c.history)) note('campaigns', id, 'history', 'not an array');
      else c.history.forEach((h: any) => checkAtt(h?.mediaAttachments, 'history.mediaAttachments'));
    }
    trackLen('campaigns.messageText', c.messageText);
  }

  // ── messagelogs ──────────────────────────────────────────────────────────
  const logs = has('messagelogs') ? await col('messagelogs').find({}).toArray() : [];
  for (const l of logs) {
    const id = l._id;
    if (!isObjectId(l.campaignId)) note('messagelogs', id, 'campaignId', 'not an ObjectId');
    if (!isObjectId(l.contactId)) note('messagelogs', id, 'contactId', 'not an ObjectId');
    if (!isStr(l.phoneNumber)) note('messagelogs', id, 'phoneNumber', 'not a string');
    if (!MESSAGE_STATUSES.includes(l.status)) note('messagelogs', id, 'status', `invalid: ${JSON.stringify(l.status)}`);
    trackLen('messagelogs.errorReason', l.errorReason);
  }

  // ── admins / users ───────────────────────────────────────────────────────
  let needDurationConv = 0;
  for (const [name, roleRequired] of [['admins', true], ['users', false]] as [string, boolean][]) {
    const docs = has(name) ? await col(name).find({}).toArray() : [];
    for (const a of docs) {
      const id = a._id;
      for (const f of ['name', 'email', 'passwordHash']) {
        if (!isStr(a[f]) || !a[f].trim()) note(name, id, f, 'required but empty/missing');
      }
      if (roleRequired && !ADMIN_ROLES.includes(a.role)) note(name, id, 'role', `invalid: ${JSON.stringify(a.role)}`);
      if (!ACCOUNT_STATUSES.includes(a.status)) note(name, id, 'status', `invalid: ${JSON.stringify(a.status)}`);

      const d = a.accessDurationValue;
      if (d != null) {
        if (typeof d !== 'number') note(name, id, 'accessDurationValue', `not a number: ${JSON.stringify(d)}`);
        else if (!Number.isInteger(d)) note(name, id, 'accessDurationValue', `NON-INTEGRAL (${d}) — will not be rounded; resolve manually`);
        else if (d < 0) note(name, id, 'accessDurationValue', `negative: ${d}`);
        else needDurationConv++; // integral Double -> Int32 is deterministic
      }
      if (a.accessDurationUnit != null && !DURATION_UNITS.includes(a.accessDurationUnit))
        note(name, id, 'accessDurationUnit', `invalid: ${JSON.stringify(a.accessDurationUnit)}`);
      if (a.isAccessCancelled != null && typeof a.isAccessCancelled !== 'boolean')
        note(name, id, 'isAccessCancelled', 'not a boolean');
      for (const f of ['approvedBy', 'rejectedBy', 'adminId', 'assignedEventId']) {
        if (a[f] != null && !isObjectId(a[f])) note(name, id, f, `not an ObjectId: ${JSON.stringify(a[f])}`);
      }
      for (const f of ['accessGrantedOn', 'accessStartDate', 'accessExpiryDate', 'pendingAccessStartDate',
                       'pendingAccessEndDate', 'approvedAt', 'rejectedAt', 'passwordChangedAt', 'createdAt', 'updatedAt']) {
        if (a[f] != null && !isDate(a[f])) note(name, id, f, `not a Date: ${JSON.stringify(a[f])}`);
      }
      trackLen(`${name}.name`, a.name);
      trackLen(`${name}.email`, a.email);
    }
  }

  // ── settings ─────────────────────────────────────────────────────────────
  const settings = has('settings') ? await col('settings').find({}).toArray() : [];
  for (const s of settings) {
    if (!SETTINGS_KEYS.includes(s.key)) note('settings', s._id, 'key', `not an allowed key: ${JSON.stringify(s.key)}`);
    if (s.value != null && !isStr(s.value)) note('settings', s._id, 'value', 'not a string');
    else if (isStr(s.value) && s.value.length > SETTINGS_VALUE_MAX)
      note('settings', s._id, 'value', `length ${s.value.length} > ${SETTINGS_VALUE_MAX}`);
    trackLen('settings.value', s.value);
  }

  // ── counters ─────────────────────────────────────────────────────────────
  const counters = has('counters') ? await col('counters').find({}).toArray() : [];
  for (const c of counters) {
    if (!isStr(c._id)) note('counters', c._id, '_id', 'not a string');
    if (!isInt(c.seq) || c.seq < 0) note('counters', c._id, 'seq', `not a non-negative integer: ${JSON.stringify(c.seq)}`);
  }

  // ── auditlogs (loose — Mixed fields deliberately unchecked) ───────────────
  const auditCount = has('auditlogs') ? await col('auditlogs').countDocuments() : 0;
  if (has('auditlogs')) {
    const bad = await col('auditlogs').countDocuments({
      $or: [{ timestamp: { $not: { $type: 'date' } } }, { action: { $not: { $type: 'string' } } },
            { collectionName: { $not: { $type: 'string' } } }],
    });
    if (bad > 0) note('auditlogs', '(various)', 'timestamp/action/collectionName', `${bad} document(s) with a wrong top-level type`);
  }

  // ── report ───────────────────────────────────────────────────────────────
  const counts: Record<string, number> = {
    events: events.length, contacts: contacts.length, campaigns: campaigns.length,
    messagelogs: logs.length, admins: has('admins') ? await col('admins').countDocuments() : 0,
    users: has('users') ? await col('users').countDocuments() : 0,
    auditlogs: auditCount, settings: settings.length, counters: counters.length,
  };
  console.log('Document counts:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(13)} ${v}`);

  console.log('\nDeterministic conversions pending:');
  console.log(`  events.eventId to backfill            : ${needEventId}`);
  console.log(`  events.organizerMobile Double->String : ${needMobileConv}`);
  console.log(`  access duration Double->Int32         : ${needDurationConv}`);

  console.log('\nLongest stored value (fields with no limit today — informational):');
  for (const [k, v] of Object.entries(maxLen).sort()) console.log(`  ${k.padEnd(26)} ${v}`);

  const blocking = problems.filter((p) => p.blocking);
  console.log(`\nProblems found: ${problems.length} (blocking: ${blocking.length})`);
  for (const p of problems.slice(0, 80)) console.log(`  [${p.collection}] ${p._id} ${p.field}: ${p.detail}`);
  if (problems.length > 80) console.log(`  ... and ${problems.length - 80} more`);

  if (DRY_RUN) {
    console.log(`\n${blocking.length ? '⚠ BLOCKING problems exist — resolve them before --apply.' : '✓ No blocking problems. Re-run with --apply.'}`);
    await mongoose.disconnect();
    process.exit(blocking.length ? 2 : 0);
  }

  if (blocking.length) {
    console.error(`\n✗ Refusing to apply: ${blocking.length} blocking problem(s). Nothing was changed.`);
    await mongoose.disconnect();
    process.exit(2);
  }

  // ══ 2. CONVERSIONS (deterministic only) ═══════════════════════════════════
  console.log('\n══ Applying ══════════════════════════════════════════════════\n');

  // events.eventId backfill via the atomic counter, seeded past any existing id
  let maxSeq = 0;
  for (const e of events) {
    if (isStr(e.eventId)) {
      const n = parseInt(e.eventId.replace(/^EVT-/, ''), 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  await col('counters').updateOne({ _id: 'events' as any }, { $max: { seq: maxSeq } }, { upsert: true });

  let assigned = 0;
  for (const e of events) {
    if (e.eventId !== undefined) continue;
    const r: any = await col('counters').findOneAndUpdate(
      { _id: 'events' as any }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
    );
    const seq = r?.value?.seq ?? r?.seq;
    await col('events').updateOne({ _id: e._id }, { $set: { eventId: `EVT-${String(seq).padStart(6, '0')}` } });
    assigned++;
  }
  console.log(`✓ events.eventId backfilled          : ${assigned}`);

  let mob = 0;
  for (const e of events) {
    if (isStr(e.organizerMobile)) continue;
    await col('events').updateOne({ _id: e._id }, { $set: { organizerMobile: String(e.organizerMobile) } });
    mob++;
  }
  console.log(`✓ events.organizerMobile -> String   : ${mob}`);

  let dur = 0;
  for (const name of ['admins', 'users']) {
    if (!has(name)) continue;
    for (const a of await col(name).find({ accessDurationValue: { $ne: null } }).toArray()) {
      if (!Number.isInteger(a.accessDurationValue)) continue; // already reported + blocked above
      await col(name).updateOne({ _id: a._id }, { $set: { accessDurationValue: new mongoose.mongo.Int32(a.accessDurationValue) } as any });
      dur++;
    }
  }
  console.log(`✓ accessDurationValue -> Int32       : ${dur}`);

  // ══ 3. INDEXES ════════════════════════════════════════════════════════════
  await col('events').createIndex({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } }, name: 'eventId_unique' });
  await col('events').createIndex({ organizerMobile: 1 }, { name: 'organizerMobile_1' });
  console.log('✓ indexes ensured                    : eventId_unique (unique, partial), organizerMobile_1');

  // ══ 4. VALIDATORS — safest collections first, auth last ═══════════════════
  const str = (extra: Record<string, any> = {}) => ({ bsonType: 'string', ...extra });
  const strOrNull = (extra: Record<string, any> = {}) => ({ bsonType: ['string', 'null'], ...extra });
  const dateOrNull = { bsonType: ['date', 'null'] };
  const oidOrNull = { bsonType: ['objectId', 'null'] };

  const VALIDATORS: Array<[string, any, 'strict' | 'moderate']> = [
    ['counters', {
      bsonType: 'object', required: ['_id', 'seq'],
      properties: { _id: str(), seq: { bsonType: 'int', minimum: 0 } },
    }, 'strict'],

    ['settings', {
      bsonType: 'object', required: ['key'],
      properties: { key: { enum: SETTINGS_KEYS }, value: strOrNull({ maxLength: SETTINGS_VALUE_MAX }) },
    }, 'strict'],

    ['messagelogs', {
      bsonType: 'object', required: ['campaignId', 'contactId', 'phoneNumber', 'status'],
      properties: {
        campaignId: { bsonType: 'objectId' }, contactId: { bsonType: 'objectId' },
        phoneNumber: str(), status: { enum: MESSAGE_STATUSES },
        errorReason: strOrNull(),   // no length limit exists today
        createdAt: dateOrNull, updatedAt: dateOrNull,
      },
    }, 'strict'],

    ['campaigns', {
      bsonType: 'object', required: ['eventId', 'status'],
      properties: {
        eventId: { bsonType: 'objectId' },
        messageText: strOrNull(),   // deliberately unbounded — see header
        status: { enum: CAMPAIGN_STATUSES },
        mediaAttachments: {
          bsonType: ['array', 'null'],
          items: {
            bsonType: 'object', required: ['url', 'type', 'filename'],
            properties: { url: str(), type: { enum: MEDIA_TYPES }, filename: str() },
          },
        },
        history: {
          bsonType: ['array', 'null'],
          items: {
            bsonType: 'object',
            properties: {
              messageText: strOrNull(), sentAt: dateOrNull,
              mediaAttachments: {
                bsonType: ['array', 'null'],
                items: {
                  bsonType: 'object', required: ['url', 'type', 'filename'],
                  properties: { url: str(), type: { enum: MEDIA_TYPES }, filename: str() },
                },
              },
            },
          },
        },
        createdAt: dateOrNull, updatedAt: dateOrNull,
      },
    }, 'strict'],

    ['contacts', {
      bsonType: 'object', required: ['fullName', 'phoneNumber', 'countryCode', 'eventId', 'source', 'status'],
      properties: {
        fullName: str({ minLength: 1, maxLength: CONTACT_FULLNAME_MAX }),
        phoneNumber: str(),         // no pattern — invalid numbers are kept on purpose
        countryCode: str(),         // not enumerated — bulk import supplies it
        email: strOrNull(),         // no pattern — imported domains vary
        tags: { bsonType: ['array', 'null'], items: str() },
        eventId: { bsonType: 'objectId' },
        source: { enum: CONTACT_SOURCES },
        status: { enum: CONTACT_STATUSES },
        validationReason: strOrNull(),
        createdAt: dateOrNull, updatedAt: dateOrNull,
      },
    }, 'strict'],

    ['events', {
      bsonType: 'object',
      required: ['eventId', 'organizerName', 'organizerMobile', 'eventName', 'eventType',
                 'eventDate', 'eventTime', 'eventVenue', 'eventStatus'],
      properties: {
        eventId: str({ pattern: '^EVT-[0-9]{6,}$' }),
        organizerName: str({ minLength: 1, maxLength: EVENT_LIMITS.organizerName }),
        organizerMobile: str({ pattern: '^[0-9]{10}$' }),
        eventName: str({ minLength: 1, maxLength: EVENT_LIMITS.eventName }),
        eventType: str({ minLength: 1, maxLength: EVENT_LIMITS.eventType }),
        eventDate: { bsonType: 'date' },
        eventTime: { bsonType: 'int', minimum: 0, maximum: 1439 },
        eventVenue: str({ minLength: 1, maxLength: EVENT_LIMITS.eventVenue }),
        eventDescription: strOrNull({ maxLength: EVENT_LIMITS.eventDescription }),
        eventStatus: { enum: EVENT_STATUSES },
        createdBy: oidOrNull, adminId: oidOrNull, assignedUserId: oidOrNull,
        assignedUserIds: { bsonType: ['array', 'null'], items: { bsonType: 'objectId' } },
        createdAt: dateOrNull, updatedAt: dateOrNull,
      },
    }, 'strict'],

    // Accounts last: a mistake here would block sign-in. No pattern on email —
    // format is enforced by Zod; a DB regex edge case must never lock anyone out.
    ['users', {
      bsonType: 'object', required: ['name', 'email', 'passwordHash', 'status'],
      properties: {
        name: str({ minLength: 1 }), email: str({ minLength: 1 }), passwordHash: str({ minLength: 1 }),
        status: { enum: ACCOUNT_STATUSES },
        accessDurationValue: { bsonType: ['int', 'null'], minimum: 0 },
        accessDurationUnit: { enum: [...DURATION_UNITS, null] },
        isAccessCancelled: { bsonType: ['bool', 'null'] },
        assignedEventId: oidOrNull, adminId: oidOrNull, approvedBy: oidOrNull, rejectedBy: oidOrNull,
        rejectionReason: strOrNull(),
        accessGrantedOn: dateOrNull, accessStartDate: dateOrNull, accessExpiryDate: dateOrNull,
        approvedAt: dateOrNull, rejectedAt: dateOrNull, passwordChangedAt: dateOrNull,
        createdAt: dateOrNull, updatedAt: dateOrNull,
      },
    }, 'strict'],

    ['admins', {
      bsonType: 'object', required: ['name', 'email', 'passwordHash', 'role', 'status'],
      properties: {
        name: str({ minLength: 1 }), email: str({ minLength: 1 }), passwordHash: str({ minLength: 1 }),
        role: { enum: ADMIN_ROLES }, status: { enum: ACCOUNT_STATUSES },
        accessDurationValue: { bsonType: ['int', 'null'], minimum: 0 },
        accessDurationUnit: { enum: [...DURATION_UNITS, null] },
        isAccessCancelled: { bsonType: ['bool', 'null'] },
        approvedBy: oidOrNull, rejectedBy: oidOrNull, rejectionReason: strOrNull(),
        accessGrantedOn: dateOrNull, accessStartDate: dateOrNull, accessExpiryDate: dateOrNull,
        pendingAccessStartDate: dateOrNull, pendingAccessEndDate: dateOrNull,
        approvedAt: dateOrNull, rejectedAt: dateOrNull, passwordChangedAt: dateOrNull,
        createdAt: dateOrNull, updatedAt: dateOrNull,
      },
    }, 'strict'],

    // Loose on purpose: changes.before / changes.after / metadata are Mixed and
    // must keep accepting arbitrary snapshots. Audit writes must never fail.
    ['auditlogs', {
      bsonType: 'object', required: ['timestamp', 'action', 'collectionName'],
      properties: { timestamp: { bsonType: 'date' }, action: str(), collectionName: str(), success: { bsonType: ['bool', 'null'] } },
    }, 'moderate'],
  ];

  // Re-read the collection list: the backfill above creates `counters` on
  // first run, so the snapshot taken during the audit is already stale here.
  const namesNow = (await db.listCollections().toArray()).map((c) => c.name);

  for (const [name, schema, level] of VALIDATORS) {
    if (!namesNow.includes(name)) { console.log(`· ${name.padEnd(13)} skipped (collection does not exist yet)`); continue; }
    await db.command({ collMod: name, validator: { $jsonSchema: schema }, validationLevel: level, validationAction: 'error' });
    console.log(`✓ validator applied                  : ${name} (${level})`);
  }

  // ══ 5. VERIFY ═════════════════════════════════════════════════════════════
  console.log('\n══ Verification ══════════════════════════════════════════════');
  const post = await col('events').find({}).toArray();
  const ids = post.map((e) => e.eventId);
  console.log(`  every event has a valid eventId : ${post.every((e) => isStr(e.eventId) && EVENT_ID_RE.test(e.eventId))}`);
  console.log(`  eventId values unique           : ${new Set(ids).size === ids.length}`);
  console.log(`  organizerMobile all strings     : ${post.every((e) => isStr(e.organizerMobile))}`);
  console.log(`  eventTime all int 0..1439       : ${post.every((e) => isInt(e.eventTime) && e.eventTime >= 0 && e.eventTime <= 1439)}`);
  const withValidators = (await db.listCollections().toArray()).filter((c: any) => c.options?.validator).map((c: any) => c.name);
  console.log(`  collections with a validator    : ${withValidators.sort().join(', ')}`);

  console.log('\nMigration complete.');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
