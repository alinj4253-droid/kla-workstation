import type Database from 'better-sqlite3';

export type TaskMessageRelation = 'current' | 'chain' | 'history';

export interface TaskContextMessageRow {
  id: string;
  senderType: string;
  senderId: string;
  contentJson: string;
  replyToId: string | null;
  createdAt: string;
  taskRelation: TaskMessageRelation;
}

const HISTORY_REFERENCE_RE = /(上面|上述|前面|之前|刚才|这个|这些|这份|该内容|按此|基于此|把它|继续|接着|然后|另外|顺便|补充一下|再补充|发出来|发给我|直接发|发出文件|发个文件|把文件发|文件给我|导出(?:一下|出来)?|整理成文件|梳理成文件|整理成文档|梳理成文档|做了什么|进展|状态|情况|改成|换成|转成|转换|换个|调整成|变(?:成|为)|重新(?:生成|输出|做|写|整理)|再来(?:一份|一个|一版)|再(?:生成|输出|做|写)一?份?|上一[份轮条版稿]|前一[份轮条版稿]|那份|这份报告|格式)|^(?:那|那么)(?:帮我|请|就|再)/iu;

function messageText(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : contentJson;
  } catch {
    return contentJson;
  }
}

export function needsTaskHistory(contentJson: string): boolean {
  const text = messageText(contentJson).replace(/\s+/g, ' ').trim();
  return Boolean(text && text.length <= 240 && HISTORY_REFERENCE_RE.test(text));
}

function parseAnchorMessageId(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { messageId?: unknown };
    return typeof parsed.messageId === 'string' && parsed.messageId ? parsed.messageId : null;
  } catch {
    return null;
  }
}

/**
 * Returns only messages belonging to one root task. A small amount of earlier
 * conversation is always added as background: explicit follow-ups get a larger
 * window, ordinary requests get a minimal recent window so implicit follow-ups
 * (e.g. "我要html的报告") still see the previous request and its result.
 * History rows are marked so the execution prompt can treat them as context,
 * not as commands to re-execute.
 *
 * `overflow` carries the earlier chain messages that were cut off by the
 * message limit; callers use them to build a rolling summary instead of
 * silently dropping them.
 */
export function selectTaskContext(
  db: Database.Database,
  projectId: string,
  triggerMessageId: string,
  options: { limit?: number; historyUserLimit?: number; historyAgentLimit?: number; fallbackUserLimit?: number; fallbackAgentLimit?: number } = {},
): { messages: TaskContextMessageRow[]; overflow: TaskContextMessageRow[] } {
  const limit = Math.max(1, options.limit ?? 12);
  const trigger = db.prepare(
    `SELECT id, sender_type as senderType, sender_id as senderId, content_json as contentJson,
            reply_to_id as replyToId, created_at as createdAt
     FROM messages WHERE id = ? AND project_id = ?`,
  ).get(triggerMessageId, projectId) as Omit<TaskContextMessageRow, 'taskRelation'> | undefined;
  if (!trigger) return { messages: [], overflow: [] };

  const chainIds = new Set<string>([triggerMessageId]);
  const runs = db.prepare(
    `SELECT id, result_message_id as resultMessageId
     FROM agent_runs WHERE project_id = ? AND trigger_message_id = ?`,
  ).all(projectId, triggerMessageId) as Array<{ id: string; resultMessageId: string | null }>;
  for (const run of runs) {
    if (run.resultMessageId) chainIds.add(run.resultMessageId);
  }

  if (runs.length > 0) {
    const placeholders = runs.map(() => '?').join(',');
    const anchors = db.prepare(
      `SELECT payload_json as payloadJson FROM agent_run_events
       WHERE type = 'run.anchor' AND run_id IN (${placeholders})`,
    ).all(...runs.map((run) => run.id)) as Array<{ payloadJson: string | null }>;
    for (const anchor of anchors) {
      const messageId = parseAnchorMessageId(anchor.payloadJson);
      if (messageId) chainIds.add(messageId);
    }
  }

  // Replies to a message in the chain are part of the same task even if a
  // continuation Run has not yet persisted its anchor event.
  for (let pass = 0; pass < 3; pass += 1) {
    const ids = [...chainIds];
    const placeholders = ids.map(() => '?').join(',');
    const replies = db.prepare(
      `SELECT id, reply_to_id as replyToId FROM messages
       WHERE project_id = ? AND reply_to_id IN (${placeholders})`,
    ).all(projectId, ...ids) as Array<{ id: string; replyToId: string | null }>;
    let changed = false;
    for (const reply of replies) {
      if (!chainIds.has(reply.id)) {
        chainIds.add(reply.id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const chainPlaceholders = [...chainIds].map(() => '?').join(',');
  const chain = db.prepare(
    `SELECT id, sender_type as senderType, sender_id as senderId, content_json as contentJson,
            reply_to_id as replyToId, created_at as createdAt
     FROM messages WHERE project_id = ? AND id IN (${chainPlaceholders})
     ORDER BY created_at ASC, rowid ASC`,
  ).all(projectId, ...chainIds) as Array<Omit<TaskContextMessageRow, 'taskRelation'>>;
  const overflow = chain.slice(0, -limit).map((row) => ({ ...row, taskRelation: 'history' as const }));
  const selected = chain.slice(-limit).map((row) => ({
    ...row,
    taskRelation: row.id === triggerMessageId ? 'current' as const : 'chain' as const,
  }));

  // 显式指代（"把上面的内容整理成文件"）取完整历史窗口；普通新请求也附加
  // 少量最近对话作为背景兜底——隐式指代（如"我要html的报告"）不命中显式
  // 指代词，但被委派方仍需知道最近的用户请求与成果，否则会脱离上下文执行。
  const wantsFullHistory = needsTaskHistory(trigger.contentJson);
  const userLimit = wantsFullHistory
    ? (options.historyUserLimit ?? 8)
    : (options.fallbackUserLimit ?? 2);
  const agentLimit = wantsFullHistory
    ? (options.historyAgentLimit ?? 4)
    : (options.fallbackAgentLimit ?? 2);
  const historyRows = db.prepare(
    `SELECT id, sender_type as senderType, sender_id as senderId, content_json as contentJson,
            reply_to_id as replyToId, created_at as createdAt
     FROM messages
     WHERE project_id = ? AND created_at < ? AND id NOT IN (${chainPlaceholders})
       AND kind IN ('text', 'artifact')
     ORDER BY created_at DESC, rowid DESC LIMIT 80`,
  ).all(projectId, trigger.createdAt, ...chainIds) as Array<Omit<TaskContextMessageRow, 'taskRelation'>>;
  let users = 0;
  let agents = 0;
  const history = historyRows.filter((row) => {
    if (row.senderType === 'user' && users < userLimit) {
      users += 1;
      return true;
    }
    if (row.senderType !== 'user' && agents < agentLimit) {
      agents += 1;
      return true;
    }
    return false;
  }).reverse().map((row) => ({ ...row, taskRelation: 'history' as const }));
  return { messages: [...history, ...selected], overflow };
}

/** 兼容旧调用方：仅返回消息数组。 */
export function selectTaskContextMessages(
  db: Database.Database,
  projectId: string,
  triggerMessageId: string,
  options: { limit?: number; historyUserLimit?: number; historyAgentLimit?: number; fallbackUserLimit?: number; fallbackAgentLimit?: number } = {},
): TaskContextMessageRow[] {
  return selectTaskContext(db, projectId, triggerMessageId, options).messages;
}
