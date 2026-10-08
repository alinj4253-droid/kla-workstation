const serverPathKeys = new Set(['path', 'abs_path', 'source_file', 'processed_file']);

/** File locations are Main-only metadata; text content and source names are preserved. */
export function publicKnowledgeData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => publicKnowledgeData(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !serverPathKeys.has(key) && !key.endsWith('_path')).map(([key, item]) => [key, publicKnowledgeData(item)])) as T;
  }
  return value;
}
