import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import type { Scheduler } from './scheduler';
import { buildModelProfileSnapshot } from './project-creator';
import { isAllowedAgentHandoff, sanitizeAgentDisplayText } from './agent-collaboration';
import { resolveCollaborationMode } from './collaboration-mode';
import { instructionsAreEquivalent, stripMentionTokens } from './text-similarity';

export { normalizeInstructionText as normalizeRoutedInstruction } from './text-similarity';

/** 根任务 Run 上限：一个复杂任务可能跨多个宏观阶段并经历返修，上限只防无限扩散。 */
export const ROOT_TASK_RUN_LIMIT = 64;

/**
 * 判断用户消息是否为「仅记录不触发」消息（P2-18）。
 * 以 /note 开头（后跟空白或独占一行）的消息只落库为群聊记录：
 * 不进入会话记忆指令提取，不触发任何智能体 run（含等待用户回复的 run 恢复），
 * 后续任务的群聊上下文中仍可引用该内容。
 */
export function isNoteOnlyMessage(text: string | undefined | null): boolean {
  if (!text) return false;
  return /^\/note(\s|$)/.test(text.trim());
}

/** 路由层写入的系统通知消息（如 Run 上限），调用方可据此向窗口广播 message.committed。 */
export interface SystemNotice {
  messageId: string;
  projectId: string;
  contentJson: string;
}

/**
 * 处理消息中的 @mention，为目标智能体创建 Run 并调度执行。
 *
 * 此函数是事件驱动消息总线的核心路由逻辑：
 * - 消息写入 messages 表后调用此函数
 * - 解析消息中的 @mentions（scope: 'instance'）
 * - 为每个被提及的智能体创建 Run 并加入调度器
 * - 自动跳过信息发送者自身（防止自触发）
 * - 整条协作链共用根 triggerMessageId，并限制最多 64 个 Run，允许阶段内重试同时避免无限扩散
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
  onSystemNotice?: (notice: SystemNotice) => void,
): string[] {
  const createdRunIds: string[] = [];
  let content: { mentions?: Array<{ target: { scope: string; id: string } }>; messageType?: unknown } | null = null;
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
  if (requestedByType === 'agent' && !isActionableAgentHandoff(messageText, content?.messageType)) return createdRunIds;

  const routedTargets = new Set<string>();

  for (const mention of instanceMentions) {
    const targetId = mention.target.id;

    // 跳过自触发：被@的是自己
    if (targetId === senderId) continue;
    // 同一条消息多次 @ 同一智能体时只路由一次
    if (routedTargets.has(targetId)) continue;

    // 验证目标智能体是否存在、属于当前项目且处于启用状态
    const instance = db.prepare(
      `SELECT pai.id, ap.definition_id as definitionId
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ? AND pai.project_id = ? AND ap.enabled = 1`,
    ).get(targetId, projectId) as { id: string; definitionId: string } | undefined;
    if (!instance) continue;

    if (instance.definitionId === 'builtin.acceptance-reviewer') {
      const budget = getAcceptanceReviewBudget(db, triggerMessageId);
      if (!budget.allowed) {
        if (senderRunId) {
          try {
            runRepo.addEvent(senderRunId, 'run.review-budget-blocked', {
              collaborationMode: budget.mode,
              reviewLimit: budget.limit,
              existingReviewRuns: budget.used,
              targetAgentInstanceId: targetId,
            });
          } catch { /* parent Run may already be terminal */ }
        }
        continue;
      }
    }

    // 只有统筹负责人可以发起全局委派；专业智能体的 @ 必须是当前工作确实需要的具体依赖。
    // 这里再做一次服务端校验，避免模型输出了 @ 后绕过正文规范直接创建子任务。
    const isParentDelivery = requestedByType === 'agent' && senderRunId
      ? (() => {
        try {
          const senderRun = runRepo.getById(senderRunId);
          return senderRun.parentRunId === targetId
            || (senderRun.parentRunId ? runRepo.getById(senderRun.parentRunId).agentInstanceId === targetId : false);
        } catch {
          return false;
        }
      })()
      : false;
    if (requestedByType === 'agent' && !isParentDelivery && !isAllowedAgentHandoff(db, projectId, senderId, targetId, messageText)) continue;

    if (requestedByType === 'agent') {
      // 不允许把同一根任务重新发回祖先智能体，防止“确认收到”式乒乓循环。
      if (senderRunId && runRepo.getAncestorChain(senderRunId).some((run) => run.agentInstanceId === targetId)) continue;
      // 同一个成员可以在一条根任务中承担多个连续阶段，例如初稿、返修和复审。
      // 这里只拦截内容等价的重复委派，避免模型重复发出同一消息时创建重复 Run。
      const previousRoutes = db.prepare(
        `SELECT id, instruction, status FROM agent_runs
         WHERE trigger_message_id = ? AND agent_instance_id = ?
           AND requested_by_type = 'agent' AND requested_by_id = ?
         ORDER BY created_at DESC`,
      ).all(triggerMessageId, targetId, senderId) as Array<{ id: string; instruction: string | null; status: string }>;
      const equivalentRunId = findEquivalentRoutedRun(previousRoutes, messageText);
      if (equivalentRunId) {
        routedTargets.add(targetId);
        createdRunIds.push(equivalentRunId);
        continue;
      }
    }
    routedTargets.add(targetId);

    // 达到根任务 Run 上限时不再静默丢弃：写入系统消息通知用户，并通过回调
    // 让调用方向窗口广播 message.committed，避免「委派无响应」的不可见失败。
    if (runRepo.countRunsByTrigger(triggerMessageId) >= ROOT_TASK_RUN_LIMIT) {
      const notice = insertSystemMessage(
        db,
        projectId,
        `该任务链的智能体执行次数已达上限（${ROOT_TASK_RUN_LIMIT} 次），新的委派请求未派发。请让负责成员直接交付当前结果，或开启新会话继续。`,
      );
      if (senderRunId) {
        try {
          runRepo.addEvent(senderRunId, 'run.limit-reached', {
            triggerMessageId,
            systemMessageId: notice.messageId,
            blockedTargetInstanceId: targetId,
          });
        } catch { /* parent Run may already be terminal */ }
      }
      onSystemNotice?.({ ...notice, projectId });
      break;
    }

    // 创建 Run 并调度（senderRunId 作为 parentRunId，用于链式上下文追踪）
    const createInput: {
      projectId: string; agentInstanceId: string; requestedByType: string; requestedById: string;
      instruction: string; parentRunId?: string; triggerMessageId: string; modelProfileSnapshotJson: string | null;
    } = {
      projectId,
      agentInstanceId: instance.id,
      requestedByType,
      requestedById: senderId,
      instruction: messageText,
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
      instruction: messageText,
      triggerMessageId,
    });
  }
  return createdRunIds;
}

