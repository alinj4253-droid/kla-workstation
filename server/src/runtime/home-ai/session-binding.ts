import type { Pool, PoolClient } from 'pg';

export type BindingScope = { identityId: string; conversationId: string; bindingVersion?: number };
export type CurrentBinding = { sessionId: string; bindingVersion: number };
export class HomeAiError extends Error {
  constructor(public readonly code: 'NOT_FOUND'|'FORBIDDEN'|'CONFLICT'|'INVALID_ARGUMENT', message: string) { super(message); }
}
export async function readCurrentBinding(client: Pool | PoolClient, scope: BindingScope, lock = false): Promise<CurrentBinding | null> {
  const row = (await client.query(`SELECT session_id,binding_version FROM home_ai_current_bindings
    WHERE identity_id=$1 AND conversation_id=$2${lock ? ' FOR UPDATE' : ''}`, [scope.identityId, scope.conversationId])).rows[0];
  if (!row) return null;
  const bindingVersion = Number(row.binding_version);
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1) throw new HomeAiError('CONFLICT', '当前诊断绑定版本无效，请刷新。');
  return { sessionId: row.session_id, bindingVersion };
}
/** Serializes the initially absent binding as well as existing binding changes. */
export async function lockCurrentBinding(client: PoolClient, scope: BindingScope): Promise<CurrentBinding | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`home-ai-binding:${scope.identityId}:${scope.conversationId}`]);
  return readCurrentBinding(client, scope, true);
}
export function assertBindingVersion(binding: CurrentBinding | null, expected?: number): void {
  if (expected !== undefined && expected !== (binding?.bindingVersion ?? 0)) throw new HomeAiError('CONFLICT', '当前岗位诊断已切换，请刷新后重新操作。');
}
export function assertCurrentSession(binding: CurrentBinding | null, sessionId: string): void {
  if (!binding || binding.sessionId !== sessionId) throw new HomeAiError('CONFLICT', '当前岗位诊断已变化，请刷新并使用当前会话。');
}
