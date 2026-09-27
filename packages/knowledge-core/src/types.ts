// ── Parser types ──

export interface ParsedDocument {
  /** Full text content of the document */
  text: string;
  /** Detected MIME type */
  mimeType: string;
  /** Metadata about the parsed document */
  metadata: {
    pageCount?: number;
    /** Character offsets at which source pages begin, when the parser can recover them. */
    pageOffsets?: number[];
    title?: string;
    author?: string;
    parserId?: string;
    requiresOcr?: boolean;
    [key: string]: unknown;
  };
}

export interface KnowledgeDocumentProfile {
  summary: string;
  keywords: string[];
  tags: string[];
  language: 'zh' | 'en' | 'mixed' | 'unknown';
}

// ── Chunker types ──

export interface Chunk {
  /** Database ID after persistence. */
  id?: string;
  /** Ordinal index within the source */
  ordinal: number;
  /** Chunk text content */
  text: string;
  /** Location info (e.g., page number, line range) */
  locationJson?: string;
  /** Exact range in the normalized document text. End offset is exclusive. */
  startOffset?: number;
  endOffset?: number;
  /** Source page when known, otherwise a deterministic logical page. */
  pageNumber?: number;
  /** Nearest section heading in the normalized document. */
  sectionPath?: string;
  /** Content hash for deduplication */
  contentHash: string;
}

// ── Graph extraction types ──

export interface ExtractedEntity {
  name: string;
  type: string;
  summary: string;
  properties: Record<string, string>;
  confidence: number;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
  properties: Record<string, string>;
  confidence: number;
}

export interface ExtractedGraph {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

// ── Wiki types ──

export interface GeneratedWikiPage {
  slug: string;
  title: string;
  bodyMd: string;
  sourceRefs: Array<{ sourceId: string; chunkId: string }>;
}

// ── Pipeline context (dependency injection) ──

export interface PipelineContext {
  sourceId: string;
  scopeType: string;
  scopeId: string;
  filePath: string;
  fileName: string;
  fileExt: string;
  fileSize: number;

  /** Read the file content as a Uint8Array */
  readFile(): Promise<Uint8Array>;

  /** Run an installed local OCR model pack for image/scanned content. */
  ocrExtract?(filePath: string): Promise<string>;

  /** Persist file-level summary, keywords and tags. */
  saveDocumentProfile?(profile: KnowledgeDocumentProfile, metadata: ParsedDocument['metadata']): Promise<void>;

  /** Persist normalized full text and its chunk files outside the retrieval index. */
  saveStandardizedDocument?(document: ParsedDocument, chunks: Chunk[]): Promise<void>;

  /** Allow the configured model to refine the local document profile. */
  analyzeDocument?(text: string, fallback: KnowledgeDocumentProfile): Promise<KnowledgeDocumentProfile>;

  /** Emit a chunk to the database */
  saveChunk(chunk: Chunk): Promise<void>;

  /** Check if a chunk with the same hash already exists */
  chunkExistsByHash(contentHash: string): Promise<boolean>;

  /** Upsert a knowledge node */
  upsertNode(entity: ExtractedEntity): Promise<string>;

  /** Upsert a knowledge edge */
  upsertEdge(rel: ExtractedRelationship, sourceNodeId: string, targetNodeId: string): Promise<string>;

  /** Create provenance record */
  createProvenance(targetType: string, targetId: string, sourceId: string, chunkId: string, locationJson?: string, quoteHash?: string): Promise<void>;

  /** Add low-confidence / schema-mismatch candidate for manual review */
  addPendingReview?(scopeType: string, scopeId: string, candidateType: string, dataJson: string, reason: string): void;

  /** Upsert a wiki page */
  upsertWikiPage(page: GeneratedWikiPage): Promise<void>;

  /** Call LLM for graph extraction */
  llmExtract(chunks: Chunk[]): Promise<ExtractedGraph>;

  /** Call LLM for wiki generation */
  llmGenerateWiki(entity: ExtractedEntity, related: Array<{ name: string; type: string; summary: string; edgeType: string }>, sourceRefs: Array<{ sourceId: string; chunkId: string }>): Promise<GeneratedWikiPage>;

  /** Update job status */
  setJobStatus(status: string, stage?: string, progress?: number, errorCode?: string): Promise<void>;

  /** Mark source as ready or error */
  setSourceStatus(status: 'ready' | 'error'): Promise<void>;

  /** Get logger */
  log(message: string, data?: Record<string, unknown>): void;
}

// ── Pipeline stages ──

export type PipelineStage = 'parsing' | 'chunking' | 'extracting' | 'generating_wiki' | 'completed' | 'failed';

export interface PipelineProgress {
  stage: PipelineStage;
  progress: number;
  detail?: string;
}

// ── Helpers ──

/** Simple hash function for content deduplication (does not require node:crypto) */
export function hashContent(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function isTextFile(ext: string): boolean {
  const textExts = ['txt', 'md', 'json', 'csv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bat', 'ps1', 'py', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'svg'];
  return textExts.includes(ext.toLowerCase());
}
