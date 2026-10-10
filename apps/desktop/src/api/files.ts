import { fileItemSchema, uploadSessionRowSchema, type FileItem } from '@kla-workstation/contracts';
import { klaApi } from './client';

export async function uploadConversationFile(conversationId: string, file: File, identityId: string, signal?: AbortSignal): Promise<FileItem> {
  const headers = { 'x-identity-id': identityId };
  const created = await klaApi.request('/v1/files/upload-sessions', { method: 'POST', headers, signal,
    body: JSON.stringify({ conversationId, fileName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size }) });
  if (!created.ok) throw new Error(created.message);
  const session = uploadSessionRowSchema.parse(created.data);
  const uploaded = await klaApi.request(`/v1/files/upload-sessions/${session.id}/content`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: file, signal });
  if (!uploaded.ok) throw new Error(uploaded.message);
  const completed = await klaApi.request(`/v1/files/upload-sessions/${session.id}/complete`, { method: 'POST', headers, signal });
  if (!completed.ok) throw new Error(completed.message);
  return fileItemSchema.parse(completed.data);
}
