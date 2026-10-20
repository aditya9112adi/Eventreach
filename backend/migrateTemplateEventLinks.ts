/**
 * EventReach - convert WhatsApp templates saved with the old event link
 * (`eventId` = the event's ObjectId) to the current one (`eventObjectId` = the
 * ObjectId, `eventId` = the business id such as EVT-0000017).
 *
 * Default mode is a dry run: it lists what would change. Nothing is written
 * unless --apply is passed. Templates that never had an event are not touched.
 *
 * MONGODB_URI must be set explicitly for the run. This script deliberately
 * does NOT load backend/.env, so it can never be pointed at a database by
 * accident:
 *
 *   MONGODB_URI='<uri>' npx ts-node migrateTemplateEventLinks.ts           # dry run
 *   MONGODB_URI='<uri>' npx ts-node migrateTemplateEventLinks.ts --apply   # convert
 *
 * --apply against production needs explicit approval and a backup first
 * (npm run backup-db).
 */
import mongoose from 'mongoose';
import { findLegacyTemplateLinks, migrateLegacyTemplateLinks } from './src/services/templateEventLinks';

const APPLY = process.argv.includes('--apply');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI explicitly for this run (backend/.env is not read).');

  await mongoose.connect(uri);
  console.log(`Connected to database "${mongoose.connection.name}". Mode: ${APPLY ? 'APPLY' : 'DRY RUN - no writes'}\n`);

  const links = await findLegacyTemplateLinks();
  console.log(`Templates with the old event link: ${links.length}`);
  for (const l of links) {
    console.log(`  - ${l.templateId} ${l.name} (${l.language}) -> ${l.eventBusinessId ?? 'EVENT HAS NO BUSINESS ID OR NO LONGER EXISTS'}`);
  }

  if (links.length === 0) {
    console.log('\nNothing to convert.');
  } else if (!APPLY) {
    console.log('\nRe-run with --apply to convert them.');
  } else {
    const result = await migrateLegacyTemplateLinks();
    console.log(`\nConverted ${result.converted} template(s); ${result.unresolved.length} left as they were.`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('Failed:', error?.message || error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
