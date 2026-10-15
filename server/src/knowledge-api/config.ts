import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectionInputSchema, knowledgeTransportSettingsSchema, KNOWLEDGE_UPLOAD_NOTICE_VERSION, type KnowledgeConnection, type KnowledgeConnectionInput } from '@kla-workstation/contracts/knowledge';
import { encryptField, decryptField } from '../compute/encryption.js';
import { currentScope, moduleState, readStored, atomicStored } from './context.js';
import { KnowledgeError } from './transport.js';
/**
 * Keep one canonical upstream origin. A trailing slash is harmless when a
 * user enters the URL in the connection dialog, but concatenating it with an
 * endpoint produced `//health` and made some reverse proxies reject the
 * request. Canonicalising both env and persisted values also prevents a
 * needless "configured upstream changed" error after a restart.
 */
export function normalizeServiceUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
const configuredServiceUrl = normalizeServiceUrl(process.env.KNOWLEDGE_BASE_URL || '');
export const serviceUrl = configuredServiceUrl || 'http://192.168.10.206:8120';
const schema = z.object({ serviceInstanceId: z.string(), baseUrl: z.string(), collection: z.string(), secretRef: z.string().nullable(), encryptedCredential: z.string().default(''), settings: knowledgeTransportSettingsSchema, hasUploadConsent: z.boolean().default(false) });
function state() { return moduleState('config', () => ({ connection: schema.parse({ serviceInstanceId: randomUUID(), baseUrl: serviceUrl, collection: '', secretRef: null, settings: {} }), writes: Promise.resolve() as Promise<unknown> })); }
export const atomicJson = atomicStored;
export async function loadConnection() {
  try {
    const saved = schema.parse(await readStored('connection.json'));
    if (normalizeServiceUrl(saved.baseUrl) !== serviceUrl) throw new Error('Configured upstream changed');
    state().connection = { ...saved, baseUrl: serviceUrl };
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new KnowledgeError('SECRET_STORAGE_UNAVAILABLE', '服务端知识配置读取失败，请联系管理员。'); }
}
export function publicConnection(): KnowledgeConnection {
  const { encryptedCredential: _secret, ...connection } = state().connection;
  return { ...connection, hasCredential: Boolean(connection.secretRef), secureStorageAvailable: Boolean(currentScope().encryptionKey) };
}
export function authHeaders(): Record<string, string> {
  const connection = state().connection;
  if (!connection.encryptedCredential) return {};
  try { const credential = decryptField(connection.encryptedCredential, currentScope().encryptionKey); if (!credential) throw new Error('Invalid credential'); return { 'X-API-Key': credential }; }
  catch { throw new KnowledgeError('SECRET_STORAGE_UNAVAILABLE', '服务端无法解密知识服务凭证。'); }
}
export function assertService(id: string): KnowledgeConnection {
  if (id !== state().connection.serviceInstanceId) throw new KnowledgeError('CONFLICT', '连接或集合已变更，请刷新。');
  return publicConnection();
}
function serialize<T>(work: () => Promise<T>): Promise<T> { const next = state().writes.catch(() => undefined).then(work); state().writes = next; return next; }
export async function configureConnection(raw: KnowledgeConnectionInput): Promise<KnowledgeConnection> {
  return serialize(async () => {
    const input = connectionInputSchema.parse(raw);
    if (normalizeServiceUrl(input.baseUrl) !== serviceUrl) throw new KnowledgeError('VALIDATION_FAILED', '上游地址由服务端 KNOWLEDGE_BASE_URL 配置。');
    const current = state().connection;
    let encryptedCredential = input.clearCredential ? '' : current.encryptedCredential;
    let secretRef = input.clearCredential ? null : current.secretRef;
    if (input.apiKey?.trim()) {
      if (!currentScope().encryptionKey) throw new KnowledgeError('SECRET_STORAGE_UNAVAILABLE', '服务端未配置凭证加密密钥。');
      encryptedCredential = encryptField(input.apiKey.trim(), currentScope().encryptionKey);
      secretRef = randomUUID();
    }
    const next = { serviceInstanceId: randomUUID(), baseUrl: serviceUrl, collection: input.collection, encryptedCredential, secretRef, settings: input.settings ?? current.settings, hasUploadConsent: current.hasUploadConsent && !input.clearUploadConsent && input.collection === current.collection && secretRef === current.secretRef };
    await atomicJson('connection.json', next); state().connection = next;
    return publicConnection();
  });
}
export async function acceptUploadConsent(serviceId: string, noticeVersion: string): Promise<KnowledgeConnection> {
  return serialize(async () => {
    const connection = assertService(serviceId);
    if (!connection.collection || noticeVersion !== KNOWLEDGE_UPLOAD_NOTICE_VERSION) throw new KnowledgeError('VALIDATION_FAILED', '请确认当前集合与上传说明。');
    const next = { ...state().connection, hasUploadConsent: true };
    await atomicJson('connection.json', next); state().connection = next; return publicConnection();
  });
}
