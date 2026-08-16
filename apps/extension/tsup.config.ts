import { defineConfig } from 'tsup';

/** MV3 bundles: one file per entry, no splitting (service workers + content
 *  scripts must be self-contained). */
export default defineConfig({
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
