import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
export interface KnowledgeStore { read(owner: string, name: string): Promise<unknown | undefined>; write(owner: string, name: string, value: unknown): Promise<void> }
export class PostgresKnowledgeStore implements KnowledgeStore {
  constructor(private pool: Pool) {}
  async read(owner: string, name: string) { return (await this.pool.query('SELECT value FROM knowledge_client_state WHERE identity_id=$1 AND name=$2', [owner, name])).rows[0]?.value; }
  async write(owner: string, name: string, value: unknown) { await this.pool.query('INSERT INTO knowledge_client_state(identity_id,name,value) VALUES($1,$2,$3) ON CONFLICT(identity_id,name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()', [owner, name, JSON.stringify(value)]); }
}
export class MemoryKnowledgeStore implements KnowledgeStore {
  private data = new Map<string, unknown>();
  async read(owner: string, name: string) { return this.data.get(owner + ':' + name); }
  async write(owner: string, name: string, value: unknown) { this.data.set(owner + ':' + name, structuredClone(value)); }
}
interface Scope { owner: string; ownerNumber: number; store: KnowledgeStore; encryptionKey: string; modules: Map<string, unknown>; pool?: Pool }
const contexts = new AsyncLocalStorage<Scope>();
export function createScope(owner: string, ownerNumber: number, store: KnowledgeStore, encryptionKey: string, pool?: Pool): Scope { return { owner, ownerNumber, store, encryptionKey, modules: new Map(), pool }; }
export function inScope<T>(scope: Scope, work: () => T): T { return contexts.run(scope, work); }
export function currentScope(): Scope { const scope = contexts.getStore(); if (!scope) throw new Error('Knowledge identity context missing'); return scope; }
export function moduleState<T>(name: string, init: () => T): T { const scope = currentScope(); if (!scope.modules.has(name)) scope.modules.set(name, init()); return scope.modules.get(name) as T; }
export async function readStored(name: string): Promise<unknown> { const scope = currentScope(); const value = await scope.store.read(scope.owner, name); if (value === undefined) throw Object.assign(new Error('No saved state'), { code: 'ENOENT' }); return value; }
export async function atomicStored(name: string, value: unknown): Promise<void> { const scope = currentScope(); await scope.store.write(scope.owner, name, value); }
