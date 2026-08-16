import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The extension compiles @gather/sync-core from SOURCE rather than from its
 * built `dist` — see the matching `paths` entry in tsconfig.json. The elastic
 * drift controller is the extension's sync brain, so the unit tests must run
 * against the real module, not against whatever `dist` happens to be lying
 * around from an earlier build.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@gather/sync-core': fileURLToPath(
        new URL('../../packages/sync-core/src/index.ts', import.meta.url),
      ),
    },
  },
});
