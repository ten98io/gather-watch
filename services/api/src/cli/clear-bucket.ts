/**
 * Attachment-bucket clear CLI.
 *
 *   pnpm --filter gather-api exec tsx src/cli/clear-bucket.ts          # dry run
 *   pnpm --filter gather-api exec tsx src/cli/clear-bucket.ts --yes    # delete
 *
 * Run it with the deployment's own credentials so nothing is pasted anywhere:
 *
 *   railway run --service api pnpm --filter gather-api exec tsx src/cli/clear-bucket.ts
 *
 * WHY THIS EXISTS: chat attachment objects live in the bucket, but the only
 * thing that knows an object exists is its AssetDoc in Mongo. Dropping the
 * database therefore ORPHANS every object — unreferenced, unreachable, and
 * still billed. A database reset that does not also clear the bucket leaks
 * storage permanently, because after the drop there is no longer any record of
 * what to delete.
 *
 * DRY RUN IS THE DEFAULT and `--yes` is the only way to delete, because this
 * is irreversible and the blast radius is "every file anyone ever uploaded".
 *
 * It signs with the same SigV4 helper the upload path uses (node:crypto only —
 * this repo carries no AWS SDK), so addressing and region follow the endpoint
 * exactly as they do in production: MinIO stays path-style/us-east-1, a
 * Railway-linked bucket goes virtual-hosted/auto.
 */
import { loadConfig } from '../config';
import { presignObjectUrl } from '../modules/chat/attachments';

type S3Settings = Parameters<typeof presignObjectUrl>[0];

/** One page of a ListObjectsV2 response, parsed out of the XML. */
interface ListPage {
  keys: string[];
  nextToken: string | null;
}

/** S3 list/delete presigns are short-lived by design; a page is fast. */
const PRESIGN_TTL_SEC = 300;

/** Bucket-level (not object-level) canonical path, for ListObjectsV2. */
function bucketUrl(s3: S3Settings, params: Record<string, string>): string {
  // The object presigner signs a KEY; listing signs the bucket root, which an
  // empty key yields exactly. The list params MUST go through the signer —
  // appending them to the returned URL invalidates the signature, which S3
  // answers with 403 SignatureDoesNotMatch.
  return presignObjectUrl(s3, '', 'GET', PRESIGN_TTL_SEC, new Date(), params);
}

/** ListObjectsV2 is XML; pull out the keys and the continuation token. */
export function parseListPage(xml: string): ListPage {
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) =>
    (m[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
  );
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
  return { keys, nextToken: truncated ? token : null };
}

async function listPage(s3: S3Settings, token: string | null): Promise<ListPage> {
  const params: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
  if (token !== null) params['continuation-token'] = token;
  const res = await fetch(bucketUrl(s3, params));
  if (!res.ok) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`);
  }
  return parseListPage(await res.text());
}

async function deleteKey(s3: S3Settings, key: string): Promise<void> {
  const res = await fetch(presignObjectUrl(s3, key, 'DELETE', PRESIGN_TTL_SEC), {
    method: 'DELETE',
  });
  // S3 returns 204 for a delete, and also for a key that was already gone.
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete ${key} failed: ${res.status} ${await res.text()}`);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const commit = argv.includes('--yes');
  const config = loadConfig(process.env);
  const s3 = config.s3 as S3Settings;

  console.log(`bucket:   ${s3.bucket}`);
  console.log(`endpoint: ${s3.endpoint}`);
  console.log(commit ? 'mode:     DELETE (--yes given)' : 'mode:     dry run — pass --yes to delete');
  console.log('');

  let token: string | null = null;
  let seen = 0;
  let deleted = 0;
  do {
    const page: ListPage = await listPage(s3, token);
    for (const key of page.keys) {
      seen += 1;
      if (!commit) {
        console.log(`would delete  ${key}`);
        continue;
      }
      await deleteKey(s3, key);
      deleted += 1;
      // Progress matters: a large bucket takes a while and silence reads as a hang.
      if (deleted % 50 === 0) console.log(`deleted ${deleted}…`);
    }
    token = page.nextToken;
  } while (token !== null);

  console.log('');
  if (seen === 0) {
    console.log('bucket is already empty — nothing to do');
  } else if (commit) {
    console.log(`deleted ${deleted} of ${seen} objects`);
  } else {
    console.log(`${seen} objects would be deleted. Re-run with --yes to do it.`);
  }
  return 0;
}

// Entry point only when executed directly; importing this file (tests) must
// never touch the network or the process.
if (process.argv[1]?.endsWith('clear-bucket.ts') === true) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
