import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    // The desktop suites share jsdom globals, IndexedDB and mocked preload
    // state. Running files in parallel makes unrelated tests contend for that
    // shared environment and intermittently hit the five second test timeout.
    fileParallelism: false,
  },
});
