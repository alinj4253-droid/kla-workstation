import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    testTimeout: 15000,
    // Each test file runs in its own process to prevent cross-file state
    // leakage (e.g. module mocks, sessionStorage, Radix portal state).
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
