import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Make sure env-dependent config doesn't blow up in tests that don't need it.
    env: {
      OPENAI_API_KEY: 'sk-test-noop',
    },
  },
});
