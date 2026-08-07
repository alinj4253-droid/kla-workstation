import { describe, expect, it, vi } from 'vitest';
import { runIngestionPipeline } from '../src/pipeline';
import type { PipelineContext, ExtractedGraph, GeneratedWikiPage, Chunk, ExtractedEntity, ExtractedRelationship } from '../src/types';

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const log = vi.fn();

  // Longer content to ensure it passes the 10-char minimum and includes entity names
  const longContent = 'This document is about Entity1 and Entity2.\n\nEntity1 is a concept related to artificial intelligence.\n\nEntity2 is closely related to Entity1 in many ways.\n\nThis is the fourth paragraph with additional content for testing purposes.\n\nThe fifth paragraph contains even more text to make the document sufficiently long.';

  return {
    sourceId: 'src-1',
    scopeType: 'group',
    scopeId: 'scope-1',
    filePath: '/test/file.txt',
    fileName: 'file.txt',
    fileExt: 'txt',
    fileSize: 100,
    readFile: vi.fn().mockResolvedValue(new TextEncoder().encode(longContent)),
    saveChunk: vi.fn().mockResolvedValue(undefined),
    chunkExistsByHash: vi.fn().mockResolvedValue(false),
    upsertNode: vi.fn().mockImplementation(async (entity: ExtractedEntity) => `node-${entity.name}`),
    upsertEdge: vi.fn().mockResolvedValue('edge-1'),
    createProvenance: vi.fn().mockResolvedValue(undefined),
    upsertWikiPage: vi.fn().mockResolvedValue(undefined),
    llmExtract: vi.fn().mockResolvedValue({
      entities: [
        { name: 'Entity1', type: 'concept', summary: 'First entity', properties: {}, confidence: 0.9 },
        { name: 'Entity2', type: 'concept', summary: 'Second entity', properties: {}, confidence: 0.8 },
      ],
      relationships: [
        { source: 'Entity1', target: 'Entity2', type: 'related_to', properties: {}, confidence: 0.9 },
      ],
    } satisfies ExtractedGraph),
    llmGenerateWiki: vi.fn().mockResolvedValue({
      slug: 'entity1',
      title: 'Entity1',
      bodyMd: 'Page about Entity1',
      sourceRefs: [],
    } satisfies GeneratedWikiPage),
    setJobStatus: vi.fn().mockResolvedValue(undefined),
    setSourceStatus: vi.fn().mockResolvedValue(undefined),
    log,
    ...overrides,
  };
}

describe('runIngestionPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes a file through the full pipeline', async () => {
    const ctx = makeContext();
    await runIngestionPipeline(ctx);

    // Verify all stages were called
    expect(ctx.readFile).toHaveBeenCalledOnce();
    expect(ctx.saveChunk).toHaveBeenCalled();
    expect(ctx.llmExtract).toHaveBeenCalledOnce();
    expect(ctx.llmGenerateWiki).toHaveBeenCalled();
    expect(ctx.setSourceStatus).toHaveBeenCalledWith('ready');
    expect(ctx.setJobStatus).toHaveBeenCalled();
  });

  it('skips graph extraction for short/empty text', async () => {
    const ctx = makeContext({
      readFile: vi.fn().mockResolvedValue(new Uint8Array([0])), // empty content
    });
    await runIngestionPipeline(ctx);

    // After parsing, if text is too short, skip extraction
    expect(ctx.llmExtract).not.toHaveBeenCalled();
    expect(ctx.llmGenerateWiki).not.toHaveBeenCalled();
    expect(ctx.setSourceStatus).toHaveBeenCalledWith('ready');
  });

  it('handles LLM extraction failure gracefully', async () => {
    const ctx = makeContext({
      llmExtract: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    });
    await runIngestionPipeline(ctx);

    expect(ctx.setSourceStatus).toHaveBeenCalledWith('ready');
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining('图谱提取失败'),
      expect.any(Object),
    );
  });

  it('handles LLM wiki generation failure gracefully', async () => {
    const ctx = makeContext({
      llmGenerateWiki: vi.fn().mockRejectedValue(new Error('Wiki gen failed')),
    });
    await runIngestionPipeline(ctx);

    expect(ctx.setSourceStatus).toHaveBeenCalledWith('ready');
    expect(ctx.upsertWikiPage).not.toHaveBeenCalled();
  });

  it('deduplicates chunks by content hash', async () => {
    const ctx = makeContext({
      chunkExistsByHash: vi.fn().mockResolvedValue(true),
    });
    await runIngestionPipeline(ctx);

    // All chunks should be skipped as duplicates
    expect(ctx.saveChunk).not.toHaveBeenCalled();
  });

  it('creates provenance records for entities', async () => {
    const ctx = makeContext();
    await runIngestionPipeline(ctx);

    expect(ctx.createProvenance).toHaveBeenCalled();
    const calls = ctx.createProvenance.mock.calls.filter((call: unknown[]) => call[0] === 'node');
    calls.forEach((call: unknown[]) => {
      expect(call[1]).toMatch(/^node-/);
    });
  });

  it('marks source as error on pipeline failure', async () => {
    const ctx = makeContext({
      readFile: vi.fn().mockRejectedValue(new Error('File not found')),
    });
    await expect(runIngestionPipeline(ctx)).rejects.toThrow('File not found');

    expect(ctx.setSourceStatus).toHaveBeenCalledWith('error');
    expect(ctx.setJobStatus).toHaveBeenCalledWith('failed', 'failed', 0, 'PIPELINE_ERROR');
  });

  it('reports progress through stages', async () => {
    const ctx = makeContext();
    await runIngestionPipeline(ctx);

    // Should have been called for parsing, chunking, extracting, generating_wiki, completed
    expect(ctx.setJobStatus.mock.calls.length).toBeGreaterThanOrEqual(5);

    // Check specific stages
    const stages = ctx.setJobStatus.mock.calls.map((c: unknown[]) => c[1]);
    expect(stages).toContain('parsing');
    expect(stages).toContain('chunking');
    expect(stages).toContain('extracting');
    expect(stages).toContain('generating_wiki');
    expect(stages).toContain('completed');
  });
});
