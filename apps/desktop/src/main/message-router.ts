import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import type { Scheduler } from './scheduler';
import { buildModelProfileSnapshot } from './project-creator';

/**
 * 处理消息中的 @mention，为目标智能体创建 Run 并调度执行。
 *
 * 此函数是事件驱动消息总线的核心路由逻辑：
 * - 消息写入 messages 表后调用此函数
 * - 解析消息中的 @mentions（scope: 'instance'）
 * - 为每个被提及的智能体创建 Run 并加入调度器
 * - 自动跳过信息发送者自身（防止自触发）
 * - 防循环委派由 delegate_tasks 工具的安全检查（深度限制、循环检测、Run数量上限）负责
 */
export function processMessageMentions(
  db: Database.Database,
  runRepo: AgentRunRepository,
  scheduler: Scheduler,
  projectId: string,
  contentJson: string,
  triggerMessageId: string,
  senderId: string,
  senderRunId?: string,
  requestedByType: 'user' | 'agent' = 'agent',
): void {
  let content: { mentions?: Array<{ target: { scope: string; id: string } }> } | null = null;
  try {
    content = JSON.parse(contentJson);
  } catch {
    return; // 非 JSON 内容，忽略
  }

  const mentions = content?.mentions ?? [];
  const instanceMentions = mentions.filter((m) => m.target.scope === 'instance');
  if (instanceMentions.length === 0) return;

  for (const mention of instanceMentions) {
    const targetId = mention.target.id;

    // 跳过自触发：被@的是自己
    if (targetId === senderId) continue;

    // 验证目标智能体是否存在且属于当前项目
    const instance = db.prepare(
      `SELECT id FROM project_agent_instances WHERE id = ? AND project_id = ?`,
    ).get(targetId, projectId) as { id: string } | undefined;
    if (!instance) continue;

    // 创建 Run 并调度（senderRunId 作为 parentRunId，用于链式上下文追踪）
    const createInput: {
      projectId: string; agentInstanceId: string; requestedByType: string; requestedById: string;
      instruction: string; parentRunId?: string; triggerMessageId: string; modelProfileSnapshotJson: string | null;
    } = {
      projectId,
      agentInstanceId: instance.id,
      requestedByType,
      requestedById: senderId,
      instruction: extractText(content),
      triggerMessageId,
      modelProfileSnapshotJson: buildModelProfileSnapshot(db, instance.id),
    };
    if (senderRunId) {
      createInput.parentRunId = senderRunId;
    }
    const run = runRepo.create(createInput);

    scheduler.enqueue({
      runId: run.id,
      projectId,
      agentInstanceId: instance.id,
      instruction: extractText(content),
      triggerMessageId,
    });
  }
}

function extractText(content: Record<string, unknown> | null): string {
  return typeof content?.text === 'string' ? content.text : '';
}