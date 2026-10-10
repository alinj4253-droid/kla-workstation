import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Small object-storage boundary used by the local deployment and by tests.
 * The root directory is expected to be a persistent/shared volume in
 * production (or replaced by an S3/MinIO adapter later); callers never see
 * filesystem paths, only opaque storage keys.
 */
export class ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root || !isAbsolute(root)) throw new Error('OBJECT_STORAGE_PATH 必须是绝对路径');
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    if (isAbsolute(key) || /[:\x00]/.test(key)) throw new Error('对象存储 key 无效');
    const normalized = key.replaceAll('\\', '/');
    if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('对象存储 key 无效');
    }
    const target = resolve(this.root, normalized);
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('对象存储 key 越界');
    return target;
  }

  async put(key: string, value: Buffer | Uint8Array | string): Promise<{ key: string; sizeBytes: number }> {
    const target = this.pathFor(key);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    return { key, sizeBytes: bytes.byteLength };
  }

  async get(key: string): Promise<Buffer | null> {
    try { return await readFile(this.pathFor(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  async exists(key: string): Promise<boolean> {
    try { await stat(this.pathFor(key)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async ensureRoot(): Promise<void> { await mkdir(this.root, { recursive: true }); }

  /** Used by diagnostics without leaking the path to API callers. */
  get configuredRoot(): string { return join(this.root); }
}
