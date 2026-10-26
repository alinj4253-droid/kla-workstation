import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRepository, Artifact } from '../repositories/types.js';
import type { ShortTermMemoryService } from '../memories/short-term.js';
import { RuntimeTools } from './tools.js';

const identityId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const artifactId = '30000000-0000-4000-8000-000000000003';
const scope = { identityId, conversationId, agentId: '40000000-0000-4000-8000-000000000004' };
const pdf = Buffer.from('%PDF-1.7\n%%EOF');

function fixture(artifact?: Partial<Artifact>, allowed = true) {
  const pool = {
    hasPermission: () => allowed,
    query: vi.fn(async (sql: string) => {
      // assertArtifactAgentAccess 查询 artifacts 表校验成果归属
      if (sql.includes('FROM artifacts')) {
        return { rows: [{ source_agent_id: null, agent_private: false }] };
      }
      return { rows: [] };
    })
  } as unknown as Pool;
  const accounts = { getArtifact: vi.fn(async () => artifact === null ? null : ({
    id: artifactId, conversationId, name: 'source.pdf', mimeType: 'application/pdf',
    content: pdf.toString('base64'), contentEncoding: 'base64', sizeBytes: pdf.length,
    createdAt: new Date().toISOString(), ...artifact,
  })) } as unknown as AccountRepository;
  return { pool, accounts, tools: new RuntimeTools(pool, accounts, {} as ShortTermMemoryService, '') };
}

afterEach(() => vi.unstubAllGlobals());

describe('server tools authorization and OCR contract', () => {
  it('rejects execution without the current identity execute grant', async () => {
    const { tools } = fixture(undefined, false);
    await expect(tools.execute('knowledge_ocr', { artifactId }, scope)).rejects.toThrow('PERMISSION_DENIED:execute');
    await expect(tools.execute('web_search', { query: 'test' }, scope)).rejects.toThrow('PERMISSION_DENIED:execute');
  });

  it('rejects a PDF artifact from another conversation before contacting OCR', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const { tools } = fixture({ conversationId: '50000000-0000-4000-8000-000000000005' });
    await expect(tools.execute('knowledge_ocr', { artifactId }, scope)).rejects.toThrow('当前群聊');
    expect(request).not.toHaveBeenCalled();
  });

  it('uploads the authorized PDF and validates the observed OCR result', async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      const form = init.body as FormData;
      expect(form.get('max_pages')).toBe('2');
      expect((form.get('file') as File).type).toBe('application/pdf');
      return new Response(JSON.stringify({ filename: 'source.pdf', pages: 1, chars: 4, markdown: '测试文本' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', request);
    const { tools } = fixture();
    await expect(tools.execute('knowledge_ocr', { artifactId, maxPages: 2 }, scope)).resolves.toMatchObject({
      filename: 'source.pdf', pages: 1, chars: 4, markdown: '测试文本',
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
