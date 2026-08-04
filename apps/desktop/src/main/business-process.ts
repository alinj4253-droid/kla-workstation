import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BusinessProcess, BusinessProcessActionType, BusinessProcessStage } from '@kunqing/native-agent-core';
import type { ModelGateway } from './model-gateway';

export const POST_TASK_KNOWLEDGE_PREFIX = 'KQ_POST_TASK_KNOWLEDGE_V1';

export type PostTaskKnowledgePayload = {
  originalTask: string;
  teamResults: string;
  deliverables: string[];
};

type KnowledgeCapture = {
  title: string;
  summary: string;
  reusableInsights: string[];
  constraints: string[];
  risks: string[];
  recommendedPractices: string[];
};

type ParsedCapture = {
  process: Omit<BusinessProcess, 'generatedByAgentId' | 'generatedByAgentName' | 'generatedAt' | 'knowledgeDocumentPath'>;
  knowledge: KnowledgeCapture;
};

const ACTION_TYPES = new Set<BusinessProcessActionType>([
  'research', 'acquire', 'calculate', 'analyze', 'synthesize', 'validate', 'deliver', 'other',
]);

function cleanText(value: unknown, fallback = '', maxLength = 1_000): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function cleanList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 500))
    .slice(0, limit);
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const parsed = JSON.parse(candidate.trim()) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('知识归集结果不是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function normalizeId(value: unknown, fallback: string): string {
  const normalized = cleanText(value, fallback, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function parseStages(value: unknown): BusinessProcessStage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((stageValue, stageIndex) => {
    if (!stageValue || typeof stageValue !== 'object' || Array.isArray(stageValue)) return [];
    const stage = stageValue as Record<string, unknown>;
    const title = cleanText(stage.title, '', 120);
    if (!title) return [];
    const rawSteps = Array.isArray(stage.steps) ? stage.steps : [];
    const steps = rawSteps.slice(0, 16).flatMap((stepValue, stepIndex) => {
      if (!stepValue || typeof stepValue !== 'object' || Array.isArray(stepValue)) return [];
      const step = stepValue as Record<string, unknown>;
      const stepTitle = cleanText(step.title, '', 140);
      if (!stepTitle) return [];
      const rawActionType = cleanText(step.actionType, 'other', 24) as BusinessProcessActionType;
      return [{
        id: normalizeId(step.id, `stage-${stageIndex + 1}-step-${stepIndex + 1}`),
        title: stepTitle,
        actionType: ACTION_TYPES.has(rawActionType) ? rawActionType : 'other',
        ...(cleanText(step.description) ? { description: cleanText(step.description) } : {}),
        ...(cleanList(step.inputs).length ? { inputs: cleanList(step.inputs) } : {}),
        ...(cleanList(step.outputs).length ? { outputs: cleanList(step.outputs) } : {}),
        ...(cleanText(step.owner, '', 100) ? { owner: cleanText(step.owner, '', 100) } : {}),
      }];
    });
    if (steps.length === 0) return [];
    return [{
      id: normalizeId(stage.id, `stage-${stageIndex + 1}`),
      title,
      ...(cleanText(stage.objective) ? { objective: cleanText(stage.objective) } : {}),
      ...(cleanText(stage.owner, '', 100) ? { owner: cleanText(stage.owner, '', 100) } : {}),
      steps,
    }];
  });
}

export function parseBusinessProcessResponse(raw: string, originalTask: string): ParsedCapture {
  const parsed = extractJsonObject(raw);
  const processValue = parsed.businessProcess;
  const processRow = processValue && typeof processValue === 'object' && !Array.isArray(processValue)
    ? processValue as Record<string, unknown>
    : {};
  const knowledgeValue = parsed.knowledgeDocument;
  const knowledgeRow = knowledgeValue && typeof knowledgeValue === 'object' && !Array.isArray(knowledgeValue)
    ? knowledgeValue as Record<string, unknown>
    : {};
  const applicable = processRow.applicable === true;
  const stages = applicable ? parseStages(processRow.stages) : [];
  const reason = cleanText(processRow.reason, applicable ? '' : '本次任务不适合抽象为可复用业务流程。', 500);

  return {
    process: {
      schemaVersion: 1,
      applicable: applicable && stages.length > 0,
      ...(!applicable || stages.length === 0 ? { reason: reason || '未形成有效的业务流程模型。' } : {}),
      title: cleanText(processRow.title, cleanText(originalTask, '本次任务', 120), 160),
      ...(cleanText(processRow.summary) ? { summary: cleanText(processRow.summary) } : {}),
      stages,
    },
    knowledge: {
      title: cleanText(knowledgeRow.title, `${cleanText(originalTask, '本次任务', 80)} - 知识与经验归集`, 160),
      summary: cleanText(knowledgeRow.summary, '已归集本次任务中的有效知识与经验。', 2_000),
      reusableInsights: cleanList(knowledgeRow.reusableInsights),
      constraints: cleanList(knowledgeRow.constraints),
      risks: cleanList(knowledgeRow.risks),
      recommendedPractices: cleanList(knowledgeRow.recommendedPractices),
    },
  };
}

export function parsePostTaskKnowledgeInstruction(raw: string): PostTaskKnowledgePayload | null {
  const trimmed = raw.trim();
  const markerIndex = trimmed.indexOf(POST_TASK_KNOWLEDGE_PREFIX);
  if (markerIndex < 0) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(markerIndex + POST_TASK_KNOWLEDGE_PREFIX.length).trim()) as Partial<PostTaskKnowledgePayload>;
    if (typeof parsed.originalTask !== 'string' || typeof parsed.teamResults !== 'string') return null;
    return {
      originalTask: parsed.originalTask,
      teamResults: parsed.teamResults,
      deliverables: cleanList(parsed.deliverables, 30),
    };
  } catch {
    return null;
  }
}

