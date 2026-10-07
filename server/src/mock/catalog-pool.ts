import type { MemoryAccountRepository } from './memory-account-repository.js';

type QueryResult = { rows: Array<Record<string, unknown>> };

type ModelRow = {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  capabilities: Record<string, unknown>;
  enabled: boolean;
  is_official: boolean;
};

/**
 * Mock 模式的内存“目录池”：按 SQL 中的表名命中内存数据，
 * 覆盖 routes.ts 中 workspaces/agents/models/tasks 的目录查询；
 * 其余 SQL（记忆、文件、会议等）统一返回空结果集，保持 mock 零数据库依赖。
 */
export class CatalogPool {
  /** 与 server/migrations/0006_official_model_catalog.sql 对齐的官方模型目录节选。 */
  private readonly models: ModelRow[] = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', base_url: 'https://zhenze-huhehaote.cmecloud.cn/v1', capabilities: { thinking: false, streaming: true, context: 128000 }, enabled: true, is_official: true },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', capabilities: { thinking: true, streaming: true, context: 64000 }, enabled: true, is_official: true },
    { id: 'zhipu/glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'zhipu', base_url: 'https://moma.cmecloud.cn/v1', capabilities: { vision: true, thinking: false, streaming: true, context: 128000 }, enabled: true, is_official: true },
    { id: 'qwen-plus', name: 'Qwen Plus', provider: 'qwen', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', capabilities: { thinking: true, streaming: true, context: 128000 }, enabled: true, is_official: true },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', base_url: 'https://api.openai.com/v1', capabilities: { vision: true, streaming: true, context: 128000 }, enabled: true, is_official: true },
    { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic', base_url: 'https://api.anthropic.com/v1', capabilities: { vision: true, thinking: true, streaming: true, context: 200000 }, enabled: true, is_official: true },
  ];

  constructor(private readonly accounts: MemoryAccountRepository) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = sql.toLowerCase();
    if (normalized.includes('from memories')) return { rows: [] };
    if (normalized.includes('from files')) return { rows: [] };
    if (normalized.includes('from upload_sessions')) return { rows: [] };
    if (normalized.includes('from operation_')) return { rows: [] };
    if (normalized.includes('from meeting_')) return { rows: [] };
    if (normalized.includes('from conversation_run_steps')) return { rows: [] };
    if (normalized.includes('from conversation_agents')) return { rows: [] };
    if (normalized.includes('from identity_roles') || normalized.includes('from permissions')) return { rows: [] };
    if (normalized.includes('from workspaces')) return { rows: this.accounts.getWorkspaceRows(String(params[0] ?? '')) };
    if (normalized.includes('from agents where id=')) {
      // routes.ts 的 SQL 为 `WHERE id=$1 AND identity_id=$2`（params[0]=agentId、params[1]=identityId），
      // 与 findAgentRow(identityId, agentId) 的签名顺序相反，此处显式换位。
      const agentId = String(params[0] ?? '');
      const identityId = String(params[1] ?? '');
      const agent = this.accounts.findAgentRow(identityId, agentId);
      return { rows: agent ? [agent] : [] };
    }
    if (normalized.includes('from agents')) return { rows: this.accounts.getAgentRows(String(params[0] ?? '')) };
    if (normalized.includes('from models where id=')) {
      const modelId = String(params[0] ?? '');
      return { rows: this.models.filter((model) => model.id === modelId && model.enabled).map(({ id, provider, base_url }) => ({ id, provider, base_url })) };
    }
    if (normalized.includes('from models')) return { rows: this.models.filter((model) => model.enabled) };
    if (normalized.includes('from tasks')) return { rows: [] };
    return { rows: [] };
  }

  async connect(): Promise<{ query: (sql: string, params?: readonly unknown[]) => Promise<QueryResult>; release: () => void }> {
    return { query: (sql, params) => this.query(sql, params), release: () => undefined };
  }
}
