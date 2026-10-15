import { describe, expect, it } from 'vitest';
import { normalizeCatalogCollection, normalizeKnowledgeCatalog, type LibraryEntry } from './knowledge-catalog.js';

const entry = (overrides: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: '测试知识库',
  description: '',
  scope: 'personal',
  collection: 'team-private',
  updatedAt: new Date(0).toISOString(),
  ...overrides,
});

describe('knowledge catalog collection normalization', () => {
  it('preserves user supplied collections for every scope', () => {
    expect(normalizeCatalogCollection(entry())).toEqual(entry());
    expect(normalizeCatalogCollection(entry({ scope: 'project', collection: 'existing-project' }))).toMatchObject({ collection: 'existing-project' });
  });

  it('migrates the shipped legacy company collection only', () => {
    const legacy = entry({ scope: 'company', collection: '年会知识库' });
    expect(normalizeCatalogCollection(legacy).collection).toBe('金牌知识库');
    expect(normalizeKnowledgeCatalog([legacy, entry()])).toEqual({
      entries: [normalizeCatalogCollection(legacy), entry()],
      changed: true,
    });
  });
});