function markdownSection(title: string, items: string[]): string {
  if (items.length === 0) return '';
  return `\n## ${title}\n\n${items.map((item) => `- ${item}`).join('\n')}\n`;
}

function renderKnowledgeDocument(capture: ParsedCapture, payload: PostTaskKnowledgePayload, process: BusinessProcess): string {
  const workflow = process.applicable
    ? `\n## 业务流程\n\n${process.stages.map((stage, stageIndex) => (
      `${stageIndex + 1}. **${stage.title}**${stage.objective ? `：${stage.objective}` : ''}\n${stage.steps.map((step) => `   - ${step.title}${step.description ? `：${step.description}` : ''}`).join('\n')}`
    )).join('\n')}`
    : `\n## 业务流程适用性\n\n${process.reason ?? '本次任务不适合抽象为可复用业务流程。'}\n`;
  return `# ${capture.knowledge.title}\n\n> 归集时间：${process.generatedAt}\n\n## 任务背景\n\n${payload.originalTask}\n\n## 归集摘要\n\n${capture.knowledge.summary}\n${markdownSection('可复用结论', capture.knowledge.reusableInsights)}${markdownSection('约束条件', capture.knowledge.constraints)}${markdownSection('风险与待确认项', capture.knowledge.risks)}${markdownSection('推荐做法', capture.knowledge.recommendedPractices)}${workflow}\n`;
}

