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
 * - 整条协作链共用根 triggerMessageId，并限制最多 12 个 Run，避免互相 @ 无限扩散
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
  anchorMessageId?: string,
): string[] {
  const createdRunIds: string[] = [];
  let content: { mentions?: Array<{ target: { scope: string; id: string } }> } | null = null;
  try {
    content = JSON.parse(contentJson);
  } catch {
    return createdRunIds; // 非 JSON 内容，忽略
  }

  const mentions = Array.isArray(content?.mentions) ? content.mentions : [];
  const instanceMentions = mentions.filter((mention): mention is { target: { scope: string; id: string } } => (
    !!mention
    && typeof mention === 'object'
    && !!mention.target
    && mention.target.scope === 'instance'
    && typeof mention.target.id === 'string'
    && mention.target.id.length > 0
  ));
  if (instanceMentions.length === 0) return createdRunIds;

  const messageText = extractText(content);
  if (requestedByType === 'agent' && !isActionableAgentHandoff(messageText)) return createdRunIds;

  const routedTargets = new Set<string>();

  for (const mention of instanceMentions) {
    const targetId = mention.target.id;

    // 跳过自触发：被@的是自己
    if (targetId === senderId) continue;
    // 同一条消息多次 @ 同一智能体时只路由一次
    if (routedTargets.has(targetId)) continue;

    // 验证目标智能体是否存在、属于当前项目且处于启用状态
    const instance = db.prepare(
      `SELECT pai.id
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ? AND pai.project_id = ? AND ap.enabled = 1`,
    ).get(targetId, projectId) as { id: string } | undefined;
    if (!instance) continue;

    if (requestedByType === 'agent') {
      // 不允许把同一根任务重新发回祖先智能体，防止“确认收到”式乒乓循环。
      if (senderRunId && runRepo.getAncestorChain(senderRunId).some((run) => run.agentInstanceId === targetId)) continue;
      // 同一根用户任务内，同一“发送者 → 接收者”协作边只自动路由一次。
      // 不同成员仍可在后续阶段把新结果交给该接收者，支持真实的多人接力协作。
      const routedBefore = db.prepare(
        `SELECT COUNT(*) as count FROM agent_runs
         WHERE trigger_message_id = ? AND agent_instance_id = ?
           AND requested_by_type = 'agent' AND requested_by_id = ?`,
      ).get(triggerMessageId, targetId, senderId) as { count: number } | undefined;
      if ((routedBefore?.count ?? 0) > 0) continue;
    }
    routedTargets.add(targetId);

    // 每条触发消息最多产生 12 个 Run，覆盖 MVP 最多 9 个成员并留出必要重试空间。
    if (runRepo.countRunsByTrigger(triggerMessageId) >= 12) break;

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
    runRepo.addEvent(run.id, 'run.anchor', { messageId: anchorMessageId ?? triggerMessageId });
    createdRunIds.push(run.id);

    scheduler.enqueue({
      runId: run.id,
      projectId,
      agentInstanceId: instance.id,
      instruction: extractText(content),
      triggerMessageId,
    });
  }
  return createdRunIds;
}

function extractText(content: Record<string, unknown> | null): string {
  return typeof content?.text === 'string' ? content.text : '';
}

function isActionableAgentHandoff(text: string): boolean {
  const normalized = text.replace(/@[\u4e00-\u9fff\w-]+/g, '').trim();
  if (!normalized) return false;
  const acknowledgementOnly = /^(收到|好的|好|明白|已了解|知悉|确认|谢谢|感谢|辛苦了|等待|已完成|完成了|ok|okay|roger|thanks)[！!。,.，\s]*(?:请知悉|等待下一步|无其他事项)?[！!。,.，\s]*$/i;
  if (acknowledgementOnly.test(normalized)) return false;
  const actionSignal = /(请|需要|负责|完成|处理|检查|验证|分析|编写|生成|修改|实现|调查|检索|汇总|输出|交付|修复|测试|review|implement|build|test|analy[sz]e|create|generate|fix)/i;
  return normalized.length >= 12 && actionSignal.test(normalized);
}
