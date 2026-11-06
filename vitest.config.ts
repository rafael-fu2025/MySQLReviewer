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
    // `.tsx` tests render components to static markup with `react-dom/server`,
    // which needs no DOM environment.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    pool: 'threads',
    testTimeout: 15_000,
  },
});
