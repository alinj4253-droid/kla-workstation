import type { Pool } from 'pg';
import { decryptField } from '../compute/encryption.js';
import { serviceUrl } from '../knowledge-api/config.js';

type StoredConnection = { baseUrl?: unknown; encryptedCredential?: unknown };

export async function knowledgeRequest(pool: Pool, identityId: string, encryptionKey: string,
  path: string, init: RequestInit = {}): Promise<unknown> {
  const row = (await pool.query<{ value: StoredConnection }>(
    "SELECT value FROM knowledge_client_state WHERE identity_id=$1 AND name='connection.json'", [identityId])).rows[0];
  const connection = row?.value;
  if (connection && (typeof connection !== 'object' || connection.baseUrl !== serviceUrl)) {
    throw new Error('知识服务配置已变更，请重新配置连接');
  }
  let apiKey = process.env.KB_API_KEY?.trim() ?? '';
  if (connection?.encryptedCredential) {
    if (typeof connection.encryptedCredential !== 'string' || !encryptionKey) throw new Error('知识服务凭证不可用');
    try { apiKey = decryptField(connection.encryptedCredential, encryptionKey) ?? ''; }
    catch { throw new Error('知识服务凭证无法解密'); }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path === '/v1/ocr' ? 120_000 : 20_000);
  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}${path}`, {
      ...init, redirect: 'error', signal: controller.signal,
      headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}), ...init.headers },
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? '知识服务拒绝访问，请检查当前身份的服务凭证'
      : `知识服务返回 HTTP ${response.status}`);
    const size = Number(response.headers.get('content-length'));
    if (size > 2_000_000) throw new Error('知识服务响应过大');
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('知识服务响应过大');
    try { return JSON.parse(body) as unknown; }
    catch (error) { throw new Error('知识服务返回了无效 JSON', { cause: error }); }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('知识服务请求超时', { cause: error });
    throw error;
  } finally { clearTimeout(timeout); }
}
