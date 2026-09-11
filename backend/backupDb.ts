/**
 * Full logical backup of the EventReach database — read-only.
 *
 *   cd backend && npm run backup-db
 *
 * Writes one Extended-JSON file per collection into backups/<timestamp>/.
 * Extended JSON preserves exact BSON types (Int64 stays Int64, ObjectId stays
 * ObjectId, Date stays Date), so a restore reproduces the documents byte for
 * byte — plain JSON.stringify would silently flatten them.
 *
 * Use this before running migrateDbHardening.ts --apply. Restore with
 * restoreDb.ts.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';

const EJSON = (mongoose.mongo as any).BSON.EJSON;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (backend/.env)');

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join('backups', stamp);
  fs.mkdirSync(dir, { recursive: true });

  const collections = (await db.listCollections().toArray())
    .map((c: any) => c.name)
    .filter((n: string) => !n.startsWith('system.'))
    .sort();

  console.log(`\nBacking up ${collections.length} collection(s) to ${dir}\n`);

  let grandTotal = 0;
  const manifest: Record<string, number> = {};

  for (const name of collections) {
    // promoteValues:false keeps BSON wrappers (Double, Int32, Long) instead of
    // collapsing them all into JS numbers. Without it a stored Double comes back
    // as a plain number and gets written out as $numberLong, so restoring the
    // dump would silently change the field's BSON type.
    const docs = await db.collection(name)
      .find({}, { promoteValues: false, promoteLongs: false, promoteBuffers: false } as any)
      .toArray();
    // relaxed:false keeps numeric types explicit ($numberLong vs $numberInt).
    const ejson = EJSON.stringify(docs, undefined, 2, { relaxed: false });
    fs.writeFileSync(path.join(dir, `${name}.json`), ejson, 'utf8');
    manifest[name] = docs.length;
    grandTotal += docs.length;
    console.log(`  ${name.padEnd(16)} ${String(docs.length).padStart(6)} document(s)`);
  }

  // Index definitions are not restored automatically by restoreDb.ts, but are
  // recorded so they can be recreated by hand if ever needed.
  const indexes: Record<string, any> = {};
  for (const name of collections) indexes[name] = await db.collection(name).indexes();

  fs.writeFileSync(
    path.join(dir, '_manifest.json'),
    JSON.stringify({ takenAt: new Date().toISOString(), database: db.databaseName, counts: manifest, indexes }, null, 2),
    'utf8'
  );

  console.log(`\n✓ Backup complete: ${grandTotal} document(s) in ${dir}`);
  console.log(`  Restore with: npm run restore-db -- ${dir}\n`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nBackup failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
