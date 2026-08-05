// Types
export type {
  ParsedDocument,
  KnowledgeDocumentProfile,
  Chunk,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractedGraph,
  GeneratedWikiPage,
  PipelineContext,
  PipelineStage,
  PipelineProgress,
} from './types.js';

// Helpers
export { hashContent, slugify, isTextFile } from './types.js';
export { analyzeDocumentLocally } from './analysis.js';
export { embedTextLocally, cosineSimilarity, LOCAL_EMBEDDING_MODEL } from './embedding.js';

// Parsers
export { parseDocument } from './parsers/index.js';

// Chunker
export { chunkDocument } from './chunker.js';
export type { ChunkerOptions } from './chunker.js';

// Pipeline
export { runIngestionPipeline } from './pipeline.js';

// Prompts
export { buildGraphExtractionPrompt, buildWikiGenerationPrompt } from './prompts.js';
