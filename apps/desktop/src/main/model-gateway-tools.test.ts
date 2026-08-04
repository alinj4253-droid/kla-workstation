// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: { decryptString: vi.fn() },
  app: { getPath: vi.fn(() => '/mock/app/path') },
}));

import { normalizeModelTools } from './model-gateway';

describe('normalizeModelTools', () => {
  it('maps internal colon names to provider-safe names and preserves the reverse mapping', () => {
    const result = normalizeModelTools({
      'knowledge:search': {
        description: '搜索知识',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      publish_artifact: {
        description: '发布成果',
        parameters: { type: 'object', properties: {} },
      },
    });

    expect(Object.keys(result.tools ?? {})).toEqual(['knowledge_search', 'publish_artifact']);
    expect(result.internalNameByProviderName.get('knowledge_search')).toBe('knowledge:search');
    expect(result.internalNameByProviderName.get('publish_artifact')).toBe('publish_artifact');
    expect(result.tools?.knowledge_search?.inputSchema).toBeDefined();
  });

  it('deduplicates provider names after normalization', () => {
    const result = normalizeModelTools({
      'a:b': { description: 'one', parameters: { type: 'object' } },
      a_b: { description: 'two', parameters: { type: 'object' } },
    });
    expect(Object.keys(result.tools ?? {})).toEqual(['a_b', 'a_b_2']);
    expect(result.internalNameByProviderName.get('a_b_2')).toBe('a_b');
  });
});

