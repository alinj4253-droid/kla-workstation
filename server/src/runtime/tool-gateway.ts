import type { Pool, PoolClient } from 'pg';
import { runtimeSkillCatalog, type RuntimeSkillCode } from '@kla-workstation/contracts';
import { requirePermission, type PermissionAction } from '../auth/permission-service.js';
import { hasPermission as hasComputePermission, COMPUTE_PERMISSION } from '../compute/permissions.js';
import type { RegisteredAgent } from './registry.js';
import { agentTools, parseToolArguments, RuntimeTools } from './tools.js';
import type { ComputeGateway, GatewayChatInput } from '../compute/gateway.js';
import type { Identity } from '../repositories/types.js';
import type { AgentMemoryScope, ShortTermMemoryService } from '../memories/short-term.js';
import { effectiveToolCodes } from './registry.js';

export type ToolScope = {
  identityId: string;
  conversationId: string;
  runId: string;
  stepId: string;
  agent: RegisteredAgent;
  deviceId: string | null;
};

export type ModelToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

export type PreparedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  location: 'local' | 'server';
  action: PermissionAction;
};

const catalog = new Map(runtimeSkillCatalog.map(skill => [skill.code, skill]));

/** Single policy and routing boundary for model-facing runtime tools. */
export class ToolGateway {
  constructor(private readonly pool: Pool, private readonly serverTools: RuntimeTools,
    private readonly modelGateway?: Pick<ComputeGateway, 'completeChat'>,
    private readonly memory?: ShortTermMemoryService) {}

  discover(agent: RegisteredAgent) {
    return agentTools(agent);
  }

  async knowledgeInfo(identityId: string, conversationId: string): Promise<unknown> {
    return this.serverTools.knowledgeInfo(identityId, conversationId);
  }

  async completeModel(identity: Identity, input: GatewayChatInput) {
    if (!this.modelGateway) throw new Error('模型网关未配置');
    await requirePermission(this.pool, identity.id, 'write');
    if (!(await hasComputePermission(this.pool, identity.id, COMPUTE_PERMISSION.modelUse))) {
      throw new Error('当前身份缺少 model.use 权限');
    }
    return this.modelGateway.completeChat(identity, input);
  }

  async conversationHistory(scope: AgentMemoryScope, triggerMessageId: string) {
    if (!this.memory) throw new Error('记忆服务未配置');
    await requirePermission(this.pool, scope.identityId, 'read');
    const history = await this.memory.history(scope, triggerMessageId);
    const rows = (await this.pool.query(`SELECT m.metadata->'files' AS files FROM messages m
      WHERE m.conversation_id=$1 AND m.created_at<=(SELECT created_at FROM messages WHERE id=$2 AND conversation_id=$1)
        AND CASE WHEN jsonb_typeof(m.metadata->'files')='array' THEN jsonb_array_length(m.metadata->'files') ELSE 0 END>0 ORDER BY m.created_at DESC LIMIT 20`, [scope.conversationId, triggerMessageId])).rows;
    if (rows.length) history.push({ role: 'system', content: `本群聊近期附件（文件编号是跨设备共享标识；使用 file_read 读文本，local_file_fetch 下载后调用本地工具，不能将其他设备路径作为输入）：${JSON.stringify(rows.flatMap(row => row.files))}` });
    return history;
  }

  async recallMemory(scope: AgentMemoryScope, query: string, runId: string) {
    if (!this.memory) throw new Error('记忆服务未配置');
    await requirePermission(this.pool, scope.identityId, 'read');
    const memories = await this.memory.recall(scope, query);
    await this.pool.query(`INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload)
      VALUES($1,$2,$3,'memory.recalled',$4)`, [scope.identityId, scope.conversationId, runId,
      JSON.stringify({ agentId: scope.agentId, count: memories.length })]);
    return memories;
  }

  async captureMemory(scope: AgentMemoryScope, input: Parameters<ShortTermMemoryService['capture']>[1]) {
    if (!this.memory) throw new Error('记忆服务未配置');
    await requirePermission(this.pool, scope.identityId, 'write');
    await this.memory.capture(scope, input);
    await this.pool.query(`INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload)
      VALUES($1,$2,$3,'memory.captured',$4)`, [scope.identityId, scope.conversationId, input.runId,
      JSON.stringify({ agentId: scope.agentId, sourceMessageId: input.sourceMessageId })]);
  }

