/**
 * EventReach - convert WhatsApp templates saved with the old event link
 * (`eventId` = the event's ObjectId) to the current one (`eventObjectId` = the
 * ObjectId, `eventId` = the business id such as EVT-0000017).
 *
 * Default mode is a DRY RUN: it only reads, and lists what would change. Nothing
 * is written unless --apply is passed. In a dry run - and in an apply - the
 * connection creates no collections and builds no indexes (see
 * MAINTENANCE_CONNECT_OPTIONS), so it also works with a read-only database user.
 * Templates that never had an event are not touched.
 *
 * MONGODB_URI must be set explicitly for the run. This script deliberately
 * does NOT load backend/.env, so it can never be pointed at a database by
 * accident, and it never prints the URI: only the database NAME is shown. A URI
 * that names no database is refused (the driver would silently use "test"), and
 * --expect-db=<name> refuses to continue unless the URI names exactly that database.
 *
 * PowerShell (the URI is typed masked and kept only in this process's environment):
 *
 *   $s = Read-Host 'MongoDB URI' -AsSecureString
 *   $env:MONGODB_URI = [System.Net.NetworkCredential]::new('', $s).Password
 *   npx tsx migrateTemplateEventLinks.ts --expect-db=<database name>            # dry run
 *   npx tsx migrateTemplateEventLinks.ts --expect-db=<database name> --apply    # convert
 *   Remove-Item Env:MONGODB_URI
 *
 * --apply against production needs explicit approval and a backup first
 * (npm run backup-db).
 */
import mongoose from 'mongoose';
import {
  MAINTENANCE_CONNECT_OPTIONS,
  databaseNameOf,
  findLegacyTemplateLinks,
  migrateLegacyTemplateLinks,
  redactConnectionDetails,
} from './src/services/templateEventLinks';

const APPLY = process.argv.includes('--apply');
const expectArg = process.argv.find((a) => a.startsWith('--expect-db='));
const EXPECTED_DB = expectArg ? expectArg.slice('--expect-db='.length).trim() : '';

class Refusal extends Error {}

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Refusal('Set MONGODB_URI explicitly for this run (backend/.env is not read).');

  const named = databaseNameOf(uri);
  if (!named) {
    throw new Refusal('The connection string names no database, so the driver would use "test". Add the database name to the URI. Nothing was connected.');
  }
  if (EXPECTED_DB && named !== EXPECTED_DB) {
    throw new Refusal(`The connection string names database "${named}", not the expected "${EXPECTED_DB}". Nothing was connected.`);
  }

  await mongoose.connect(uri, MAINTENANCE_CONNECT_OPTIONS);
  console.log(`Connected to database "${mongoose.connection.name}". Mode: ${APPLY ? 'APPLY' : 'DRY RUN - read only, no writes'}\n`);

  const links = await findLegacyTemplateLinks();
  console.log(`Templates with the old event link: ${links.length}`);
  for (const l of links) {
    console.log(`  - ${l.templateId} ${l.name} (${l.language}) -> ${l.eventBusinessId ?? 'EVENT HAS NO BUSINESS ID OR NO LONGER EXISTS'}`);
  }
  const linkable = links.filter((l) => l.eventBusinessId).length;
  console.log(`Would be converted: ${linkable}. Unresolved: ${links.length - linkable}.`);

  if (links.length === 0) {
    console.log('\nNothing to convert.');
  } else if (!APPLY) {
    console.log('\nDry run only: nothing was modified. Re-run with --apply (after a backup and approval) to convert them.');
  } else {
    const result = await migrateLegacyTemplateLinks();
    console.log(`\nConverted ${result.converted} template(s); ${result.unresolved.length} left as they were.`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  const uri = process.env.MONGODB_URI ?? '';
  console.error('Failed:', redactConnectionDetails(error?.message || String(error), uri));
  await mongoose.disconnect().catch(() => undefined);
  process.exit(error instanceof Refusal ? 2 : 1);
});
