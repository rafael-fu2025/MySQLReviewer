import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = process.cwd();

export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
      '@shared': path.join(root, 'shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    pool: 'threads',
    testTimeout: 15_000,
  },
});
