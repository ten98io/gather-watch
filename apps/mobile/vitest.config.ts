import { defineConfig } from 'vitest/config';

// Logic-only tests: pure TS modules (room-connection reducers, theme tokens).
// No RN rendering — node environment, workspace packages resolve to their
// built dist via package exports (turbo `test` depends on ^build).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
