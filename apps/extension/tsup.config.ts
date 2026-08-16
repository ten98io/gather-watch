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
  format: ['esm'],
  dts: false,
  sourcemap: true,
  target: 'chrome120',
  outDir: 'dist',
  splitting: false,
  clean: true,
});
