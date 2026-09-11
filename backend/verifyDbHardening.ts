/**
 * Read-only report on the state of the EventReach database.
 *
 * Answers "did the hardening migration run, and is the data as expected?"
 * without changing anything — there is no write path in this file at all.
 *
 *   cd backend && npx ts-node verifyDbHardening.ts
 *
 * Safe to run at any time, before or after migrateDbHardening.ts.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const EXPECTED_VALIDATED = [
  'admins', 'auditlogs', 'campaigns', 'contacts', 'counters',
  'events', 'messagelogs', 'settings', 'users',
];

const ok = (b: boolean) => (b ? 'OK  ' : 'NO  ');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (backend/.env)');

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const col = (n: string) => db.collection(n);

  const present = new Set((await db.listCollections().toArray()).map((c: any) => c.name));

  const typesOf = async (name: string, field: string) => {
    if (!present.has(name)) return '(collection does not exist)';
    const rows = await col(name)
      .aggregate([{ $match: { [field]: { $ne: null } } },
                  { $group: { _id: { $type: `$${field}` }, n: { $sum: 1 } } }])
      .toArray();
    return rows.map((r: any) => `${r._id}=${r.n}`).sort().join(', ') || '(none)';
  };

  console.log('\n══ EventReach database state ═══════════════════════════════\n');

  // ── events ───────────────────────────────────────────────────────────────
  const total = await col('events').countDocuments({});
  const withId = await col('events').countDocuments({ eventId: { $type: 'string' } });
  const distinctIds = (await col('events').distinct('eventId')).filter((v) => typeof v === 'string').length;
  const goodTime = await col('events').countDocuments({ eventTime: { $type: 'int', $gte: 0, $lte: 1439 } });
  const goodMobile = await col('events').countDocuments({
    organizerMobile: { $type: 'long', $gte: 1000000000, $lte: 9999999999 },
  });

  // With no events at all, "0 of 0 are correct" is vacuously true and would be
  // misleading — treat it as unverified rather than as a pass.
  const has = total > 0;

  console.log('events');
  console.log(`  documents                     : ${total}${has ? '' : '   ← nothing to verify'}`);
  console.log(`  ${ok(has && withId === total)} every event has an eventId  : ${withId}/${total}`);
  console.log(`  ${ok(has && distinctIds === withId)} eventId values unique       : ${distinctIds} distinct`);
  console.log(`  ${ok(has && goodMobile === total)} organizerMobile Int64 10dig : ${goodMobile}/${total}`);
  console.log(`      BSON types seen           : ${await typesOf('events', 'organizerMobile')}`);
  console.log(`  ${ok(has && goodTime === total)} eventTime int 0..1439       : ${goodTime}/${total}`);
  console.log(`      BSON types seen           : ${await typesOf('events', 'eventTime')}`);

  // ── accounts ─────────────────────────────────────────────────────────────
  console.log('\naccounts');
  console.log(`  admins.accessDurationValue    : ${await typesOf('admins', 'accessDurationValue')}`);
  console.log(`  users.accessDurationValue     : ${await typesOf('users', 'accessDurationValue')}`);

  // ── other collections ────────────────────────────────────────────────────
  console.log('\ncounts');
  for (const c of ['contacts', 'campaigns', 'messagelogs', 'admins', 'users', 'auditlogs', 'settings', 'counters']) {
    const exists = (await db.listCollections({ name: c }).toArray()).length > 0;
    console.log(`  ${c.padEnd(14)} ${exists ? await col(c).countDocuments({}) : '(collection does not exist)'}`);
  }
  const counter = await col('counters').findOne({ _id: 'events' as any });
  console.log(`  counters["events"].seq       : ${counter ? (counter as any).seq : '(not created yet)'}`);

  // ── validators ───────────────────────────────────────────────────────────
  const infos = await db.listCollections().toArray();
  const validated = infos.filter((c: any) => c.options?.validator).map((c: any) => c.name).sort();
  const missing = EXPECTED_VALIDATED.filter((n) => !validated.includes(n) &&
    infos.some((c: any) => c.name === n));

  console.log('\nvalidators');
  console.log(`  with $jsonSchema              : ${validated.join(', ') || '(none)'}`);
  console.log(`  ${ok(missing.length === 0)} expected collections covered: ${missing.length ? 'missing ' + missing.join(', ') : 'all'}`);

  // ── indexes ──────────────────────────────────────────────────────────────
  // listIndexes throws NamespaceNotFound on a database that has never had events.
  const idx: any[] = present.has('events') ? await col('events').indexes() : [];
  const uniqueEventId = idx.find((i: any) => i.name === 'eventId_unique' || (i.key?.eventId === 1 && i.unique));
  console.log('\nindexes on events');
  console.log(`  ${ok(!!uniqueEventId)} unique index on eventId     : ${uniqueEventId ? uniqueEventId.name : 'ABSENT'}`);
  console.log(`      all                       : ${idx.map((i: any) => i.name).join(', ') || '(none)'}`);

  // ── verdict ──────────────────────────────────────────────────────────────
  const migrated =
    total > 0 && withId === total && distinctIds === withId &&
    goodMobile === total && goodTime === total &&
    missing.length === 0 && !!uniqueEventId;

  console.log('\n' + '─'.repeat(60));
  console.log(migrated
    ? '✓ Migration has been applied and the data matches the target schema.'
    : '• Migration has NOT been fully applied yet (see the NO lines above).');
  console.log('─'.repeat(60) + '\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nVerification failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
