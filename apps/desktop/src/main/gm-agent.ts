import type Database from 'better-sqlite3';
import type { ModelGateway } from './model-gateway';

export const GM_PROFILE_ID = 'builtin-gm-profile';
export const GM_DEFINITION_ID = 'builtin.gm';
export const ORCHESTRATOR_PROFILE_ID = 'builtin-orchestrator-profile';
export const LOCAL_EXECUTOR_PROFILE_ID = 'builtin-local-executor-profile';

export type GmHomePlan = {
  groupName: string;
  requestedAgentProfileIds: string[];
  rationale: string;
  source: 'model' | 'fallback';
};

type CandidateProfile = {
  id: string;
  name: string;
  definitionId: string;
  runtimeMode: 'native-model' | 'external-cli';
  adapterType: string | null;
};

const BUILTIN_ROLE_HINTS: Record<string, string> = {
  'builtin.orchestrator': '理解目标、规划步骤、调度协作并最终交付',
  'builtin.local-executor': '接收统筹转达的用户原始需求或完整业务工作包，在自身 loop 中按需完成本地知识化、内外部调研、材料编写、验收返修和真实成果交付',
  'builtin.knowledge-manager': '对原始文件执行 OCR、标准化、切片、向量、图谱、Wiki 与入库维护',
  'builtin.researcher': '检索公开网络资料、时效信息、市场与事实证据',
  'builtin.material-writer': '检索和读取内部知识与模板，并整理为报告、方案、材料或 HTML 文件',
  'builtin.acceptance-reviewer': '独立检索知识、读取模板与来源文件，验收高风险或明确要求复核的成果',
};

function cleanGroupName(value: unknown, request: string): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw.replace(/[\r\n<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned) return cleaned.slice(0, 24);
  const requestName = request.replace(/^请|帮我|麻烦|能否|可以/g, '').replace(/[\r\n]+/g, ' ').trim();
  return (requestName || '新协作群组').slice(0, 18);
}

function profileForDefinition(candidates: CandidateProfile[], definitionId: string): CandidateProfile | undefined {
  return candidates.find((candidate) => candidate.definitionId === definitionId);
}

function fallbackPlan(request: string, candidates: CandidateProfile[]): GmHomePlan {
  const text = request.toLocaleLowerCase('zh-CN');
  const selected = new Set<string>([ORCHESTRATOR_PROFILE_ID]);
  const selectDefinition = (definitionId: string): void => {
    const profile = profileForDefinition(candidates, definitionId);
    if (profile) selected.add(profile.id);
  };

  const needsInternalKnowledge = /(公司|企业|内部|制度|流程|规定|规范|工作区|知识库|本地文件|文档|附件|合同|审计)/i.test(text);
  const needsKnowledgeIngestion = /(上传|导入|新增|变更|删除|知识化|入库|ocr|切片|向量|图谱|wiki|原始文件处理)/i.test(text);
  const needsResearch = /(今天|当前|最新|实时|天气|新闻|市场|行业|竞品|调研|搜索|查一下|公开资料|网络|网页|政策)/i.test(text);
  const needsWriting = /(报告|方案|材料|文档|文件|html|网页|总结成|整理成|梳理成|撰写|编写|输出一份|生成一份)/i.test(text);
  const needsReview = /(验收|审核|复核|校验|合规|法务|审计|准确性|真实性|风险)/i.test(text);
  const needsCoding = /(代码|编码|开发|实现|修复|调试|编译|程序|脚本|前端|后端|接口|cli)/i.test(text);

  if (needsKnowledgeIngestion || needsInternalKnowledge || needsResearch || needsWriting
    || (needsReview && (needsWriting || needsInternalKnowledge))) {
    selectDefinition('builtin.local-executor');
  }

  if (needsCoding) {
    const codingAgent = candidates.find((candidate) => candidate.runtimeMode === 'external-cli'
      && /(codex|codebuddy|代码|开发|编程)/i.test(`${candidate.name} ${candidate.adapterType ?? ''} ${candidate.definitionId}`));
    if (codingAgent) selected.add(codingAgent.id);
  }

  return {
    groupName: cleanGroupName('', request),
    requestedAgentProfileIds: [...selected].slice(0, 9),
    rationale: '已按本地能力规则选择完成需求所需的最小团队。',
    source: 'fallback',
  };
}

