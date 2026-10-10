import type { Pool } from 'pg';
import type { Conversation } from '../repositories/types.js';
import { ensureRuntimeRegistry } from './registry.js';

export class InvalidConversationAgents extends Error {}

/** Persist the room and its explicit role pool together; never populate unselected agents. */
export async function createRoomWithAgents(pool: Pool, projectId: string, name: string, agentIds?: string[]): Promise<Conversation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = (await client.query('SELECT owner_identity_id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rows[0];
    if (!project) throw new InvalidConversationAgents('项目不存在');
    await ensureRuntimeRegistry(client, project.owner_identity_id);
    const agents = (await client.query<{ id: string; name: string; enabled: boolean }>('SELECT id,name,enabled FROM agents WHERE identity_id=$1 FOR SHARE', [project.owner_identity_id])).rows;
    const coordinator = agents.find(agent => agent.name === '统筹智能体' && agent.enabled);
    if (!coordinator) throw new InvalidConversationAgents('统筹智能体不可用，请刷新后重试');
    const available = agents.filter(agent => agent.name !== '统筹智能体' && agent.enabled);
    const selected = agentIds ?? available.map(agent => agent.id);
    if (agentIds && (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !available.some(agent => agent.id === id)))) {
      throw new InvalidConversationAgents('请选择至少一个可用的协作智能体；不能选择统筹、已禁用或其他身份的智能体');
    }
    const row = (await client.query('INSERT INTO conversations(project_id,name) VALUES($1,$2) RETURNING id,project_id,name,created_at', [projectId, name])).rows[0];
    await client.query(`INSERT INTO conversation_agents(conversation_id,agent_id,role) VALUES($1,$2,'coordinator')`, [row.id, coordinator.id]);
    for (const agentId of selected) {
      await client.query(`INSERT INTO conversation_agents(conversation_id,agent_id,role) VALUES($1,$2,'member')`, [row.id, agentId]);
    }
    await client.query('COMMIT');
    return { id: row.id, projectId: row.project_id, name: row.name, createdAt: new Date(row.created_at).toISOString() };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