  private async authorize(scope: ToolScope, name: string): Promise<{ location: 'local' | 'server'; action: PermissionAction }> {
    const skill = catalog.get(name as RuntimeSkillCode);
    if (!skill || !scope.agent.skills.includes(skill.code) || !this.discover(scope.agent).some(tool => tool.function.name === name)) {
      throw new Error(`智能体无权调用未挂载或已停用的工具：${name}`);
    }
    const agent = await this.pool.query('SELECT enabled FROM agents WHERE id=$1 AND identity_id=$2', [scope.agent.id, scope.identityId]);
    const enabled = await effectiveToolCodes(this.pool, scope.agent.id);
    if (!agent.rows[0]?.enabled || !enabled.includes(name)) throw new Error(`工具已停用或智能体已失效：${name}`);
    if (skill.location === 'local' && (scope.agent.execution_location !== 'local' || !scope.deviceId)) {
      throw new Error('本地工具需要已认证的本地执行设备');
    }
    const action: PermissionAction = skill.location === 'local' || name === 'knowledge_ocr' || name === 'web_search' ? 'execute' : name === 'artifact_write' || name === 'artifact_compose' ? 'write' : 'read';
    await requirePermission(this.pool, scope.identityId, action);
    return { location: skill.location, action };
  }

  async prepare(scope: ToolScope, call: ModelToolCall): Promise<PreparedToolCall> {
    if (!call.id) throw new Error('工具调用缺少模型调用编号');
    const { location, action } = await this.authorize(scope, call.function.name);
    const args = parseToolArguments(call.function.name, JSON.parse(call.function.arguments));
    return { id: call.id, name: call.function.name, args, location, action };
  }

  async enqueue(client: PoolClient, scope: ToolScope, call: PreparedToolCall): Promise<void> {
    const inserted = await client.query(`INSERT INTO runtime_tool_calls(step_id,identity_id,device_id,model_call_id,tool_name,arguments)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [scope.stepId, scope.identityId,
      call.location === 'local' ? scope.deviceId : null, call.id, call.name, JSON.stringify(call.args)]);
    if (inserted.rows[0]) await client.query(`INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload)
      VALUES($1,$2,$3,'tool.queued',$4)`, [scope.identityId, scope.conversationId, scope.runId,
      JSON.stringify({ callId: inserted.rows[0].id, tool: call.name, location: call.location, action: call.action, agentId: scope.agent.id,
        deviceId: call.location === 'local' ? scope.deviceId : null })]);
  }

  async executeServerCalls(scope: ToolScope, assertActive: () => Promise<void>): Promise<void> {
    const queued = await this.pool.query(`SELECT * FROM runtime_tool_calls WHERE step_id=$1 AND device_id IS NULL
      AND status='queued' ORDER BY created_at,id`, [scope.stepId]);
    for (const call of queued.rows) {
      await assertActive();
      let result: unknown;
      try {
        await this.authorize(scope, call.tool_name);
        if (catalog.get(call.tool_name as RuntimeSkillCode)?.location !== 'server') throw new Error('本地工具不能由服务端执行');
        result = await this.serverTools.execute(call.tool_name, call.arguments,
          { identityId: scope.identityId, conversationId: scope.conversationId, agentId: scope.agent.id, toolCallId: call.id });
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      await assertActive();
      const status = result && typeof result === 'object' && 'error' in result ? 'failed' : 'completed';
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE runtime_tool_calls SET status=$2,result=$3,completed_at=now()
          WHERE id=$1 AND status='queued' RETURNING id`, [call.id, status, JSON.stringify(result)]);
        if (updated.rows[0]) await client.query(`INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload)
          VALUES($1,$2,$3,'tool.completed',$4)`, [scope.identityId, scope.conversationId, scope.runId,
          JSON.stringify({ callId: call.id, tool: call.tool_name, status, agentId: scope.agent.id })]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }
}
