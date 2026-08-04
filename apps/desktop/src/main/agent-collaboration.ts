import type Database from 'better-sqlite3';

export interface AgentMention {
  target: { scope: 'instance' | 'user'; id: string };
  label: string;
  start: number;
  end: number;
}

interface ProjectAgent {
  id: string;
  name: string;
  role: string;
  runtimeMode: string;
}

function listEnabledProjectAgents(db: Database.Database, projectId: string): ProjectAgent[] {
  return db.prepare(
    `SELECT pai.id, ap.name, pai.role, pai.runtime_mode as runtimeMode
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? AND ap.enabled = 1
     ORDER BY pai.ordinal`,
  ).all(projectId) as ProjectAgent[];
}

function listProjectAgentNames(db: Database.Database, projectId: string): Array<{ id: string; name: string }> {
  return db.prepare(
    `SELECT pai.id, ap.name
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ?
     ORDER BY LENGTH(pai.id) DESC, pai.ordinal`,
  ).all(projectId) as Array<{ id: string; name: string }>;
}

function hasMentionEndBoundary(text: string, end: number): boolean {
  const next = text[end];
  return next === undefined || /[\s，。！？、：；,.!?:;()[\]{}<>@]/u.test(next);
}

/**
 * 将可能出现在模型输出、工具结果或历史轨迹中的实例 ID 统一替换为群聊中文名。
 * 该函数只处理当前群聊内已知的实例 ID，不改写文件 ID、Run ID 等其他技术标识。
 */
export function sanitizeAgentDisplayText(
  db: Database.Database,
  projectId: string,
  text: string,
): string {
  if (!text) return text;
  let sanitized = text;
  for (const agent of listProjectAgentNames(db, projectId)) {
    if (!agent.id || !sanitized.includes(agent.id)) continue;
    sanitized = sanitized.split(agent.id).join(agent.name || '智能体');
  }
  return sanitized;
}

