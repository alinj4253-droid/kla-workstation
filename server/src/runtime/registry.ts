import type { Pool, PoolClient } from 'pg';
import { runtimeSkillCatalog, type TaskPlan } from '@kla-workstation/contracts';

export type RegisteredAgent = { id: string; name: string; role: string; model_id: string | null; execution_location: 'server'|'local'; device_id: string|null; enabled: boolean; version: number; skills: string[] };
export async function ensureRuntimeRegistry(pool: Pool | PoolClient, identityId: string): Promise<void> {
  // Unique agent names and builtin skill codes make concurrent provisioning idempotent.
  await pool.query(`INSERT INTO agents(identity_id,name,role,type) SELECT $1,v.name,v.role,'official' FROM
    (VALUES ('统筹智能体','理解用户目标，规划任务依赖，协调智能体和设备，汇总成果'),
    ('本地执行智能体','分析资料、编写文档和代码，调用技能完成完整任务')) v(name,role)
    WHERE NOT EXISTS(SELECT 1 FROM agents WHERE identity_id=$1 AND name=v.name) ON CONFLICT DO NOTHING`, [identityId]);
  for (const skill of runtimeSkillCatalog) {
    await pool.query(`INSERT INTO skills(agent_id,name,description,definition,enabled)
      SELECT a.id,$2,$3,$4,true FROM agents a WHERE a.identity_id=$1 AND a.name<>'统筹智能体'
      AND NOT EXISTS(SELECT 1 FROM skills s WHERE s.agent_id=a.id AND s.definition->>'code'=$5) ON CONFLICT DO NOTHING`,
    [identityId, skill.name, skill.description, JSON.stringify({ code: skill.code, location: skill.location, permission: skill.location === 'local' ? 'full-current-user' : 'identity-scoped', builtin: true }), skill.code]);
  }
}
export async function roomRegistry(pool: Pool, conversationId: string): Promise<RegisteredAgent[]> {
  const scope = (await pool.query('SELECT p.owner_identity_id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1', [conversationId])).rows[0];
  if (!scope) throw new Error('群聊不存在');
  await ensureRuntimeRegistry(pool, scope.owner_identity_id);
  // Existing empty rooms are migrated lazily. New rooms are registered at creation.
  await pool.query(`INSERT INTO conversation_agents(conversation_id,agent_id,role)
    SELECT $1,a.id,CASE WHEN a.name='统筹智能体' THEN 'coordinator' ELSE 'member' END FROM agents a
    WHERE a.identity_id=$2 AND a.enabled AND (a.name='统筹智能体' OR NOT EXISTS(SELECT 1 FROM conversation_agents WHERE conversation_id=$1))
    ON CONFLICT DO NOTHING`, [conversationId, scope.owner_identity_id]);
  const agents = await pool.query(`SELECT a.*,COALESCE((SELECT jsonb_agg(s.definition->>'code') FROM skills s WHERE s.agent_id=a.id AND s.enabled AND s.definition ? 'code'),'[]') AS skills
    FROM conversation_agents ca JOIN agents a ON a.id=ca.agent_id WHERE ca.conversation_id=$1 AND a.identity_id=$2 AND a.enabled ORDER BY ca.created_at,a.name`, [conversationId, scope.owner_identity_id]);
  return agents.rows;
}
export function validatePlan(plan: TaskPlan, registry: RegisteredAgent[]): void {
  const ids = new Set(registry.filter(a => a.name !== '统筹智能体').map(a => a.id));
  for (const [index, task] of plan.tasks.entries()) {
    if (!ids.has(task.agentId)) throw new Error('计划指定了群聊外或统筹智能体作为执行者');
    if (task.dependsOn.some(dep => dep >= index + 1) || new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error('任务依赖必须引用前面的任务，不能循环或重复');
  }
}