export async function runPostTaskKnowledgeCapture(input: {
  gateway: ModelGateway;
  payload: PostTaskKnowledgePayload;
  projectRoot: string;
  runId: string;
  agentInstanceId: string;
  agentName: string;
}): Promise<{ businessProcess: BusinessProcess; knowledgeDocumentPath: string; responseText: string }> {
  const prompt = `原始任务：\n${input.payload.originalTask.slice(0, 8_000)}\n\n团队已完成的结果：\n${input.payload.teamResults.slice(0, 24_000)}\n\n交付物：\n${input.payload.deliverables.join('\n') || '无明确文件交付物'}\n\n请完成知识与经验归集，并判断是否存在值得复用的业务流程。只输出 JSON。`;
  const system = `你是群聊中的知识管理智能体，正在任务完成后进行本地知识沉淀。

请返回严格 JSON，结构如下：
{
  "knowledgeDocument": {
    "title": "知识文档标题",
    "summary": "本次任务形成的知识摘要",
    "reusableInsights": ["可复用结论"],
    "constraints": ["适用约束"],
    "risks": ["风险或待确认项"],
    "recommendedPractices": ["推荐做法"]
  },
  "businessProcess": {
    "applicable": true,
    "reason": "不适用时说明原因",
    "title": "面向业务目标的流程名称",
    "summary": "流程解决什么业务问题",
    "stages": [{
      "id": "stage-1",
      "title": "业务阶段",
      "objective": "该阶段的业务目标",
      "owner": "负责角色或岗位",
      "steps": [{
        "id": "step-1",
        "title": "可执行的业务动作",
        "actionType": "research|acquire|calculate|analyze|synthesize|validate|deliver|other",
        "description": "动作说明和判断逻辑",
        "inputs": ["输入"],
        "outputs": ["输出"],
        "owner": "负责角色或岗位"
      }]
    }]
  }
}

业务流程必须从业务目标出发动态建模。例如经营分析可拆为不同分析维度，每个维度再包含调研、数据获取、计算、分析、汇总、校验和交付，但具体维度与步骤必须依据本次任务成果决定。不要照搬智能体执行轨迹，不要写“思考、等待、调用模型、发送消息”等运行状态，也不要套固定阶段。
如果任务只是问候、简单解释、一次性技术操作或没有可复用业务方法，businessProcess.applicable 设为 false，stages 为空。不要为了展示而硬凑流程。不要输出隐藏思维过程。`;

  let generated = await input.gateway.generateText('fast', [{ role: 'user', content: prompt }], { system });
  let capture: ParsedCapture;
  try {
    capture = parseBusinessProcessResponse(generated.text, input.payload.originalTask);
  } catch {
    try {
      generated = await input.gateway.generateText('fast', [{ role: 'user', content: `${prompt}\n\n上一次输出无法解析。请只返回符合约定结构的 JSON 对象，不要添加代码块或说明。` }], { system });
      capture = parseBusinessProcessResponse(generated.text, input.payload.originalTask);
    } catch {
      capture = {
        process: {
          schemaVersion: 1,
          applicable: false,
          reason: '知识与经验已经归集，但本次没有形成可验证的业务流程模型。',
          title: cleanText(input.payload.originalTask, '本次任务', 160),
          stages: [],
        },
        knowledge: {
          title: `${cleanText(input.payload.originalTask, '本次任务', 80)} - 知识与经验归集`,
          summary: cleanText(input.payload.teamResults, '已归集本次任务中的有效结果。', 2_000),
          reusableInsights: [],
          constraints: [],
          risks: ['业务流程模型生成失败，需要后续人工复核。'],
          recommendedPractices: [],
        },
      };
    }
  }

  const generatedAt = new Date().toISOString();
  const hash = createHash('sha256').update(`${input.runId}:${input.payload.originalTask}`).digest('hex').slice(0, 10);
  const date = generatedAt.slice(0, 10);
  const knowledgeDocumentPath = `knowledge/experience/${date}-${hash}.md`;
  const businessProcess: BusinessProcess = {
    ...capture.process,
    generatedByAgentId: input.agentInstanceId,
    generatedByAgentName: input.agentName,
    generatedAt,
    knowledgeDocumentPath,
  };
  const absolutePath = join(input.projectRoot, ...knowledgeDocumentPath.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, renderKnowledgeDocument(capture, input.payload, businessProcess), 'utf8');

  const responseText = businessProcess.applicable
    ? `本次协作的知识和经验已归集到 \`${knowledgeDocumentPath}\`，并整理出一套可复用的“${businessProcess.title}”业务流程。`
    : `本次协作的知识和经验已归集到 \`${knowledgeDocumentPath}\`。${businessProcess.reason ?? '这次内容不适合抽象为业务流程，因此没有生成流程图。'}`;
  return { businessProcess, knowledgeDocumentPath, responseText };
}
