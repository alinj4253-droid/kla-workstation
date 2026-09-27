import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { McpConnectionConfig } from '@kunqing/agent-core';

export type WorkBuddyConfigEntry = {
  name: string;
  transport: 'streamableHttp' | 'sse';
  url: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  toolName?: string;
  disabled?: boolean;
  sourcePath?: string;
};

export function normalizeWorkBuddyConfigEntry(name: string, value: Record<string, unknown>, sourcePath?: string): WorkBuddyConfigEntry | null {
  if (!value || typeof value !== 'object') return null;
  const url = typeof value.url === 'string' ? value.url.trim() : '';
  if (!url) return null;
  const type = String(value.type ?? value.transport ?? value.transportType ?? '').toLocaleLowerCase();
  const rawHeaders = value.headers && typeof value.headers === 'object'
    ? value.headers as Record<string, unknown>
    : value.staticHeaders && typeof value.staticHeaders === 'object'
      ? value.staticHeaders as Record<string, unknown>
      : {};
  const headers = Object.keys(rawHeaders).length > 0
    ? Object.fromEntries(Object.entries(rawHeaders).filter(([, item]) => typeof item === 'string' && !String(item).includes('${')).map(([key, item]) => [key, String(item)]))
    : undefined;
  const entry: WorkBuddyConfigEntry = {
    name: name.replace(/^connector:/i, '') || 'WorkBuddy',
    transport: type === 'sse' ? 'sse' : 'streamableHttp',
    url,
    timeoutMs: Math.max(5000, Math.min(600000, Number(value.timeoutMs ?? value.timeout ?? 60000))),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(typeof value.toolName === 'string' && value.toolName.trim() ? { toolName: value.toolName.trim() } : {}),
    ...(value.disabled === true ? { disabled: true } : {}),
    ...(sourcePath ? { sourcePath } : {}),
  };
  return entry;
}

export function createSecretRef(): string {
  return `secret-workbuddy-${randomUUID().replaceAll('-', '')}`;
}

export function isSensitiveHeader(name: string): boolean {
  return /^(authorization|proxy-authorization|x-api-key|x-auth-token|api-key)$/i.test(name);
}

/** Store all sensitive MCP headers encrypted in the local secrets table. */
export function persistMcpHeaders(db: Database.Database, headers: Record<string, string> | undefined, existingRef?: string | null): { headers: Record<string, string>; secretRef: string | null } {
  const input = headers ?? {};
  const sensitive = Object.fromEntries(Object.entries(input).filter(([key]) => isSensitiveHeader(key)));
  const plain = Object.fromEntries(Object.entries(input).filter(([key]) => !isSensitiveHeader(key)));
  if (Object.keys(sensitive).length === 0) return { headers: plain, secretRef: null };
  if (!safeStorage.isEncryptionAvailable()) {
    // Keep functionality available on platforms without OS keychain support.
    // The caller can surface this state and let the user decide whether to continue.
    return { headers: input, secretRef: null };
  }
  const secretRef = existingRef || createSecretRef();
  const now = new Date().toISOString();
  const ciphertext = safeStorage.encryptString(JSON.stringify(sensitive));
  db.prepare(`INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at)
              VALUES (?, 'workbuddy-mcp', ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
    .run(secretRef, ciphertext, now, now);
  return { headers: plain, secretRef };
}

export function loadMcpHeaders(db: Database.Database, secretRef?: string | null): Record<string, string> {
  if (!secretRef || !safeStorage.isEncryptionAvailable()) return {};
  const row = db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(secretRef) as { ciphertext?: Buffer | string } | undefined;
  if (!row?.ciphertext) return {};
  try {
    const decrypted = Buffer.isBuffer(row.ciphertext)
      ? safeStorage.decryptString(row.ciphertext)
      : String(row.ciphertext);
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

export function resolveMcpConfigSecrets(db: Database.Database, config: Record<string, unknown>): McpConnectionConfig {
  const secretHeaders = loadMcpHeaders(db, typeof config.secretRef === 'string' ? config.secretRef : null);
  const headers = { ...secretHeaders, ...(config.headers && typeof config.headers === 'object' ? config.headers as Record<string, string> : {}) };
  return {
    transport: config.transport === 'sse' ? 'sse' : 'streamableHttp',
    url: String(config.url ?? ''),
    timeoutMs: Number(config.timeoutMs ?? 60000),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(typeof config.toolName === 'string' && config.toolName ? { toolName: config.toolName } : {}),
    ...(typeof config.secretRef === 'string' ? { secretRef: config.secretRef } : {}),
  };
}
