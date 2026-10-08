import type { DocumentMeta } from '@kla-workstation/contracts/knowledge';

export interface MetaSummaryModel {
  name: string;
  totalChars: number;
  totalParagraphs: number;
}

/** Adapt the validated API DTO without deriving or inventing counts. */
export function adaptDocumentMeta(meta: DocumentMeta): MetaSummaryModel {
  return {
    name: meta.name,
    totalChars: meta.total_chars,
    totalParagraphs: meta.total_paragraphs,
  };
}
