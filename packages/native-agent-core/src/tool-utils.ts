import type { ToolCall } from './types.js';

export function extractToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const nameRegex = /(\w+(?::\w+)?)\s*\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = nameRegex.exec(text)) !== null) {
    const name = match[1]!;
    const startIdx = match.index + match[0].length - 1;
    let depth = 1;
    let i = startIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth > 0) i++;
    }
    if (depth === 0) {
      const jsonStr = text.slice(startIdx, i + 1);
      try {
        const args = JSON.parse(jsonStr) as Record<string, unknown>;
        calls.push({ name, args });
      } catch { /* skip invalid JSON */ }
    }
  }
  return calls;
}
