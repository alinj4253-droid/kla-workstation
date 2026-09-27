/**
 * 统一的文本归一化与相似度工具。
 *
 * 群聊链路中所有「重复消息 / 等价指令 / 等价问题」判定必须经过本模块，
 * 避免各处自建启发式导致判定口径不一致：
 * - 指令级等价（agent_runs 委派去重）：instructionsAreEquivalent
 * - 问题级等价（awaiting_user 去重）：questionsAreEquivalent
 * - 最终消息级等价（重复交付去重）：canonicalVisibleMessage 全等判定
 */

/** 提取消息正文：JSON 输入取 text 字段，非 JSON 输入原样返回。 */
export function extractMessageText(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
  } catch { /* fall through to raw input */ }
  return contentJson;
}

/** 去掉正文中的 @mention token（中文、字母、数字、下划线、连字符）。 */
export function stripMentionTokens(text: string): string {
  return text.replace(/@[\p{L}\p{N}_-]+/gu, '');
}

/** 指令级归一化：NFKC + 小写 + 去 @mention + 去全部空白与标点。 */
export function normalizeInstructionText(text: string): string {
  return stripMentionTokens(text)
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 指令等价：归一化后全等。空文本视为不等价。 */
export function instructionsAreEquivalent(left: string, right: string): boolean {
  const a = normalizeInstructionText(left);
  const b = normalizeInstructionText(right);
  return Boolean(a) && a === b;
}

/** 用户问题级归一化：去 @mention + 去常见中文引导词 + 仅保留字母数字 + 小写。 */
export function normalizeQuestionText(text: string): string {
  return stripMentionTokens(text)
    .replace(/(?:请问|麻烦|需要你|请你|请补充|请提供|能否|是否|一下)/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length <= 2) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

/** bigram 集合相似度（交并比，分母取较小集合，即 Dice 系数变体）。 */
export function bigramSimilarity(left: string, right: string): number {
  const leftParts = bigrams(left);
  const rightParts = bigrams(right);
  const intersection = [...leftParts].filter((item) => rightParts.has(item)).length;
  return intersection / Math.max(1, Math.min(leftParts.size, rightParts.size));
}

/** 问题等价：全等 / 较长文本互相包含 / bigram 相似度 ≥ 0.72。 */
export function questionsAreEquivalent(left: string, right: string): boolean {
  const a = normalizeQuestionText(left);
  const b = normalizeQuestionText(right);
  if (!a || !b) return false;
  if (a === b || (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a)))) return true;
  return bigramSimilarity(a, b) >= 0.72;
}

/** 可见文本规范化：NFKC + 换行统一 + 行内空白压缩 + 首尾去空白。 */
export function canonicalVisibleText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 消息级规范化：从 contentJson 提取正文后做可见文本规范化。 */
export function canonicalVisibleMessage(contentJson: string): string {
  return canonicalVisibleText(extractMessageText(contentJson));
}
