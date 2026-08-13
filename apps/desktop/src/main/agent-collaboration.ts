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
  definitionId: string;
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
): boolean {
  const agents = listEnabledProjectAgents(db, projectId);
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
     WHERE pai.project_id = ?
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
  const codeRanges = collectMarkdownCodeRanges(text);
  const candidates: Array<{ agent: ProjectAgent; start: number; end: number }> = [];
  for (const agent of listEnabledProjectAgents(db, projectId)) {
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
  const userMatch = /@(用户|项目负责人|user)(?=\s|[，。！？,:;]|$)/i.exec(text);
  if (userMatch && !isInsideMarkdownCode(userMatch.index, codeRanges)) {
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
    return text.slice(mention.start, mention.end) === token
      && resolved.some((candidate) => (
        candidate.target.scope === mention.target.scope
        && candidate.target.id === mention.target.id
        && candidate.start === mention.start
        && candidate.end === mention.end
      ));
  });
  const confirmedExtraIds = new Set(confirmedExtras.map((mention) => mention.target.id));
  const mentions = mergeAgentMentions(confirmedExtras, resolved)
    .filter((mention) => mention.target.id !== senderId)
    .filter((mention) => mention.target.scope === 'user'
      || confirmedExtraIds.has(mention.target.id)
      || isAllowedAgentHandoff(db, projectId, senderId ?? '', mention.target.id, text));

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

  const leader = isLeaderAgent(current);
  const specialistPolicy = leader
    ? '- 你是统筹负责人：负责理解用户需求、拆解工作、决定是否需要专业成员，并通过正式消息把具体任务交给对应成员。只有在所有被委派的工作真实返回后，才验收、汇总并向用户交付。'
    : current?.definitionId === 'builtin.researcher'
      ? '- 你是资料调研智能体：优先直接完成统筹负责人交给你的资料检索、来源核验和分析任务。不要把调研任务、知识归集、经验沉淀或业务流程梳理转派给知识管理智能体；只有当前工作确实被某个具体资料依赖阻塞时，才用正式消息 @ 对方请求这一项依赖，收到结果后继续完成自己的任务。'
      : current?.definitionId === 'builtin.material-writer'
        ? '- 你是材料编写智能体：依据统筹提供的证据和模板先列框架再逐章编写，只把完整待审稿写入指定验收暂存路径；不得直接发布最终文件，也不得自行安排其他成员。'
        : current?.definitionId === 'builtin.acceptance-reviewer'
          ? '- 你是验收智能体：独立读取待审稿并检索本地知识证据，明确给出通过或不通过结论与返修项；不得修改或发布文件，也不得自行安排其他成员。'
      : '- 你是专业执行成员：先完成统筹负责人交给你的工作，不要自行编排全局流程。只有当前执行被一个具体的外部依赖阻塞时，才用正式消息 @ 对方请求明确的输入或动作，收到结果后继续自己的任务，并把结果交回统筹负责人。';

  return `## 群聊协作能力
你在当前群聊中的身份是 ${current?.name ?? '智能体'}。
当前群聊成员：
${roster || '- 暂无其他成员'}

- ${specialistPolicy.slice(2)}
- 只有统筹负责人可以安排全局任务；其他成员不得把用户原始需求原样转发给别人，也不得为了“归集、验收、汇总、确认或等待”发起新的智能体任务。
- 你可以在回复中使用上方的准确名称（例如 @知识管理智能体）@群聊成员；系统只会路由通过依赖校验的有效请求。需要对方处理工作时，必须把 @准确中文名 写在普通正文中，不能放进行内代码、代码块、HTML 或 JSON。
- 你可以使用 \`@用户\` 请求用户做决定、补充缺失信息或确认高风险操作；\`@用户\` 只用于沟通，不会创建新的智能体任务。
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
