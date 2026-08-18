/**
 * Database reset CLI.
 *
 *   pnpm --filter gather-api exec tsx src/cli/reset-db.ts          # dry run
 *   pnpm --filter gather-api exec tsx src/cli/reset-db.ts --yes    # drop
 *
 * Run it with the deployment's own credentials so nothing is pasted anywhere:
 *
 *   railway run --service api pnpm --filter gather-api exec tsx src/cli/reset-db.ts
 *
 * WHY THIS EXISTS RATHER THAN `mongosh`: the driver is already a dependency of
 * this service, so there is nothing to install, and `railway run` injects
 * MONGO_URL from the deployment — the connection string never reaches a shell,
 * a history file, or a clipboard.
 *
 * DRY RUN IS THE DEFAULT and `--yes` is the only way to drop, because this
 * destroys every account, room, message and event in the database and there is
 * no undo.
 *
 * AFTER DROPPING, RESTART THE API. Indexes are created by `store.init()` at
 * boot and nothing recreates them at runtime, so an api that booted against
 * the old collections will serve a database with no indexes — including the
 * partial unique indexes on users.email and pushSubs, whose absence silently
 * permits the duplicate rows they exist to prevent.
 */
import { MongoClient } from 'mongodb';
import { loadConfig } from '../config';
import { dbNameFromUrl } from '../adapters/mongo-store';

/** What a reset would remove, per collection. */
export interface CollectionCount {
  name: string;
  documents: number;
}

export function describePlan(counts: readonly CollectionCount[]): string {
  if (counts.length === 0) return 'database is already empty — nothing to drop';
  const total = counts.reduce((n, c) => n + c.documents, 0);
  const rows = counts
    .slice()
    .sort((a, b) => b.documents - a.documents)
    .map((c) => `  ${String(c.documents).padStart(7)}  ${c.name}`)
    .join('\n');
  return `${rows}\n  ${String(total).padStart(7)}  TOTAL across ${counts.length} collections`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const commit = argv.includes('--yes');
  const config = loadConfig(process.env);
  const url = config.mongoUrl;

  if (url === null) {
    // An empty MONGO_URL boots the in-memory adapter, so there is no database
    // to reset and "success" here would be a lie.
    console.error('MONGO_URL is not set — this environment runs the in-memory store.');
    return 1;
  }

  // Resolve the name with the APP'S OWN function, never a second copy of the
  // rule. A connection string with no path makes the driver default to `test`
  // while MongoStore defaults to `gather` — so a hand-rolled resolver here
  // reported an almost-empty database, and would have dropped that one and
  // left every real document in place, reporting success.
  const client = new MongoClient(url);
  try {
    await client.connect();
    const db = client.db(dbNameFromUrl(url));
    console.log(`database: ${db.databaseName}`);
    console.log(commit ? 'mode:     DROP (--yes given)' : 'mode:     dry run — pass --yes to drop');
    console.log('');

    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const counts: CollectionCount[] = [];
    for (const c of collections) {
      counts.push({ name: c.name, documents: await db.collection(c.name).countDocuments() });
    }
    console.log(describePlan(counts));
    console.log('');

    if (!commit) {
      console.log('Nothing was changed. Re-run with --yes to drop.');
      return 0;
    }
    await db.dropDatabase();
    console.log(`dropped ${db.databaseName}`);
    console.log('');
    console.log('NOW RESTART THE API so store.init() recreates the indexes:');
    console.log('  railway redeploy --service api');
    return 0;
  } finally {
    await client.close();
  }
}

// Entry point only when executed directly; importing this file (tests) must
// never connect to anything.
if (process.argv[1]?.endsWith('reset-db.ts') === true) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
