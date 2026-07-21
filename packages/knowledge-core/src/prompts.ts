/**
 * LLM prompt templates for knowledge graph extraction and wiki generation.
 */

export function buildGraphExtractionPrompt(chunks: Array<{ ordinal: number; text: string }>): string {
  const chunkTexts = chunks
    .map((c) => `[Chunk ${c.ordinal}]\n${c.text}`)
    .join('\n\n---\n\n');

  return `你是一个知识图谱提取代理。分析以下文本并提取结构化知识。

## 指令：
1. 识别实体（人物、概念、技术、工具、组织、流程、协议等）
2. 识别实体之间的关系
3. 为每个实体提供简要摘要和属性
4. 为每个关系指定类型

## 输出格式（纯 JSON，不要包含 markdown 代码块标记）：
{
  "entities": [
    {
      "name": "实体名称",
      "type": "concept|person|technology|tool|organization|process|protocol|other",
      "summary": "实体的简要描述（1-2句话）",
      "properties": { "key": "value" },
      "confidence": 0.9
    }
  ],
  "relationships": [
    {
      "source": "源实体名称",
      "target": "目标实体名称",
      "type": "depends_on|uses|implements|belongs_to|related_to|contains|precedes|communicates_with",
      "properties": { "key": "value" },
      "confidence": 0.8
    }
  ]
}

注意：
- 实体名称必须与文本中出现的名称一致
- 只提取有意义的实体，忽略无关紧要的细节
- 置信度 0.0-1.0，表示提取的确定性
- 如果文本中没有有意义的内容，返回空数组

## 待分析文本：
${chunkTexts}`;
}

export function buildWikiGenerationPrompt(
  entity: { name: string; type: string; summary: string; properties: Record<string, string> },
  related: Array<{ name: string; type: string; summary: string; edgeType: string }>,
  sourceRefs: Array<{ chunkText: string }>,
): string {
  const relatedText = related.length > 0
    ? related.map((r) => `- **${r.name}** (${r.type}): ${r.summary} [关系: ${r.edgeType}]`).join('\n')
    : '无关联实体';

  const sourceText = sourceRefs.length > 0
    ? sourceRefs.map((s, i) => `[来源 ${i + 1}]\n${s.chunkText.slice(0, 500)}`).join('\n\n')
    : '无来源文本';

  const propsText = Object.keys(entity.properties).length > 0
    ? Object.entries(entity.properties).map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : '无';

  return `你是一个 Wiki 生成器。基于以下知识图谱数据，生成一个全面的 Markdown 格式的 Wiki 页面。

## 实体信息：
- 名称: ${entity.name}
- 类型: ${entity.type}
- 摘要: ${entity.summary}
- 属性:
${propsText}

## 关联实体：
${relatedText}

## 来源文本：
${sourceText}

## 输出格式（纯 Markdown）：
# ${entity.name}

## 概述
[2-3 段的概述]

## 关键属性
[列出关键属性]

## 关联关系
[描述与其他实体的关系]

## 来源
[引用来源文本]

只输出 Markdown 内容，不要包含任何其他说明。`;
}