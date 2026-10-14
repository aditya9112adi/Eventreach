/**
 * EventReach - find, and optionally remove, WhatsApp credentials stored by the
 * old Settings page (the settings collection and unredacted audit snapshots).
 *
 * Default mode is a dry run: it reports record ids and times only, never a
 * value. Nothing is written unless --apply is passed.
 *
 * MONGODB_URI must be set explicitly for the run. This script deliberately
 * does NOT load backend/.env, so it can never be pointed at a database by
 * accident:
 *
 *   MONGODB_URI='<uri>' npx ts-node cleanupLegacyWhatsAppSettings.ts           # dry run
 *   MONGODB_URI='<uri>' npx ts-node cleanupLegacyWhatsAppSettings.ts --apply   # remove
 *
 * --apply against production needs explicit approval and a backup first
 * (npm run backup-db). If anything is found, rotate that credential in Meta:
 * removing it here does not undo the exposure.
 */
import mongoose from 'mongoose';
import { findLegacySecrets, removeLegacySecrets } from './src/services/legacySettingsSecrets';

const APPLY = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI explicitly for this run (backend/.env is not read).');

  await mongoose.connect(uri);
  console.log(`Connected to database "${mongoose.connection.name}". Mode: ${APPLY ? 'APPLY' : 'DRY RUN - no writes'}\n`);

  const report = await findLegacySecrets();
  console.log(`Stored credential settings: ${report.storedSettings.length}`);
  for (const s of report.storedSettings) console.log(`  - ${s.key} (last updated ${s.updatedAt?.toISOString() ?? 'unknown'})`);
  console.log(`Audit entries with an unredacted credential: ${report.auditEntries.length}`);
  for (const a of report.auditEntries) console.log(`  - ${a.id} ${a.action} at ${a.timestamp?.toISOString() ?? 'unknown'}`);

  if (report.storedSettings.length === 0 && report.auditEntries.length === 0) {
    console.log('\nNothing to clean up.');
  } else if (!APPLY) {
    console.log('\nRe-run with --apply to remove them, then rotate the credential in Meta.');
  } else {
    const result = await removeLegacySecrets();
    console.log(`\nCleared ${result.settingsCleared} setting(s); redacted ${result.auditSnapshotsRedacted} audit snapshot(s).`);
    console.log('Rotate the affected credential in Meta: removing it here does not undo the exposure.');
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('Failed:', error?.message || error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
