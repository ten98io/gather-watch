import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Both extensions, deliberately: a .test.tsx here was silently NOT RUN for
    // a while — vitest reports the rest of the suite green, which reads as
    // "my test passed" unless the count is checked.
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
