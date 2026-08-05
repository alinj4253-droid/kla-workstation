const DEFAULT_DIMENSIONS = 384;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Offline, deterministic multilingual embedding used by the built-in baseline.
 * It applies signed feature hashing over words and CJK n-grams. A local ONNX
 * model pack can replace this implementation without changing the index schema.
 */
export function embedTextLocally(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const vector = new Float32Array(dimensions);
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens = normalized.match(/[a-z0-9][a-z0-9._-]*|[\u4e00-\u9fff]/g) ?? [];
  const features = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) features.push(`${tokens[i]}${tokens[i + 1]}`);
  for (const feature of features) {
    const hash = fnv1a(feature);
    const index = hash % dimensions;
    vector[index] = (vector[index] ?? 0) + ((hash & 0x80000000) === 0 ? 1 : -1);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return Array.from(vector);
  const scale = 1 / Math.sqrt(norm);
  return Array.from(vector, (value) => Number((value * scale).toFixed(7)));
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < length; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export const LOCAL_EMBEDDING_MODEL = {
  id: 'kunqing-feature-hash-multilingual-v1',
  dimensions: DEFAULT_DIMENSIONS,
  privacy: 'offline' as const,
};
