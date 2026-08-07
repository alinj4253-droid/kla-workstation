import { randomUUID } from 'node:crypto';
import type { KnowledgeSyncResult } from './knowledge-sync';

export const KNOWLEDGE_FILE_PROCESSING_SKILL_ID = 'process-knowledge-files';
export const KNOWLEDGE_RETRIEVAL_SKILL_ID = 'retrieve-knowledge';

const KNOWLEDGE_SKILL_NAMES: Record<string, string> = {
  [KNOWLEDGE_FILE_PROCESSING_SKILL_ID]: '知识文件处理',
  [KNOWLEDGE_RETRIEVAL_SKILL_ID]: '混合知识检索',
};

export type KnowledgeSkillActivity = {
  id: string;
  skillId: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  detail: string;
};

type RunSkillReader = {
  loadForRun(runId: string, skillId: string, skillVersion?: string): string | null;
};

type ActivityReporter = (activity: KnowledgeSkillActivity) => void;

type SkillHandle = {
  id: string;
  skillId: string;
  name: string;
  instructions: string;
};

function loadRequiredSkill(registry: RunSkillReader, runId: string, skillId: string): SkillHandle {
  const instructions = registry.loadForRun(runId, skillId);
  if (!instructions) {
    throw new Error(`当前知识智能体未绑定技能 ${skillId}`);
  }
  return {
    id: randomUUID().toLowerCase().replace(/-/g, '').slice(0, 16),
    skillId,
    name: KNOWLEDGE_SKILL_NAMES[skillId] ?? skillId,
    instructions,
  };
}

function reportActivity(
  report: ActivityReporter,
  skill: SkillHandle,
  status: KnowledgeSkillActivity['status'],
  detail: string,
): void {
  report({ id: skill.id, skillId: skill.skillId, name: skill.name, status, detail });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeKnowledgeFileProcessingSkill<T>(input: {
  registry: RunSkillReader;
  runId: string;
  report: ActivityReporter;
  execute: (instructions: string) => Promise<T>;
}): Promise<T> {
  const skill = loadRequiredSkill(input.registry, input.runId, KNOWLEDGE_FILE_PROCESSING_SKILL_ID);
  reportActivity(input.report, skill, 'running', '正在解析原始文件并更新本地知识资产');
  try {
    const result = await input.execute(skill.instructions);
    reportActivity(input.report, skill, 'completed', '原始文件的知识处理已经完成');
    return result;
  } catch (error) {
    reportActivity(input.report, skill, 'failed', `知识文件处理失败：${errorText(error)}`);
    throw error;
  }
}

export async function executeKnowledgeRetrievalSkills<T>(input: {
  registry: RunSkillReader;
  runId: string;
  report: ActivityReporter;
  synchronize: (onChangesDetected: (change: KnowledgeSyncResult) => void) => Promise<KnowledgeSyncResult>;
  retrieve: (instructions: string) => Promise<T> | T;
}): Promise<T> {
  const retrievalSkill = loadRequiredSkill(input.registry, input.runId, KNOWLEDGE_RETRIEVAL_SKILL_ID);
  // Resolve the processing skill only when the synchronization callback reports a change.
  // An unchanged, already-indexed workspace should not fail retrieval because an older
  // Run snapshot predates the processing skill package.
  let processingSkill: SkillHandle | null = null;
  let processingStarted = false;
  let processingFinalized = false;

  try {
    const syncResult = await input.synchronize((change) => {
      if (processingStarted || (change.changedFileIds.length === 0 && change.deletedFileIds.length === 0)) return;
      processingStarted = true;
      processingSkill = loadRequiredSkill(input.registry, input.runId, KNOWLEDGE_FILE_PROCESSING_SKILL_ID);
      reportActivity(input.report, processingSkill, 'running', '检测到原始文件变化，正在增量更新知识资产');
    });

    if (processingStarted) {
      const processed = syncResult.changedFileIds.length;
      const removed = syncResult.deletedFileIds.length;
      const failed = syncResult.failedFileIds.length;
      const detail = [
        processed > 0 ? `处理 ${processed} 个文件` : '',
        removed > 0 ? `停用 ${removed} 个已移出来源` : '',
        failed > 0 ? `${failed} 个文件等待重试` : '',
      ].filter(Boolean).join('，');
      if (processingSkill) {
        reportActivity(input.report, processingSkill, failed > 0 ? 'failed' : 'completed', detail || '知识资产已同步');
        processingFinalized = true;
      }
    }

    reportActivity(input.report, retrievalSkill, 'running', '正在检索、去重并综合本地知识证据');
    const result = await input.retrieve(retrievalSkill.instructions);
    reportActivity(input.report, retrievalSkill, 'completed', '已完成混合检索并形成带来源的综合回答');
    return result;
  } catch (error) {
    if (processingStarted && processingSkill && !processingFinalized) {
      reportActivity(input.report, processingSkill, 'failed', `知识文件处理失败：${errorText(error)}`);
    }
    reportActivity(input.report, retrievalSkill, 'failed', `知识检索失败：${errorText(error)}`);
    throw error;
  }
}