export function getAcceptanceReviewBudget(
  db: Database.Database,
  triggerMessageId: string,
): { mode: 'fast' | 'balanced' | 'expert'; limit: number; used: number; allowed: boolean } {
  const mode = resolveCollaborationMode(db, triggerMessageId);
  const limit = mode === 'fast' ? 0 : mode === 'balanced' ? 1 : Number.POSITIVE_INFINITY;
  const used = limit === Number.POSITIVE_INFINITY ? 0 : countReviewRunsByTrigger(db, triggerMessageId);
  return { mode, limit, used, allowed: used < limit };
}

function countReviewRunsByTrigger(db: Database.Database, triggerMessageId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count
     FROM agent_runs ar
     JOIN project_agent_instances pai ON pai.id = ar.agent_instance_id
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE ar.trigger_message_id = ? AND ap.definition_id = 'builtin.acceptance-reviewer'`,
  ).get(triggerMessageId) as { count: number } | undefined;
  return row?.count ?? 0;
}

function extractText(content: Record<string, unknown> | null): string {
  return typeof content?.text === 'string' ? content.text : '';
}

/** 写入一条系统消息（senderType/kind 均为 system），供 UI 在消息列表中直接展示。 */
function insertSystemMessage(
  db: Database.Database,
  projectId: string,
  text: string,
): { messageId: string; contentJson: string } {
  const messageId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
  const contentJson = JSON.stringify({ schemaVersion: 1, text });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
     VALUES (?, ?, 'system', 'system', 'system', ?, 'sent', ?, ?)`,
  ).run(messageId, projectId, contentJson, now, now);
  return { messageId, contentJson };
}

