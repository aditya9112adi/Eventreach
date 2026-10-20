import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

/**
 * backend/migrateTemplateEventLinks.ts, run as a real process against a throwaway local MongoDB.
 *
 * What matters most is what a DRY RUN does not do: it must write nothing - no documents, no collections,
 * no indexes (Mongoose builds both on connect unless told not to) - and must never print the connection
 * string. Run `npm run build` in backend/ first (the helpers are read from backend/dist).
 */

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');
const links = require('../backend/dist/services/templateEventLinks');

const BASE = 'mongodb://127.0.0.1:27017';
const DB = `eventreach_migrate_links_${Date.now()}`;
const URI = `${BASE}/${DB}`;
const NAME_ONLY_URI = BASE;

/** `uri`: the connection string to give the script; null for none at all (not undefined, which would take the default). */
const run = (args: string[], uri: string | null = URI) => {
  const result = spawnSync('npx', ['tsx', 'migrateTemplateEventLinks.ts', ...args], {
    cwd: new URL('../backend/', import.meta.url),
    shell: true,
    encoding: 'utf-8',
    // NODE_OPTIONS is dropped: a suite-wide preload (such as an outbound-HTTP guard) would also reach `npx`, which
    // checks a registry over HTTPS. The script itself talks only to the MongoDB URI it is given.
    env: { ...process.env, NODE_OPTIONS: '', MONGODB_URI: uri ?? '' },
    timeout: 120_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, '') };
};

let admin: any;
const ids: Record<string, any> = {};

const state = async () => {
  const db = mongoose.connection.db;
  const cols = (await db.listCollections().toArray()).map((c: any) => c.name).sort();
  const indexes: Record<string, string[]> = {};
  for (const name of cols) indexes[name] = (await db.collection(name).indexes()).map((i: any) => i.name).sort();
  const docs = await db.collection('whatsapptemplates').find({}).sort({ name: 1 }).toArray();
  return { cols, indexes, docs: JSON.stringify(docs) };
};

