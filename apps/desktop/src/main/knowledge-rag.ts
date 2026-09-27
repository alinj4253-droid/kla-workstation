import type { ModelGateway, ModelSlot } from './model-gateway';
import type { HybridKnowledgeHit, HybridKnowledgeResult } from './hybrid-knowledge-search';

const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_CHARS = 700;

type TextGenerationOptions = Parameters<ModelGateway['generateText']>[2];

export type RagSynthesisResult = {
  answer: string;
  evidenceCount: number;
  modelSlot: ModelSlot | null;
};

const compact = (value: string, limit: number): string => value.replace(/\s+/g, ' ').trim().slice(0, limit);

const evidenceKey = (hit: HybridKnowledgeHit): string => compact(hit.excerpt, 220)
  .toLocaleLowerCase('zh-CN')
  .replace(/[\s，。！？、：；,.!?:;"'“”‘’（）()【】\[\]]/g, '');

export function selectRagEvidence(result: HybridKnowledgeResult): HybridKnowledgeHit[] {
  const selected: HybridKnowledgeHit[] = [];
  const seen = new Set<string>();
  for (const hit of result.hits) {
    const key = evidenceKey(hit);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(hit);
    if (selected.length >= MAX_EVIDENCE_ITEMS) break;
  }
  return selected;
}

const sourceLabel = (hit: HybridKnowledgeHit): string => {
  const file = hit.sourceFile ?? hit.title;
  return `${file}${hit.location ? `，位置：${hit.location}` : ''}`;
};

export function buildRagEvidenceContext(hits: HybridKnowledgeHit[]): string {
  return hits.map((hit, index) => (
    `[${index + 1}] 来源：${sourceLabel(hit)}\n内容：${compact(hit.excerpt, MAX_EVIDENCE_CHARS)}`
  )).join('\n\n');
}

function sourceAppendix(hits: HybridKnowledgeHit[]): string {
  return hits.map((hit, index) => `[${index + 1}] ${sourceLabel(hit)}`).join('\n');
}

export function fallbackRagAnswer(query: string, hits: HybridKnowledgeHit[]): string {
  if (hits.length === 0) {
    return `当前群聊个人知识、已关联项目知识和企业知识中没有找到能够回答“${compact(query, 120)}”的可靠证据。`;
  }
  const conclusions = hits.slice(0, 4).map((hit, index) => (
    `- ${compact(hit.excerpt, 240)} [${index + 1}]`
  ));
  return `根据当前知识库，可以确认以下信息：\n\n${conclusions.join('\n')}\n\n来源：\n${sourceAppendix(hits.slice(0, 4))}`;
}

/** Prefer the fast slot, but use reasoning when the workspace has not bound a fast model. */
export async function generateKnowledgeText(
  gateway: Pick<ModelGateway, 'generateText'>,
  messages: Parameters<ModelGateway['generateText']>[1],
  options?: TextGenerationOptions,
): Promise<{ text: string; slot: ModelSlot }> {
  try {
    const result = await gateway.generateText('fast', messages, options);
    return { text: result.text, slot: 'fast' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/模型未配置.*快速|fast/i.test(message)) throw error;
    const result = await gateway.generateText('reasoning', messages, options);
    return { text: result.text, slot: 'reasoning' };
  }
}

export async function synthesizeKnowledgeAnswer(input: {
  gateway: Pick<ModelGateway, 'generateText'>;
  query: string;
  result: HybridKnowledgeResult;
  roleDirective?: string;
}): Promise<RagSynthesisResult> {
  const hits = selectRagEvidence(input.result);
  if (hits.length === 0) return { answer: fallbackRagAnswer(input.query, hits), evidenceCount: 0, modelSlot: null };

  const evidenceContext = buildRagEvidenceContext(hits);
  try {
    const generated = await generateKnowledgeText(input.gateway, [{
      role: 'user',
      content: `用户问题：\n${input.query}\n\n检索证据：\n${evidenceContext}\n\n请基于证据回答。`,
    }], {
      system: `${input.roleDirective ?? ''}\n\n你正在执行本地知识库 RAG 问答。先在内部比较、去重并梳理证据，再直接回答用户。只能使用给定证据；每个关键结论用 [1]、[2] 形式引用对应来源。证据冲突或不足时明确说明，不得补造。不要逐段复述检索切片，不要展示相关度、检索通道、向量或其他底层技术字段。语言自然、简洁。`,
    });
    let answer = generated.text.trim();
    if (!answer) answer = fallbackRagAnswer(input.query, hits);
    if (!/\[\d+\]/.test(answer)) answer = `${answer}\n\n来源：\n${sourceAppendix(hits)}`;
    return { answer, evidenceCount: hits.length, modelSlot: generated.slot };
  } catch {
    return { answer: fallbackRagAnswer(input.query, hits), evidenceCount: hits.length, modelSlot: null };
  }
}
