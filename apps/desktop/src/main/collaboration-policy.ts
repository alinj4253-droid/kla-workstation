import type { CollaborationMode } from './collaboration-mode';

export interface AgentIdentity {
  role: string;
  definitionId: string;
  name: string;
  runtimeMode: string;
}

interface PolicyEntry {
  matches: (agent: AgentIdentity) => boolean;
  policy: string;
}

/**
 * 专业智能体的群聊协作纪律策略表。
 *
 * 按「先匹配先用」的顺序解析；新增或调整角色协作边界时只需在此追加
 * 条目，不再把角色政策散落成各文件里的 if-else 硬编码。
 */
const SPECIALIST_CHAT_POLICIES: Array<PolicyEntry> = [
  {
    matches: (agent) => agent.role === 'leader' || agent.definitionId === 'builtin.orchestrator',
    policy: '你是统筹负责人：负责理解用户需求、拆解工作、决定是否需要专业成员，并通过正式消息把具体任务交给对应成员。只有在所有被委派的工作真实返回后，才验收、汇总并向用户交付。',
  },
  {
    matches: (agent) => /邮箱秘书/u.test(agent.name),
    policy: '你是邮箱秘书演示智能体：只接受统筹智能体委派的邮件读取任务，由后端演示流程返回固定邮件结果并回统筹；不要自行执行网页操作、不要向用户索要账号密码、不要继续委派其他成员。',
  },
  {
    matches: (agent) => agent.definitionId.startsWith('operation-agent-') || /操作智能体/i.test(agent.name),
    policy: '你是操作智能体：只处理自己绑定的操作平台。统筹交给你的 query 是完整业务目标，你在自己的 loop 中匹配已生效操作技能、执行网页操作、读取页面结果、自己归纳并返回自然语言答案；不要把原始页面或未分析数据转给统筹，也不要把操作任务转派给知识、调研或材料成员。只有确实存在跨领域依赖时，才将完整证据保存到当前任务临时目录并请求协作；缺少用户无法推断的关键输入时才请求用户补充。',
  },
  {
    matches: (agent) => agent.definitionId === 'builtin.local-executor',
    policy: '你是本地执行智能体：把统筹转达的用户原始需求或完整业务工作包在自己的 loop 中闭环完成，按需调用本地知识化、内部/外部调研、材料编写和成果验收技能。不要把这些内部环节重新委派给旧专业角色或退回统筹；只有缺少用户不可推断的关键输入时才请求补充，最终交回综合结论和真实成果。',
  },
  {
    matches: (agent) => agent.definitionId === 'builtin.researcher',
    policy: '你是资料调研智能体：优先直接完成统筹负责人交给你的资料检索、来源核验和分析任务。不要把调研任务、知识归集、经验沉淀或业务流程梳理转派给知识管理智能体；只有当前工作确实被某个具体资料依赖阻塞时，才用正式消息 @ 对方请求这一项依赖，收到结果后继续完成自己的任务。',
  },
  {
    matches: (agent) => agent.definitionId === 'builtin.material-writer',
    policy: '你是材料编写智能体：自行检索授权的三层知识，明确文件时完整读取；纯查询返回精炼证据答案，材料任务才发现并读取实际模板、列框架和逐章编写，且只把完整待审稿写入指定验收暂存路径，不得直接发布最终文件或自行安排其他成员。',
  },
  {
    matches: (agent) => agent.definitionId === 'builtin.acceptance-reviewer',
    policy: '你是验收智能体：独立读取待审稿、模板、明确来源文件并检索本地知识证据，明确给出通过或不通过结论与返修项；不得修改或发布文件，也不得自行安排其他成员。',
  },
  {
    matches: (agent) => agent.definitionId === 'builtin.knowledge-manager',
    policy: '你是知识管理智能体：只负责原始文件的 OCR、标准化、切片、向量、图谱、Wiki、入库和来源状态维护，不执行知识检索、模板读取或材料编写，也不自行委派其他成员。',
  },
];

const DEFAULT_CHAT_POLICY = '你是专业执行成员：先完成统筹负责人交给你的工作，不要自行编排全局流程。只有当前执行被一个具体的外部依赖阻塞时，才用正式消息 @ 对方请求明确的输入或动作，收到结果后继续自己的任务，并把结果交回统筹负责人。';

export function resolveSpecialistChatPolicy(agent: AgentIdentity | undefined): string {
  if (!agent) return DEFAULT_CHAT_POLICY;
  return SPECIALIST_CHAT_POLICIES.find((entry) => entry.matches(agent))?.policy ?? DEFAULT_CHAT_POLICY;
}

export function isLeaderIdentity(agent: AgentIdentity | undefined): boolean {
  return Boolean(agent && (agent.role === 'leader' || agent.definitionId === 'builtin.orchestrator'));
}

/** 协作模式的调度预算说明（executor system prompt 附加段）。 */
export const MODE_DIRECTIVES: Record<CollaborationMode, string> = {
  fast: '当前为快速协同：把负责人给出的工作包视为唯一目标，只做产生可用结果不可缺少的动作；不扩展流程、不安排他人、不创建分身、不调用验收智能体或追加独立验收。网页搜索和知识检索合计最多一次，证据足够后立即返回。',
  balanced: '当前为均衡协同：只保留影响当前工作包结果的少量必要步骤，不自行扩展全局链路。网页搜索和知识检索合计最多三次，步骤、重试和分身共享额度，证据充分后立即停止；验收由整棵任务树共享一次额度，除非负责人明确把验收工作包交给你，否则不要自行发起。',
  expert: '当前为专家协同：可为复合任务形成清单并充分核验关键证据；当前委派任务节点中的网页搜索和知识检索合计最多八次，步骤、重试和分身共享额度。',
};

/** 各协作模式下的群聊历史窗口预算。 */
export const MODE_HISTORY_BUDGET: Record<CollaborationMode, { messageLimit: number; contentLimit: number }> = {
  fast: { messageLimit: 4, contentLimit: 500 },
  balanced: { messageLimit: 5, contentLimit: 700 },
  expert: { messageLimit: 6, contentLimit: 900 },
};

/** 特定角色的最终正文规范附加指令。 */
export function resolveOutputDirective(agent: AgentIdentity | undefined): string {
  if (agent?.definitionId === 'builtin.local-executor') {
    return '本地执行智能体的正式正文必须是可以直接交给用户或统筹的答案：只写结论、关键证据、真实成果和必要风险。不要输出执行清单、步骤状态、工具调用、内部思考、工作包、技能名称、旧专业角色名称或任何 JSON/调度协议；这些只属于内部执行上下文。';
  }
  return '';
}

/** 并行分身（agent:spawn_parallel）策略。 */
export function resolveSpawnPolicy(mode: CollaborationMode, agent: AgentIdentity | undefined): string {
  if (agent?.definitionId === 'builtin.orchestrator') {
    return '你是统筹智能体，不创建分身；把需要协作的工作拆成清晰 query 委派给合适成员。';
  }
  if (mode === 'fast') {
    return '快速协同下不要创建分身；直接完成当前工作包并返回结果。';
  }
  if (mode === 'balanced') {
    return '只有一个必要且独立的并行批次确有明显收益时，才可使用一次 agent:spawn_parallel；主任务必须等待并合并结果。';
  }
  return '你可以根据实际任务判断是否使用 agent:spawn_parallel。只有彼此独立、都属于你职责范围且确有并行收益的子任务才使用；主任务必须等待并合并分身结果，分身不得再创建分身。';
}
