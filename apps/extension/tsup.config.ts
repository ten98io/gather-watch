import { defineConfig } from 'tsup';

/** MV3 bundles: one file per entry, no splitting (service workers + content
 *  scripts must be self-contained). */
export default defineConfig({
  // Inlined into every bundle; see src/config.ts. Unset = localhost dev.
  define: {
    __PLAYIN_API_URL__: JSON.stringify(
      process.env['PLAYIN_API_URL'] ?? 'http://localhost:4000',
    ),
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
   * left bare specifiers — `from "@playin/api-client"` — in background.js and
   * offscreen.js. A browser cannot resolve a bare specifier in a service
   * worker or an extension page, so the worker threw
   * `Failed to resolve module specifier` on import and the extension never ran
   * at all: no Mode A driving, no Mode B share. It still built, still loaded,
   * and the whole test suite still passed, because nothing but a real browser
   * executes these bundles.
   */
  noExternal: [/^@playin\//],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  target: 'chrome120',
  outDir: 'dist',
  splitting: false,
  clean: true,
});
