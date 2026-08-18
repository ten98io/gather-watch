/**
 * The library is gone, and this is what keeps it gone.
 *
 * It was a per-user upload/asset browser served by `services/media`. That
 * service was deleted, so `GET /media/library` answered nothing and the panel
 * showed an empty box forever; in-room playback history (RoomHistoryEntry,
 * components/queue/HistoryDialog.tsx) replaced it. What survived the deletion
 * was the *shape* of it — a contract, a client method, a caller in Settings —
 * which is the state that reads as "still a feature" to the next person.
 *
 * ── The boundary this test does NOT cross ─────────────────────────────────
 * CHAT ATTACHMENTS ARE LIVE AND ARE NOT THE LIBRARY. They share vocabulary
 * with it — MediaAsset, AssetId, the CreateUpload and CompleteUpload schemas, a
 * `store.assets` collection — because an attachment is also an asset. They are
 * told apart
 * by ROUTE OWNERSHIP, not by name:
 *
 *   attachments  POST /rooms/:roomId/attachments[/complete], GET /assets/:id/content
 *                → services/api/src/modules/chat/attachments.ts EXISTS
 *   library      GET  /media/library, /media/assets/:id, POST /media/uploads
 *                → services/media was deleted; NOTHING answers these
 *
 * So this test bans the library's paths and its one client method, and says
 * nothing about the asset vocabulary the attachment pipeline still needs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@gather/contracts';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every source directory the app ships from. `test/` is excluded: this file
 *  has to be able to name the thing it bans. */
const SOURCE_DIRS = ['app', 'components', 'hooks', 'lib'];

function sourceFiles(dir: string): string[] {
  const abs = join(WEB_ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(abs, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(relative(WEB_ROOT, path)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const FILES = SOURCE_DIRS.flatMap(sourceFiles).map((path) => ({
  path: relative(WEB_ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** The client method and the two server paths that had no server. */
const LIBRARY_CALL = /listLibrary|\/media\/library|\/media\/uploads|\/media\/assets/;

describe('apps/web calls nothing that services/media used to serve', () => {
  it('has at least one source file to check (guards a broken walk)', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('never reaches for the library or its upload endpoints', () => {
    const offenders = FILES.filter((f) => LIBRARY_CALL.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('still reaches for the room-scoped attachment endpoints — those are live', () => {
    const attachments = FILES.filter((f) => /\/attachments/.test(f.text)).map((f) => f.path);
    expect(attachments).toContain('lib/attachments.ts');
  });
});

describe('@gather/contracts exports no library shape', () => {
  it('has no ListLibrary schema', () => {
    const names = Object.keys(contracts).filter((k) => /^ListLibrary/.test(k));
    expect(names).toEqual([]);
  });

  it('has no media.listLibrary entry in the rest map', () => {
    expect(Object.keys(contracts.rest.media)).not.toContain('listLibrary');
  });

  it('keeps the attachment upload schemas the composer parses', () => {
    // The inverse assertion, so deleting these is a deliberate act and not a
    // side effect of the next library sweep.
    expect(Object.keys(contracts.rest.media)).toEqual(
      expect.arrayContaining(['createUpload', 'completeUpload', 'resolveMedia']),
    );
  });
});
