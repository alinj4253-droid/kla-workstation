import { cp } from 'node:fs/promises';

// Keep packaged server initialization independent of the source tree.
await cp(new URL('../migrations/', import.meta.url), new URL('../dist/migrations/', import.meta.url), { recursive: true });
