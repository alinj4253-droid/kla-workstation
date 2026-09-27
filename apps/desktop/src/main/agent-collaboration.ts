import type Database from 'better-sqlite3';
import { sanitizeUserFacingResponse } from '@kunqing/native-agent-core';
import { resolveSpecialistChatPolicy } from './collaboration-policy';
import { canonicalVisibleMessage, extractMessageText, questionsAreEquivalent } from './text-similarity';

export interface AgentMention {
  target: { scope: 'instance' | 'user'; id: string };
  label: string;
  start: number;
  end: number;
}

export type AgentMessageAudience =
  | { scope: 'user' }
  | { scope: 'instance'; id: string }
  | { scope: 'parent'; id: string; includeUser?: boolean }
  | { scope: 'broadcast' };

interface ProjectAgent {
  id: string;
  name: string;
  role: string;
  runtimeMode: string;
  definitionId: string;
}

/**
 * 一次消息归一化/路由请求内复用的项目上下文快照。
 *
 * listEnabledProjectAgents、listProjectAgentNames 与 getLocalUserProfile 都是
 * 同步 SQL；同一条消息的处理链路会反复需要这三份数据，请求级缓存可将
 * 每条消息的重复查询收敛为一次，避免执行期间状态漂移与多余的主进程 IO。
 */
export interface ProjectContextSnapshot {
  agents: ProjectAgent[];
  agentNames: Array<{ id: string; name: string }>;
  profile: LocalUserProfile;
}

export function loadProjectContext(db: Database.Database, projectId: string): ProjectContextSnapshot {
  return {
    agents: listEnabledProjectAgents(db, projectId),
    agentNames: listProjectAgentNames(db, projectId),
    profile: getLocalUserProfile(db),
  };
}

export interface LocalUserProfile {
  nickname: string;
  avatarDataUrl: string;
}