/**
 * 将 Run 失败提示持久化为群聊系统消息（P2-17）。
 * 消息 ID 由 runId 派生：执行器分支与调度器兜底路径重复调用也只落一条；
 * 测试库缺少 messages / 实例表时静默跳过，返回 inserted: false。
 */
export function insertRunFailureNotice(
  db: Database.Database,
  projectId: string,
  runId: string,
  reason: string,
): { messageId: string; contentJson: string; inserted: boolean } {
  try {
    let agentName = '';
    try {
      const row = db.prepare(
        `SELECT ap.name as agentName
         FROM agent_runs ar
         JOIN project_agent_instances pai ON pai.id = ar.agent_instance_id
         JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
         WHERE ar.id = ?`,
      ).get(runId) as { agentName: string } | undefined;
      agentName = row?.agentName ?? '';
    } catch { /* 测试库可能缺少实例表 */ }
    const text = sanitizeAgentDisplayText(
      db, projectId,
      `${agentName || '智能体'} 的任务执行失败${reason ? `：${reason}` : ''}。可重新发起，或调整指令后再试。`,
    );
    // ID 采用渲染端可同步复算的确定性规则（run-fail-<runId>）：
    // ChatPage 在收到 run.status failed 时若尚未收到持久化广播，会用同一 ID
    // 创建内存态兜底消息，两条路径天然去重，不会双条显示。
    const messageId = `run-fail-${runId}`;
    const contentJson = JSON.stringify({ schemaVersion: 1, text });
    const now = new Date().toISOString();
    const result = db.prepare(
      `INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'system', 'system', ?, 'sent', ?, ?)`,
    ).run(messageId, projectId, contentJson, now, now);
    return { messageId, contentJson, inserted: result.changes > 0 };
  } catch {
    return { messageId: '', contentJson: '', inserted: false };
  }
}

function findEquivalentRoutedRun(
  previousRoutes: Array<{ id: string; instruction: string | null; status: string }>,
  nextInstruction: string,
): string | null {
  return previousRoutes.find((route) => {
    // An equivalent active request is already queued/running. Exact repeats of a
    // terminal request are also ignored; materially different follow-up work is allowed.
    return ['queued', 'starting', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted']
      .includes(route.status)
      && instructionsAreEquivalent(route.instruction ?? '', nextInstruction);
  })?.id ?? null;
}

/**
 * 判断一条智能体消息是否携带可路由的委派意图。
 *
 * 采用黑名单制：结构化委派（messageType === 'delegation'）直接放行；
 * 纯确认/寒暄与「可选追问」不路由；其余请求（包括英文或其他表达方式的
 * 真实委派）默认可路由，避免旧白名单正则静默丢弃非中文句式的委派。
 */
function isActionableAgentHandoff(text: string, messageType?: unknown): boolean {
  if (messageType === 'delegation') return true;
  const normalized = stripMentionTokens(text).trim();
  if (!normalized) return false;
  // 致谢/确认词可自由组合（如「收到，谢谢。」「好的，明白，辛苦了」），仅由标点与空白分隔时整体视为纯确认。
  const ackWord = '(?:收到|好的|好|明白|已了解|知悉|确认|谢谢|感谢|辛苦了|等待|已完成|完成了|ok|okay|roger|thanks|got\\s*it|done|请知悉|等待下一步|无其他事项)';
  const acknowledgementOnly = new RegExp(`^${ackWord}(?:[！!。,.，\\s]*${ackWord})*[！!。,.，\\s]*$`, 'i');
  if (acknowledgementOnly.test(normalized)) return false;
  const optionalFollowUp = /(?:需要我|是否(?:还)?需要我|要不要我|还要我|如需我|若需我|如果需要我|shall\s+i|should\s+i|do\s+you\s+want\s+me\s+to|want\s+me\s+to|let\s+me\s+know\s+if|if\s+you\s+(?:need|want)\s+me\s+to).{0,160}(?:吗|[？?]|告诉我|说一声|即可|就行|直接说)[。！!\s]*$/iu;
  if (optionalFollowUp.test(normalized)) return false;
  return true;
}
