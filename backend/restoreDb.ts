/**
 * Restore the EventReach database from a backupDb.ts dump — the rollback path
 * for migrateDbHardening.ts --apply.
 *
 *   cd backend && npm run restore-db -- backups/<timestamp>            # dry run
 *   cd backend && npm run restore-db -- backups/<timestamp> --confirm  # restore
 *
 * DESTRUCTIVE with --confirm: every collection present in the dump is dropped
 * and rewritten from the dump. Collections created AFTER the backup was taken
 * (such as `counters`) are dropped too, so the database ends up in exactly the
 * state the dump captured. Validators are removed along with their collections,
 * which is what makes this a true rollback of the hardening migration.
 *
 * Default mode is a dry run that only reports what would change.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';

const EJSON = (mongoose.mongo as any).BSON.EJSON;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CONFIRM = process.argv.includes('--confirm');
const dir = args[0];

async function main() {
  if (!dir) throw new Error('Usage: npm run restore-db -- backups/<timestamp> [--confirm]');
  if (!fs.existsSync(dir)) throw new Error(`Backup directory not found: ${dir}`);

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (backend/.env)');

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_manifest.json').sort();
  if (!files.length) throw new Error(`No collection dumps found in ${dir}`);

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`\nRestoring into "${db.databaseName}" from ${dir}`);
  console.log(`Mode: ${CONFIRM ? 'CONFIRM — collections will be dropped and rewritten' : 'DRY RUN — no writes'}\n`);

  let total = 0;
  for (const file of files) {
    const name = path.basename(file, '.json');
    const docs = EJSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'), { relaxed: false });
    const live = (await db.listCollections({ name }).toArray()).length
      ? await db.collection(name).countDocuments({})
      : null;

    console.log(`  ${name.padEnd(16)} dump ${String(docs.length).padStart(6)}  live ${live === null ? '  (absent)' : String(live).padStart(6)}`);

    if (!CONFIRM) continue;

    if (live !== null) await db.collection(name).drop();
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
    total += docs.length;
  }

  // Anything created after the backup was taken must go, or the rollback is
  // partial — the hardening migration creates `counters` from nothing.
  const inDump = new Set(files.map((f) => path.basename(f, '.json')));
  const extra = (await db.listCollections().toArray())
    .map((c: any) => c.name)
    .filter((n: string) => !n.startsWith('system.') && !inDump.has(n))
    .sort();

  if (extra.length) {
    console.log(`\n  Not in the dump — created after the backup, will be DROPPED:`);
    for (const name of extra) {
      console.log(`    ${name.padEnd(16)} ${await db.collection(name).countDocuments({})} document(s)`);
      if (CONFIRM) await db.collection(name).drop();
    }
  }

  if (!CONFIRM) {
    console.log('\nDry run only. Re-run with --confirm to actually restore.\n');
  } else {
    console.log(`\n✓ Restored ${total} document(s).`);
    console.log('  Indexes and validators were dropped with their collections.');
    console.log('  Restart the backend so Mongoose rebuilds its indexes.\n');
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nRestore failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