export function getLocalUserProfile(db: Database.Database): LocalUserProfile {
  const readSetting = (key: string): unknown => {
    try {
      const row = db.prepare('SELECT value_json as valueJson FROM settings WHERE key = ?').get(key) as { valueJson: string } | undefined;
      return row ? (JSON.parse(row.valueJson) as { value?: unknown }).value : undefined;
    } catch {
      return undefined;
    }
  };
  const nickname = String(readSetting('personalNickname') ?? '').trim().slice(0, 24) || '项目负责人';
  const avatarDataUrl = String(readSetting('personalAvatarDataUrl') ?? '').trim();
  return { nickname, avatarDataUrl };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function messageRequestsUserResponse(contentJson: string): boolean {
  try {
    const content = JSON.parse(contentJson) as {
      text?: unknown;
      requiresUserResponse?: unknown;
      mentions?: Array<{ target?: { scope?: string; id?: string } }>;
    };
    const mentionsUser = Array.isArray(content.mentions)
      && content.mentions.some((mention) => mention.target?.scope === 'user' && mention.target.id === 'local-user');
    if (!mentionsUser) return false;
    if (typeof content.requiresUserResponse === 'boolean') return content.requiresUserResponse;

    const text = typeof content.text === 'string' ? content.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return false;

    // External agents may not emit structured intent metadata. Keep their fallback
    // conservative: greetings, delivery notices and optional follow-ups must finish.
    const optionalFollowUp = /(?:如需|若需|如果(?:你)?需要|需要我|是否(?:还)?需要我|要不要我|还要我).{0,120}(?:继续|补充|处理|整理|再做|告诉我|说一声|直接说|即可|就行|吗|[？?])/iu;
    const notificationOnly = /(?:请查收|请知悉|供你参考|随时告诉我|有新任务.{0,16}(?:直接说|告诉我)|我在[的，,\s]*$)/iu;
    if (optionalFollowUp.test(text) || notificationOnly.test(text)) return false;

    const blockingRequest = /(?:请(?:你)?|麻烦(?:你)?|烦请(?:你)?|需要你|能否请你).{0,32}(?:补充|提供|确认|选择|决定|授权|上传|回复|回答|填写|告知|处理|操作)/iu;
    const blockedWithoutInput = /(?:缺少|尚缺|还差|尚未获得|否则|不然).{0,48}(?:无法|不能|没法|需要你|请).{0,32}(?:继续|执行|完成|查询|处理|补充|提供|确认|选择|回复)/iu;
    return blockingRequest.test(text) || blockedWithoutInput.test(text);
  } catch {
    return false;
  }
}

export function findDuplicateAwaitingUserMessage(
  db: Database.Database,
  projectId: string,
  triggerMessageId: string,
  contentJson: string,
  currentRunId?: string,
): string | null {
  const question = extractMessageText(contentJson);
  const rows = db.prepare(
    `SELECT ar.id as runId, ar.result_message_id as messageId, m.content_json as contentJson
     FROM agent_runs ar
     JOIN messages m ON m.id = ar.result_message_id
     WHERE ar.project_id = ? AND ar.trigger_message_id = ? AND ar.status = 'awaiting_user'
       AND (? IS NULL OR ar.id != ?)
     ORDER BY ar.created_at DESC`,
  ).all(projectId, triggerMessageId, currentRunId ?? null, currentRunId ?? null) as Array<{ runId: string; messageId: string; contentJson: string }>;
  for (const row of rows) {
    if (questionsAreEquivalent(question, extractMessageText(row.contentJson))) return row.messageId;
  }
  return null;
}

/** Root-task scoped semantic idempotency for final agent messages. */
export function findEquivalentAgentTaskMessage(
  db: Database.Database,
  input: {
    projectId: string;
    triggerMessageId: string;
    senderId: string;
    kind: string;
    contentJson: string;
    excludeRunId?: string;
  },
): string | null {
  const expected = canonicalVisibleMessage(input.contentJson);
  if (!expected) return null;
  const rows = db.prepare(
    `SELECT DISTINCT m.id, m.content_json as contentJson
     FROM agent_runs ar
     JOIN messages m ON m.id = ar.result_message_id
     WHERE ar.project_id = ? AND ar.trigger_message_id = ?
       AND m.sender_type = 'agent' AND m.sender_id = ? AND m.kind = ?
       AND (? IS NULL OR ar.id != ?)
     ORDER BY ar.created_at DESC`,
  ).all(
    input.projectId,
    input.triggerMessageId,
    input.senderId,
    input.kind,
    input.excludeRunId ?? null,
    input.excludeRunId ?? null,
  ) as Array<{ id: string; contentJson: string }>;
  return rows.find((row) => canonicalVisibleMessage(row.contentJson) === expected)?.id ?? null;
}

function listEnabledProjectAgents(db: Database.Database, projectId: string): ProjectAgent[] {
  return db.prepare(
    `SELECT pai.id, ap.name, pai.role, pai.runtime_mode as runtimeMode,
            ap.definition_id as definitionId
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? AND ap.enabled = 1
     ORDER BY pai.ordinal`,
  ).all(projectId) as ProjectAgent[];
}

function isLeaderAgent(agent: ProjectAgent | undefined): boolean {
  return Boolean(agent && (agent.role === 'leader' || agent.definitionId === 'builtin.orchestrator'));
}

function hasConcreteDependency(text: string): boolean {
  const body = text.replace(/@[\u4e00-\u9fff\w-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!body) return false;
  return /(依赖|需要.+(?:提供|完成|确认|补充|查|搜|检索|调研)|请.+(?:查|搜|检索|调研|核对|核实|提供|补充|生成|整理|提取|执行)|帮我(?:查|找|搜|检索|调研|核对|核实|提供|补充|生成|整理|提取|执行)|才能继续|之后我(?:再|将|会)|交回|返回.+(?:结果|文件|数据))/iu.test(body);
}

function isForbiddenSpecialistHandoff(sender: ProjectAgent | undefined, target: ProjectAgent | undefined, text: string): boolean {
  if (!sender || !target || isLeaderAgent(sender)) return false;
  // 资料调研智能体负责获取和分析资料，不负责把结果再转成知识归档任务。
  if (sender.definitionId === 'builtin.researcher' && target.definitionId === 'builtin.knowledge-manager') return true;
  // 专业智能体只能提出阻塞当前工作的具体依赖，不能自行编排全局流程。
  if (!hasConcreteDependency(text)) return true;
  return /(归集|沉淀|复盘|知识文档|业务流程|长期记忆|记忆入库|知识入库|验收|汇总交付)/iu.test(text);
}

export function isAllowedAgentHandoff(
  db: Database.Database,
  projectId: string,
  senderId: string,
  targetId: string,
  text: string,
  snapshot?: ProjectContextSnapshot,
): boolean {
  const agents = snapshot?.agents ?? listEnabledProjectAgents(db, projectId);
  const sender = agents.find((agent) => agent.id === senderId);
  const target = agents.find((agent) => agent.id === targetId);
  // 用户消息不受专业智能体之间的委派边界限制。
  if (!sender) return senderId === 'local-user' || senderId === '';
  return Boolean(target && !isForbiddenSpecialistHandoff(sender, target, text));
}

function listProjectAgentNames(db: Database.Database, projectId: string): Array<{ id: string; name: string }> {
  return db.prepare(
    `SELECT pai.id, ap.name
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? AND ap.enabled = 1
     ORDER BY LENGTH(pai.id) DESC, pai.ordinal`,
  ).all(projectId) as Array<{ id: string; name: string }>;
}

function hasMentionEndBoundary(text: string, end: number): boolean {
  const next = text[end];
  return next === undefined || /[\s，。！？、：；,.!?:;()[\]{}<>@]/u.test(next);
}

function collectMarkdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const fenced = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    const marker = match[2] ?? '```';
    const start = match.index + (match[1]?.length ?? 0);
    const bodyStart = fenced.lastIndex;
    const closing = new RegExp(`(^|\\n)[ \\t]{0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`, 'g');
    closing.lastIndex = bodyStart;
    const closingMatch = closing.exec(text);
    const end = closingMatch ? closing.lastIndex : text.length;
    ranges.push({ start, end });
    fenced.lastIndex = end;
  }

  const inline = /(`+)([^\n]*?)\1/g;
  while ((match = inline.exec(text)) !== null) {
    if (!ranges.some((range) => match!.index >= range.start && match!.index < range.end)) {
      ranges.push({ start: match.index, end: inline.lastIndex });
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function isInsideMarkdownCode(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/**
 * 将可能出现在模型输出、工具结果或历史轨迹中的实例 ID 统一替换为群聊中文名。
 * 该函数只处理当前群聊内已知的实例 ID，不改写文件 ID、Run ID 等其他技术标识。
 */
export function sanitizeAgentDisplayText(
  db: Database.Database,
  projectId: string,
  text: string,
  snapshot?: ProjectContextSnapshot,
): string {
  if (!text) return text;
  let sanitized = text;
  const agentNames = snapshot?.agentNames ?? listProjectAgentNames(db, projectId);
  for (const agent of agentNames) {
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
  snapshot?: ProjectContextSnapshot,
): AgentMention[] {
  if (!text.includes('@')) return [];

  const ctx = snapshot ?? loadProjectContext(db, projectId);
  const lowerText = text.toLocaleLowerCase();
  const codeRanges = collectMarkdownCodeRanges(text);
  const candidates: Array<{ agent: ProjectAgent; start: number; end: number }> = [];
  for (const agent of ctx.agents) {
    const token = `@${agent.name}`;
    let searchFrom = 0;
    while (searchFrom < lowerText.length) {
      const start = lowerText.indexOf(token.toLocaleLowerCase(), searchFrom);
      if (start < 0) break;
      const end = start + token.length;
      if (hasMentionEndBoundary(text, end) && !isInsideMarkdownCode(start, codeRanges)) {
        candidates.push({ agent, start, end });
      }
      searchFrom = end;
    }
  }

  // 同一位置优先匹配更长的名称/ID，避免 @知识 同时误命中 @知识管理智能体。
  candidates.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
  const mentions: AgentMention[] = [];
  const seen = new Set<string>();
  const userName = ctx.profile.nickname;
  const userAliases = [...new Set(['用户', '项目负责人', 'user', userName])].map(escapeRegExp).join('|');
  const userMatch = new RegExp(`@(${userAliases})(?=\\s|[，。！？,:;]|$)`, 'i').exec(text);
  if (userMatch && !isInsideMarkdownCode(userMatch.index, codeRanges)) {
    seen.add('user:local-user');
    mentions.push({
      target: { scope: 'user', id: 'local-user' },
      label: userMatch[1] ?? userName,
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

  // 请求级快照：整条消息只读取一次项目成员与用户资料，供下方各环节复用。
  const ctx = loadProjectContext(db, projectId);
  const sender = senderId ? ctx.agents.find((agent) => agent.id === senderId) : undefined;
  const rawText = sanitizeAgentDisplayText(db, projectId, typeof content.text === 'string' ? content.text : '', ctx);
  // User-authored messages are left untouched.  The protocol scrubber is an
  // agent-output boundary and must not alter a user who intentionally sends
  // JSON as part of their request.
  const agentAuthored = senderId !== undefined && senderId !== 'local-user';
  let text = agentAuthored ? sanitizeUserFacingResponse(rawText) : rawText;
  if (sender) text = naturalizeAgentReply(text);
  if (sender) {
    const userName = ctx.profile.nickname;
    const aliases = ['用户', '项目负责人', 'user']
      .filter((alias) => alias.toLocaleLowerCase('zh-CN') !== userName.toLocaleLowerCase('zh-CN'))
      .map(escapeRegExp)
      .join('|');
    if (aliases) text = text.replace(new RegExp(`@(?:${aliases})(?=\\s|[，。！？,:;]|$)`, 'giu'), `@${userName}`);
  }
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
  const audience = isAgentMessageAudience(content.audience) ? content.audience : undefined;
  const audienceAllows = (mention: AgentMention): boolean => {
    if (!audience || audience.scope === 'broadcast') return true;
    if (audience.scope === 'user') return mention.target.scope === 'user' && mention.target.id === 'local-user';
    if (audience.scope === 'instance') return mention.target.scope === 'instance' && mention.target.id === audience.id;
    return (mention.target.scope === 'instance' && mention.target.id === audience.id)
      || (audience.includeUser === true && mention.target.scope === 'user' && mention.target.id === 'local-user');
  };
  let resolved = resolveAgentMentions(db, projectId, text, ctx);
  if (audience && audience.scope !== 'broadcast') {
    const excluded = resolved.filter((mention) => !audienceAllows(mention)).sort((left, right) => right.start - left.start);
    for (const mention of excluded) {
      text = `${text.slice(0, mention.start)}${text.slice(mention.start + 1)}`;
    }
    if (excluded.length > 0) resolved = resolveAgentMentions(db, projectId, text, ctx);
  }
  const confirmedExtras = resolved.filter((candidate) => extraMentions.some((mention) => (
    candidate.target.scope === mention.target.scope
    && candidate.target.id === mention.target.id
    && candidate.label === mention.label
  )));
  const confirmedExtraIds = new Set(confirmedExtras.map((mention) => mention.target.id));
  const mentions = mergeAgentMentions(confirmedExtras, resolved)
    .filter((mention) => mention.target.id !== senderId)
    .filter(audienceAllows)
    .filter((mention) => mention.target.scope === 'user'
      || confirmedExtraIds.has(mention.target.id)
      || isAllowedAgentHandoff(db, projectId, senderId ?? '', mention.target.id, text, ctx));

  return JSON.stringify({
    ...content,
    schemaVersion: typeof content.schemaVersion === 'number' ? content.schemaVersion : 1,
    text,
    mentions,
  });
}

function isAgentMessageAudience(value: unknown): value is AgentMessageAudience {
  if (!value || typeof value !== 'object') return false;
  const audience = value as { scope?: unknown; id?: unknown; includeUser?: unknown };
  if (audience.scope === 'user' || audience.scope === 'broadcast') return true;
  if (audience.scope === 'instance') return typeof audience.id === 'string' && audience.id.length > 0;
  return audience.scope === 'parent'
    && typeof audience.id === 'string'
    && audience.id.length > 0
    && (audience.includeUser === undefined || typeof audience.includeUser === 'boolean');
}

export function buildAgentCollaborationInstructions(
  db: Database.Database,
  projectId: string,
  currentAgentInstanceId: string,
  snapshot?: ProjectContextSnapshot,
): string {
  const agents = snapshot?.agents ?? listEnabledProjectAgents(db, projectId);
  const current = agents.find((agent) => agent.id === currentAgentInstanceId);
  const roster = agents
    .map((agent) => agent.id === currentAgentInstanceId
      ? `- ${agent.name}（你自己，${agent.role}，${agent.runtimeMode}）`
      : `- @${agent.name}（${agent.role}，${agent.runtimeMode}）`)
    .join('\n');

  const specialistPolicy = resolveSpecialistChatPolicy(current);

  return `## 群聊协作能力
你在当前群聊中的身份是 ${current?.name ?? '智能体'}。
当前群聊成员：
${roster || '- 暂无其他成员'}

- ${specialistPolicy}
- 只有统筹负责人可以安排全局任务；其他成员不得把用户原始需求原样转发给别人，也不得为了“归集、验收、汇总、确认或等待”发起新的智能体任务。
- 你可以在回复中使用上方成员名单里的准确名称 @群聊成员；系统只会路由通过依赖校验的有效请求。需要对方处理工作时，必须把 @准确中文名 写在普通正文中，不能放进行内代码、代码块、HTML 或 JSON。
- 你可以使用 \`@用户\` 请求用户做决定、补充缺失信息或确认高风险操作；只有缺少该结果就无法继续时才进入等待。问候、提醒、成果交付、用户要求你主动 @ 他、以及“如需继续请告诉我”这类可选沟通，在发出后都应正常结束任务。
- 只有在普通正文中明确写出 @准确中文名 才会触发该智能体；仅在正文中描述某位智能体的名称时不要添加 @，代码区内的 @ 永远只作为示例文本。
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