function readCandidates(db: Database.Database): CandidateProfile[] {
  return db.prepare(
    `SELECT ap.id, ap.name, ap.definition_id as definitionId, ap.runtime_mode as runtimeMode,
            cc.adapter_type as adapterType
     FROM agent_profiles ap
     LEFT JOIN cli_connections cc ON cc.id = ap.cli_connection_id
     WHERE ap.enabled = 1 AND ap.id != ?
       AND (ap.runtime_mode != 'external-cli' OR ap.cli_connection_id IS NOT NULL)
     ORDER BY ap.is_system_default DESC, ap.name`,
  ).all(GM_PROFILE_ID) as CandidateProfile[];
}

function gmModelSnapshot(db: Database.Database): string | null {
  const row = db.prepare(
    'SELECT model_profile_id as modelProfileId, overrides_json as overridesJson FROM agent_profiles WHERE id = ?',
  ).get(GM_PROFILE_ID) as { modelProfileId: string | null; overridesJson: string | null } | undefined;
  if (!row?.modelProfileId) return null;
  let parameters: Record<string, unknown> | undefined;
  try {
    const overrides = row.overridesJson ? JSON.parse(row.overridesJson) as { modelOptions?: Record<string, unknown> } : {};
    parameters = overrides.modelOptions;
  } catch { /* use the model defaults */ }
  return JSON.stringify({ profileId: row.modelProfileId, ...(parameters ? { parameters } : {}) });
}

export async function planHomeRequest(
  db: Database.Database,
  gateway: ModelGateway | null,
  request: string,
): Promise<GmHomePlan> {
  const candidates = readCandidates(db);
  const fallback = fallbackPlan(request, candidates);
  if (!gateway || !request.trim()) return fallback;

  const candidateText = candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    role: BUILTIN_ROLE_HINTS[candidate.definitionId]
      ?? (candidate.runtimeMode === 'external-cli' ? `外部 ${candidate.adapterType ?? 'CLI'} 执行智能体` : '自定义智能体'),
  }));
  const system = `你是鲲擎工作站的 GM 智能体，拥有全局群组创建权限。你的当前职责只有两个：根据用户的完整需求选择完成任务真正需要的最小智能体团队，并生成简洁准确的中文群聊名称。

统筹管理智能体必须始终加入。本地执行智能体已经把知识化、内外部调研、材料编写和成果验收封装为自身技能；任务需要这些能力时只需加入一个本地执行智能体，由统筹按"用户原话优先"原则转达用户原话或完整业务工作包给它，不要再寻找或拼装旧四角色。简单问答通常只需要统筹，操作、会议、代码和其他专业能力仍选择候选池中最匹配的智能体。最多选择 9 个，绝不能返回候选池之外的 ID。GM 自己不进入群聊。

只返回 JSON 对象：{"groupName":"不超过24字的群聊名称","requestedAgentProfileIds":["候选ID"],"rationale":"一句话说明"}。`;

  try {
    const execute = () => gateway.generateObject<Record<string, unknown>>('fast', [{
      role: 'user',
      content: `用户需求：\n${request}\n\n当前可用智能体：\n${JSON.stringify(candidateText)}`,
    }], system);
    const snapshot = gmModelSnapshot(db);
    const raw = snapshot ? await gateway.runWithModelProfileSnapshot(snapshot, execute) : await execute();
    const validIds = new Set(candidates.map((candidate) => candidate.id));
    const ids = Array.isArray(raw.requestedAgentProfileIds)
      ? raw.requestedAgentProfileIds.filter((id): id is string => typeof id === 'string' && validIds.has(id))
      : [];
    const selected = [...new Set([ORCHESTRATOR_PROFILE_ID, ...ids])].slice(0, 9);
    return {
      groupName: cleanGroupName(raw.groupName, request),
      requestedAgentProfileIds: selected,
      rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 200) : 'GM 已按需求完成团队配置。',
      source: 'model',
    };
  } catch {
    return fallback;
  }
}
