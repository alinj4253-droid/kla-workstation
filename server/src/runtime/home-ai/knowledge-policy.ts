import type { Pool, PoolClient } from 'pg';
import { runtimeSkillCatalog } from '@kla-workstation/contracts';
import { HOME_AI_TEMPLATE_CODE } from './agent.js';

export type KnowledgeToolScope = { identityId: string; conversationId: string; agentId: string; runId?: string; stepId?: string; toolCallId?: string };
type Queryable = Pool | PoolClient;
export async function isHomeAiDiagnosis(pool: Queryable, identityId: string, agentId: string): Promise<boolean> {
  return Boolean((await pool.query(`SELECT 1 FROM agent_market_installations m JOIN agents a ON a.id=m.agent_id AND a.identity_id=m.identity_id
    WHERE m.identity_id=$1 AND m.agent_id=$2 AND m.template_code=$3`, [identityId, agentId, HOME_AI_TEMPLATE_CODE])).rows[0]);
}
export async function assertKnowledgeToolPolicy(pool: Queryable, name: string, scope: KnowledgeToolScope, execution = false): Promise<void> {
  const diagnosticTool = name.startsWith('home_ai_');
  if (!diagnosticTool && !['weknora_search', 'knowledge_search', 'knowledge_read'].includes(name)) return;
  const diagnosis = await isHomeAiDiagnosis(pool, scope.identityId, scope.agentId);
  if (diagnosis && !diagnosticTool && name !== 'weknora_search') throw new Error('诊断智能体仅可使用 WeKnora 检索，禁止平台 knowledge_search/knowledge_read。');
  if (!diagnosticTool && name !== 'weknora_search') return;
  if (!diagnosis) throw new Error('WeKnora 与诊断工具仅限有效市场诊断模板安装的智能体。');
  if (!scope.runId || !scope.stepId || (execution && !scope.toolCallId)) throw new Error('WeKnora 检索缺少可信任务或工具调用范围，请通过平台工具网关执行。');
  const row = (await pool.query(`SELECT 1 FROM agents a
    JOIN identities i ON i.id=a.identity_id AND i.status='active'
    JOIN conversation_agents ca ON ca.agent_id=a.id AND ca.conversation_id=$3
    JOIN conversations c ON c.id=ca.conversation_id JOIN projects p ON p.id=c.project_id AND p.owner_identity_id=a.identity_id
    JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.identity_id=a.identity_id
    JOIN project_members pm ON pm.project_id=p.id AND pm.identity_id=a.identity_id
    JOIN conversation_runs r ON r.id=$4 AND r.conversation_id=c.id AND r.status IN ('running','waiting_tool')
    JOIN conversation_run_steps s ON s.id=$5 AND s.run_id=r.id AND s.assigned_agent_id=a.id AND s.status IN ('pending','running','waiting_tool')
    WHERE a.identity_id=$1 AND a.id=$2 AND a.enabled
      AND (EXISTS(SELECT 1 FROM agent_tool_mounts m WHERE m.agent_id=a.id AND m.tool_code=$7)
        OR EXISTS(SELECT 1 FROM agent_skill_mounts m JOIN runtime_skill_catalog k ON k.identity_id=a.identity_id AND k.code=m.skill_code AND k.enabled
          WHERE m.agent_id=a.id AND $7=ANY(k.tool_codes)))
      AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.id=$6 AND t.step_id=s.id AND t.identity_id=a.identity_id
        AND t.tool_name=$7 AND t.device_id IS NULL AND t.status='queued'))`,
  [scope.identityId, scope.agentId, scope.conversationId, scope.runId, scope.stepId, scope.toolCallId ?? null, name])).rows[0];
  if (!row) throw new Error(`${diagnosticTool?'诊断工具':'WeKnora 检索'}权限已失效：工具已停用或智能体、身份、群聊成员及当前任务范围无效，请检查挂载并恢复有效范围。`);
}
export async function assertKnowledgeMountPolicy(pool: Queryable, identityId: string, agentId: string, toolCodes: string[]): Promise<void> {
  const diagnosis = await isHomeAiDiagnosis(pool, identityId, agentId);
  if (!diagnosis && toolCodes.some(code => code === 'weknora_search' || code.startsWith('home_ai_'))) throw new Error('只有市场安装的家居 AI 机会诊断智能体可挂载 WeKnora 或诊断工具及 Skill。');
  if (diagnosis && toolCodes.some(code => runtimeSkillCatalog.some(tool => tool.code === code && tool.location === 'local'))) throw new Error('诊断智能体不能挂载本地工具；请使用服务端 file_read 或诊断材料工具。');
  if (diagnosis && toolCodes.some(code => code === 'knowledge_search' || code === 'knowledge_read')) throw new Error('诊断智能体不能挂载平台知识检索或全文读取；请使用 WeKnora Skill。');
}