before(async () => {
  await mongoose.connect(URI, { autoIndex: false, autoCreate: false });
  admin = new mongoose.Types.ObjectId();
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const seed = async () => {
  const db = mongoose.connection.db;
  ids.e1 = new mongoose.Types.ObjectId();
  ids.e2 = new mongoose.Types.ObjectId();
  await db.collection('events').insertMany([
    { _id: ids.e1, eventId: 'EVT-000101', eventName: 'One' },
    { _id: ids.e2, eventId: 'EVT-000102', eventName: 'Two' },
  ]);
  const tpl = (name: string, extra: Record<string, any>) => ({ wabaId: '1', name, language: 'en', localState: 'Approved', metaStatus: 'APPROVED', ...extra });
  await db.collection('whatsapptemplates').insertMany([
    tpl('legacy_one', { eventId: ids.e1 }),
    tpl('legacy_two', { eventId: ids.e2 }),
    tpl('legacy_orphan', { eventId: new mongoose.Types.ObjectId() }),
    tpl('legacy_reusable', { eventId: null }),
    tpl('already_new', { eventObjectId: ids.e1, eventId: 'EVT-000101' }),
  ]);
};

describe('a dry run changes nothing', () => {
  test('against a database that does not exist yet it creates no collection and no index', async () => {
    const { code, out } = run([]);
    assert.equal(code, 0, out);
    assert.match(out, /DRY RUN - read only, no writes/);
    assert.match(out, /Nothing to convert/);
    assert.deepEqual((await state()).cols, [], 'no collection was created');
  });

  test('against existing data it reports what would change and modifies nothing - documents, collections and indexes alike', async () => {
    await seed();
    const before = await state();
    const { code, out } = run([]);
    assert.equal(code, 0, out);
    assert.match(out, /Templates with the old event link: 3/);
    assert.match(out, /legacy_one \(en\) -> EVT-000101/);
    assert.match(out, /legacy_two \(en\) -> EVT-000102/);
    assert.match(out, /legacy_orphan \(en\) -> EVENT HAS NO BUSINESS ID OR NO LONGER EXISTS/);
    assert.match(out, /Would be converted: 2\. Unresolved: 1\./);
    assert.match(out, /Dry run only: nothing was modified/);
    const after = await state();
    assert.equal(after.docs, before.docs, 'no document changed');
    assert.deepEqual(after.cols, before.cols, 'no collection created');
    assert.deepEqual(after.indexes, before.indexes, 'no index built (the new eventObjectId index in particular)');
    assert.equal(after.indexes.whatsapptemplates.includes('eventObjectId_1_localState_1'), false);
  });

  test('repeated dry runs stay read-only', async () => {
    const before = await state();
    for (let i = 0; i < 2; i++) assert.equal(run([]).code, 0);
    assert.deepEqual(await state(), before);
  });

  test('never prints the connection string, its host or the database credentials', () => {
    const secretUri = `mongodb://dryrunuser:Sup3rS3cret@127.0.0.1:27017/${DB}`;
    const { out } = run([], secretUri);
    for (const leaked of ['Sup3rS3cret', 'dryrunuser', 'mongodb://', secretUri]) assert.equal(out.includes(leaked), false, `no "${leaked}" in the output`);
  });
});

describe('it refuses to run against the wrong database', () => {
  test('a URI that names no database is refused before connecting (the driver would use "test")', async () => {
    const before = await state();
    const { code, out } = run([], NAME_ONLY_URI);
    assert.equal(code, 2, out);
    assert.match(out, /names no database/);
    assert.deepEqual(await state(), before);
  });

  test('--expect-db must match the database the URI names, or nothing is connected', async () => {
    const wrong = run(['--expect-db=some_other_database']);
    assert.equal(wrong.code, 2, wrong.out);
    assert.match(wrong.out, new RegExp(`names database "${DB}", not the expected "some_other_database"`));
    assert.equal(wrong.out.includes('Connected to database'), false, 'it refused before connecting');
    const right = run([`--expect-db=${DB}`]);
    assert.equal(right.code, 0, right.out);
    assert.match(right.out, /Connected to database/);
  });

  test('no MONGODB_URI is refused, and backend/.env is not consulted', () => {
    const { code, out } = run([], null);
    assert.equal(code, 2, out);
    assert.match(out, /Set MONGODB_URI explicitly/);
  });
});

describe('an unreachable server is reported without leaking where it was', () => {
  test('the error carries no host, user or password', () => {
    const { code, out } = run([], 'mongodb://leakuser:LeakP4ss@unreachable-host.invalid:27017/some_db');
    assert.equal(code, 1, out);
    assert.match(out, /Failed:/);
    for (const leaked of ['LeakP4ss', 'leakuser', 'unreachable-host']) assert.equal(out.includes(leaked), false, leaked);
  });
});

describe('--apply converts, still builds no index, and is safe to repeat', () => {
  test('converts the linkable templates, leaves the rest, and creates nothing else', async () => {
    const before = await state();
    const { code, out } = run([`--expect-db=${DB}`, '--apply']);
    assert.equal(code, 0, out);
    assert.match(out, /Mode: APPLY/);
    assert.match(out, /Converted 2 template\(s\); 1 left as they were\./);
    const after = await state();
    assert.deepEqual(after.cols, before.cols);
    assert.deepEqual(after.indexes, before.indexes, 'applying built no index either');
    const docs = Object.fromEntries((await mongoose.connection.db.collection('whatsapptemplates').find({}).toArray()).map((d: any) => [d.name, d]));
    assert.equal(docs.legacy_one.eventId, 'EVT-000101');
    assert.equal(String(docs.legacy_one.eventObjectId), String(ids.e1));
    assert.equal(docs.legacy_two.eventId, 'EVT-000102');
    assert.equal(typeof docs.legacy_orphan.eventId, 'object', 'the orphan is left as it was');
    assert.equal(docs.legacy_orphan.eventObjectId, undefined);
    assert.equal(docs.legacy_reusable.eventId, null, 'a template that never had an event is not assigned one');
    assert.equal(docs.legacy_reusable.eventObjectId, undefined);
    assert.equal(docs.already_new.eventId, 'EVT-000101');
  });

  test('a second apply converts nothing', () => {
    const { code, out } = run([`--expect-db=${DB}`, '--apply']);
    assert.equal(code, 0, out);
    assert.match(out, /Converted 0 template\(s\); 1 left as they were\./);
  });
});

describe('the helpers', () => {
  test('databaseNameOf reads the database a connection string names, and null when it names none', () => {
    assert.equal(links.databaseNameOf('mongodb://u:p@h1:27017,h2:27017/eventreach?retryWrites=true'), 'eventreach');
    assert.equal(links.databaseNameOf('mongodb+srv://u:p@cluster.example.net/eventreach_prod?w=majority'), 'eventreach_prod');
    for (const none of ['mongodb://h:27017', 'mongodb://h:27017/', 'mongodb://h:27017/?retryWrites=true', 'mongodb+srv://u:p@c.example.net/?x=1', 'not a uri']) {
      assert.equal(links.databaseNameOf(none), null, none);
    }
  });

  test('redactConnectionDetails removes the string, credentials and hosts from any text', () => {
    const uri = 'mongodb+srv://appuser:p%40ss@cluster0.abcde.mongodb.net/prod?retryWrites=true';
    const text = `getaddrinfo ENOTFOUND cluster0.abcde.mongodb.net while using ${uri} as appuser with p@ss`;
    const clean = links.redactConnectionDetails(text, uri);
    for (const leaked of ['appuser', 'p%40ss', 'p@ss', 'cluster0.abcde.mongodb.net', 'mongodb+srv://']) assert.equal(clean.includes(leaked), false, leaked);
    assert.match(clean, /getaddrinfo ENOTFOUND \[redacted\]/);
  });

  test('connect options switch off collection creation and index builds', () => {
    assert.equal(links.MAINTENANCE_CONNECT_OPTIONS.autoIndex, false);
    assert.equal(links.MAINTENANCE_CONNECT_OPTIONS.autoCreate, false);
  });
});
