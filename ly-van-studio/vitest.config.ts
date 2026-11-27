import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    globalSetup: ['tests/helpers/global-setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://lyvan:lyvan@localhost:5432/lyvan_test', APP_SECRET: 'test-secret-test-secret-test-secret-1234', AI_DEMO_MODE: 'true' },
  },
});
