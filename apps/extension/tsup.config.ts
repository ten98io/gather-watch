import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'tsup';

import {
  formatBuildBanner,
  formatBuildInfo,
  originsMissingFromManifest,
  resolveBuildTarget,
  stampManifest,
} from './src/buildTarget';

/**
 * MV3 bundles: one file per entry, no splitting (service workers + content
 * scripts must be self-contained).
 *
 * THE ORIGIN IS DECIDED HERE, ONCE. MV3 cannot read env at runtime, so both
 * endpoints are inlined by `define` — and a wrong one produces an extension
 * that installs, announces itself, and then fails every call. `src/buildTarget.ts`
 * carries the rules and the reasoning; this file only does the I/O.
 *
 *   pnpm --filter ./apps/extension build        → dev artifact, loudly labelled
 *   pnpm --filter ./apps/extension build:prod   → refuses to guess the origin
 */
const target = resolveBuildTarget(process.env);

const manifest = JSON.parse(readFileSync(join('public', 'manifest.json'), 'utf8')) as Record<
  string,
  unknown
>;

// BEFORE a single byte is emitted. The in-code allowlist is the SECOND gate;
// the manifest is the first, and an origin the manifest does not admit never
// reaches the extension at all — Chrome blocks it before any code runs. A
// build that produced that artifact anyway would send the owner to debug the
// wrong gate.
const uncovered = originsMissingFromManifest(
  target.effectiveWebOrigins,
  (manifest['externally_connectable'] as { matches?: string[] } | undefined)?.matches ?? [],
);
if (uncovered.length > 0) {
  throw new Error(
    `GATHER_WEB_ORIGINS contains ${uncovered.join(', ')}, which ` +
      'public/manifest.json externally_connectable.matches does not admit. ' +
      'Chrome blocks those messages before any code runs — add the matching ' +
      'pattern(s) to the manifest, or drop the origin(s).',
  );
}

export default defineConfig(() => {
  // Printed from inside the config factory, not at module scope: importing
  // this file (the tests do) must not spray banners through their output.
  console.log(formatBuildBanner(target));

  return {
    define: {
      __GATHER_API_URL__: JSON.stringify(target.apiUrl),
      // Was declared in src/config.ts and documented in the README, but never
      // defined here — so `GATHER_WEB_ORIGINS=…` on the build command did
      // absolutely nothing and the allowlist silently stayed the built-in one.
      __GATHER_WEB_ORIGINS__: JSON.stringify(target.webOrigins),
    },
    entry: {
      background: 'src/background.ts',
      content: 'src/content.ts',
      offscreen: 'src/offscreen.ts',
      popup: 'src/popup.ts',
    },
    /**
     * The workspace packages MUST be bundled in.
     *
     * tsup externalises everything listed in `dependencies` by default, which
     * left bare specifiers — `from "@gather/api-client"` — in background.js and
     * offscreen.js. A browser cannot resolve a bare specifier in a service
     * worker or an extension page, so the worker threw
     * `Failed to resolve module specifier` on import and the extension never ran
     * at all: no Mode A driving, no Mode B share. It still built, still loaded,
     * and the whole test suite still passed, because nothing but a real browser
     * executes these bundles.
     */
    noExternal: [/^@gather\//],
    format: ['esm' as const],
    dts: false,
    sourcemap: true,
    target: 'chrome120',
    outDir: 'dist',
    splitting: false,
    clean: true,
    /**
     * Static assets + the artifact's own identity. This used to be an inline
     * `node -e` one-liner in package.json, where nothing could check it.
     */
    onSuccess: async (): Promise<void> => {
      mkdirSync('dist', { recursive: true });
      for (const file of readdirSync('public')) {
        if (file.startsWith('.')) continue;
        if (file === 'manifest.json') continue;
        copyFileSync(join('public', file), join('dist', file));
      }
      writeFileSync(
        join('dist', 'manifest.json'),
        `${JSON.stringify(stampManifest(manifest, target), null, 2)}\n`,
      );
      writeFileSync(join('dist', 'BUILD.txt'), formatBuildInfo(target, new Date().toISOString()));
    },
  };
});