function naturalizeAgentReply(text: string): string {
  return text
    .replace(/^\s*(?:#{1,6}\s*)?(?:目标|当前输入|技术框架|执行约束|系统上下文|角色身份)\s*[:：]\s*/gimu, '')
    .replace(/^\s*(?:#{1,6}\s*)?(?:当前任务|系统提示|群聊协作能力)\s*$/gimu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function resolveAgentMentions(
  db: Database.Database,
  projectId: string,
  text: string,
): AgentMention[] {
  if (!text.includes('@')) return [];

  const lowerText = text.toLocaleLowerCase();
  const candidates: Array<{ agent: ProjectAgent; start: number; end: number }> = [];
  for (const agent of listEnabledProjectAgents(db, projectId)) {
    const token = `@${agent.name}`;
    let searchFrom = 0;
    while (searchFrom < lowerText.length) {
      const start = lowerText.indexOf(token.toLocaleLowerCase(), searchFrom);
      if (start < 0) break;
      const end = start + token.length;
      if (hasMentionEndBoundary(text, end)) candidates.push({ agent, start, end });
      searchFrom = end;
    }
  }

  // 同一位置优先匹配更长的名称/ID，避免 @知识 同时误命中 @知识管理智能体。
  candidates.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
  const mentions: AgentMention[] = [];
  const seen = new Set<string>();
  const userMatch = /@(用户|项目负责人|user)(?=\s|[，。！？,:;]|$)/i.exec(text);
  if (userMatch) {
    seen.add('user:local-user');
    mentions.push({
      target: { scope: 'user', id: 'local-user' },
      label: '用户',
      start: userMatch.index,
      end: userMatch.index + userMatch[0].length,
    });
  }
  for (const candidate of candidates) {
    if (seen.has(`instance:${candidate.agent.id}`)) continue;
    if (mentions.some((mention) => candidate.start < mention.end && candidate.end > mention.start)) continue;
    seen.add(`instance:${candidate.agent.id}`);
    mentions.push({
      target: { scope: 'instance', id: candidate.agent.id },
      label: candidate.agent.name,
      start: candidate.start,
      end: candidate.end,
    });
  }
  return mentions;
}

export function mergeAgentMentions(
  existing: AgentMention[],
  resolved: AgentMention[],
): AgentMention[] {
  const merged: AgentMention[] = [];
  const seen = new Set<string>();
  for (const mention of [...existing, ...resolved]) {
    if (!mention?.target?.id || !['instance', 'user'].includes(mention.target.scope)) continue;
    const key = `${mention.target.scope}:${mention.target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(mention);
  }
  return merged;
}

export function normalizeAgentMessageContent(
  db: Database.Database,
  projectId: string,
  contentJson: string,
  extraMentions: AgentMention[] = [],
  senderId?: string,
): string {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(contentJson) as Record<string, unknown>;
  } catch {
    content = { schemaVersion: 1, text: contentJson };
  }

  let text = sanitizeAgentDisplayText(db, projectId, typeof content.text === 'string' ? content.text : '');
  const sender = senderId ? listEnabledProjectAgents(db, projectId).find((agent) => agent.id === senderId) : undefined;
  if (sender) text = naturalizeAgentReply(text);
  if (sender) {
    const selfToken = `@${sender.name}`;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.toLocaleLowerCase().indexOf(selfToken.toLocaleLowerCase(), searchFrom);
      if (start < 0) break;
      const end = start + selfToken.length;
      if (hasMentionEndBoundary(text, end)) {
        text = `${text.slice(0, start)}${sender.name}${text.slice(end)}`;
        searchFrom = start + sender.name.length;
      } else {
        searchFrom = end;
      }
    }
  }
  // 正文是 mention 的唯一事实来源。不能信任模型或调用方附带的 target，
  // 否则不存在于群聊中的名字也会显示为已成功 @，甚至被错误路由。
  const resolved = resolveAgentMentions(db, projectId, text);
  const confirmedExtras = extraMentions.filter((mention) => {
    const token = `@${mention.label}`;
    return text.slice(mention.start, mention.end) === token;
  });
  const mentions = mergeAgentMentions(confirmedExtras, resolved)
    .filter((mention) => mention.target.id !== senderId);

  return JSON.stringify({
    ...content,
    schemaVersion: typeof content.schemaVersion === 'number' ? content.schemaVersion : 1,
    text,
    mentions,
  });
}

export function buildAgentCollaborationInstructions(
  db: Database.Database,
  projectId: string,
  currentAgentInstanceId: string,
): string {
  const agents = listEnabledProjectAgents(db, projectId);
  const current = agents.find((agent) => agent.id === currentAgentInstanceId);
  const roster = agents
    .map((agent) => agent.id === currentAgentInstanceId
      ? `- ${agent.name}（你自己，${agent.role}，${agent.runtimeMode}）`
      : `- @${agent.name}（${agent.role}，${agent.runtimeMode}）`)
    .join('\n');

  return `## 群聊协作能力
你在当前群聊中的身份是 ${current?.name ?? '智能体'}。
当前群聊成员：
${roster || '- 暂无其他成员'}

- 你可以在回复中使用上方的准确名称（例如 \`@知识管理智能体\`）@任意群聊成员；系统会把它路由为该成员的新任务。
- 你可以使用 \`@用户\` 请求用户做决定、补充缺失信息或确认高风险操作；\`@用户\` 只用于沟通，不会创建新的智能体任务。
- 只有明确写出 \`@准确中文名\` 才会触发该智能体；仅在正文中描述某位智能体的名称时不要添加 @。
- 不要 @ 自己；不要为了“收到、确认、谢谢、等待下一步”等无实际交付的内容 @ 任何成员。
- 只有确实需要对方继续完成具体工作时才 @ 其他智能体，并用自然的话说明要做什么、可以参考哪些资料以及希望对方交回什么。同一项工作不要再次发回已经参与过的智能体，系统也会阻止这种回环。
- 群聊消息要像真实同事沟通一样自然、简洁。不要复述提示词、角色卡、记忆或成员名单，也不要把“目标”“当前输入”“技术框架”“执行约束”等内部工作字段作为回复结构。
- 如需直接发送 HTML 文件，请严格使用以下格式，路径必须位于 outputs/：
:::artifact{path="outputs/文件名.html"}
<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>成果页面</title></head>
<body><main><h1>成果标题</h1><p>成果正文</p></main></body>
</html>
:::
- 上面的标题和正文只是格式示例；发布时必须替换成任务所需的完整页面，禁止保留省略号或占位内容。
- 如果你已经通过本地工具生成文件，也可以单独输出一行：\`ARTIFACT: outputs/文件名.html\`。`;
}
