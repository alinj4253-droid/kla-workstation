import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ObjectStore } from './object-store.js';

describe('persistent object store', () => {
  it('stores exact bytes, replaces atomically and rejects paths outside the object namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kla-object-test-'));
    try {
      const store = new ObjectStore(root);
      await store.ensureRoot();
      const content = Buffer.from([0, 255, 80, 75, 3, 4]);
      expect(await store.put('uploads/identity/file', content)).toEqual({ key: 'uploads/identity/file', sizeBytes: 6 });
      expect(await store.get('uploads/identity/file')).toEqual(content);
      await store.put('uploads/identity/file', 'replacement');
      expect((await store.get('uploads/identity/file'))?.toString()).toBe('replacement');
      for (const key of ['../escape', 'a/../../escape', 'a\\..\\escape', '/absolute', 'C:\\absolute', 'a:stream', 'a//b', 'a\u0000b']) {
        await expect(store.put(key, 'bad')).rejects.toThrow(/key/);
      }
      await store.remove('uploads/identity/file');
      expect(await store.get('uploads/identity/file')).toBeNull();
      expect(await store.exists('uploads/identity/file')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
