import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup-warnings.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: { provider: 'v8', reporter: ['text', 'json'], reportsDirectory: 'coverage', include: ['src/**'] },
  },
});
