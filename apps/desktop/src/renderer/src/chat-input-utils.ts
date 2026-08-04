export type MentionTarget = { id: string; agentName: string };
export type MentionRef = { target: { scope: 'instance'; id: string }; label: string; start: number; end: number };
export type MentionContext = { start: number; end: number; query: string };

function hasMentionEndBoundary(text: string, end: number): boolean {
  const next = text[end];
  return next === undefined || /[\s，。！？、：；,.!?:;()[\]{}<>@]/u.test(next);
}

export function extractMentions(text: string, agents: MentionTarget[]): MentionRef[] {
  const matches: Array<MentionRef & { length: number }> = [];
  for (const agent of agents) {
    const token = `@${agent.agentName}`;
    let start = 0;
    while (start < text.length) {
      const index = text.indexOf(token, start);
      if (index < 0) break;
      const end = index + token.length;
      if (!hasMentionEndBoundary(text, end)) {
        start = end;
        continue;
      }
      matches.push({
        target: { scope: 'instance', id: agent.id },
        label: agent.agentName,
        start: index,
        end,
        length: token.length,
      });
      start = end;
    }
  }

  matches.sort((left, right) => left.start - right.start || right.length - left.length);
  const result: MentionRef[] = [];
  for (const match of matches) {
    if (result.some((item) => match.start < item.end && match.end > item.start)) continue;
    const { length: _, ...mention } = match;
    result.push(mention);
  }
  return result;
}

/** 根据当前光标位置查找最近的 @ 查询；@ 可出现在句子任意位置。 */
export function findMentionContext(value: string, caret: number): MentionContext | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  if (safeCaret === 0) return null;
  const start = value.lastIndexOf('@', Math.max(0, safeCaret - 1));
  if (start < 0) return null;
  const query = value.slice(start + 1, safeCaret);
  if (query.length > 48 || /[@\r\n，。！？、：；,:;()[\]{}<>]/.test(query)) return null;
  return { start, end: safeCaret, query };
}

export function replaceMention(
  value: string,
  context: MentionContext,
  agentName: string,
): { value: string; caret: number } {
  const before = value.slice(0, context.start);
  const after = value.slice(context.end);
  const token = `@${agentName}`;
  const separator = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
  return {
    value: `${before}${token}${separator}${after}`,
    caret: before.length + token.length + separator.length,
  };
}

export function insertComposerNewline(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  return { value: `${value.slice(0, start)}\n${value.slice(end)}`, caret: start + 1 };
}

export function displayAgentText(text: string, agents: MentionTarget[]): string {
  let result = text;
  for (const agent of [...agents].sort((left, right) => right.id.length - left.id.length)) {
    if (agent.id && result.includes(agent.id)) result = result.split(agent.id).join(agent.agentName || '智能体');
  }
  return result;
}
