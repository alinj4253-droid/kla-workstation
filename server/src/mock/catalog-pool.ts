import type { MemoryAccountRepository } from './memory-account-repository.js';
import { SanyMemoryPool } from './sany-memory-pool.js';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number };

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
  private readonly conversationAgents = new Map<string, Map<string, string>>();
  private readonly tasks = new Map<string, Record<string, unknown>>();

  constructor(private readonly accounts: MemoryAccountRepository) {
    this.sanyPool = new SanyMemoryPool(accounts);
  }

  private readonly sanyPool: SanyMemoryPool;

  hasPermission(identityId: string, action: 'read' | 'write' | 'execute' | 'manage' | 'export'): boolean {
    const permissions = this.accounts.getPermissionCodes(identityId);
    return permissions.includes(action) || (action !== 'manage' && permissions.includes('manage'));
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    if (this.sanyPool.handles(sql)) return this.sanyPool.query(sql, params);
    const normalized = sql.toLowerCase();
    const empty = (): QueryResult => ({ rows: [], rowCount: 0 });
    const result = (rows: Array<Record<string, unknown>>): QueryResult => ({ rows, rowCount: rows.length });
    if (normalized.includes('from organizations where id=')) {
      const row = this.accounts.getOrganizationRow(String(params[0] ?? ''));
      return result(row ? [row] : []);
    }
    if (normalized.includes('from identities i join organizations o')) return result(this.accounts.getOrganizationRowsForUser(String(params[0] ?? '')));
    if (normalized.includes('from identities i join users u')) return result(this.accounts.getMemberRows(String(params[0] ?? '')));
    if (normalized.includes('from roles r left join role_permissions')) return result(this.accounts.getRoleRows(String(params[0] ?? '')));
    if (normalized.includes('from permissions where') || normalized.includes('from permissions')) {
      const requested = Array.isArray(params[0]) ? params[0].map(String) : undefined;
      return result(this.accounts.getPermissionRows(requested));
    }
    if (normalized.includes('from identities where id=$1 and organization_id=')) {
      const identity = this.accounts.getMemberRows(String(params[1] ?? '')).find((row) => row.identity_id === params[0]);
      return result(identity ? [{ id: identity.identity_id }] : []);
    }
    if (normalized.includes('from roles where organization_id=$1 and id=any')) {
      const organizationId = String(params[0] ?? '');
      const roleIds = Array.isArray(params[1]) ? params[1].map(String) : [];
      const rows = this.accounts.getRoleRows(organizationId).filter((row) => roleIds.includes(String(row.id))).map((row) => ({ id: row.id }));
      return result(rows);
    }
    if (normalized.includes('select id,is_system from roles where id=$1 and organization_id=')) {
      const role = this.accounts.getRole(String(params[1] ?? ''), String(params[0] ?? ''));
      return result(role ? [{ id: role.id, is_system: role.isSystem }] : []);
    }
    if (normalized.includes('select 1 from identity_roles where role_id=')) {
      return result(this.accounts.isMockRoleAssigned(String(params[0] ?? '')) ? [{ '?column?': 1 }] : []);
    }
    if (normalized.includes('insert into roles (organization_id,name,description,is_system)')) {
      const role = this.accounts.createMockRole(String(params[0] ?? ''), String(params[1] ?? ''), String(params[2] ?? ''), []);
      return result([{ id: role.id, name: role.name, description: role.description, is_system: role.isSystem }]);
    }
    if (normalized.includes('insert into role_permissions')) {
      const permissions = Array.isArray(params[1]) ? params[1].map(String) : [];
      this.accounts.setRolePermissions(String(params[0] ?? ''), permissions);
      return empty();
    }
    if (normalized.includes('delete from role_permissions where role_id=')) {
      this.accounts.setRolePermissions(String(params[0] ?? ''), []);
      return empty();
    }
    if (normalized.includes('update roles set name=coalesce')) {
      const role = this.accounts.updateMockRole(String(params[1] ?? ''), String(params[0] ?? ''), {
        name: params[2] === null || params[2] === undefined ? null : String(params[2]),
        description: params[3] === null || params[3] === undefined ? null : String(params[3]),
      });
      return result(role ? [{ id: role.id, name: role.name, description: role.description, is_system: role.isSystem }] : []);
    }
    if (normalized.includes('delete from roles where id=$1 and organization_id=$2')) {
      const deleted = this.accounts.deleteMockRole(String(params[1] ?? ''), String(params[0] ?? ''));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    if (normalized.includes('delete from identity_roles where identity_id=')) {
      this.accounts.clearIdentityRoles(String(params[0] ?? ''));
      return empty();
    }
    if (normalized.includes('insert into identity_roles')) {
      const organizationId = String(params[1] ?? '');
      const roleIds = Array.isArray(params[2]) ? params[2].map(String) : [];
      this.accounts.setIdentityRoles(String(params[0] ?? ''), organizationId, roleIds);
      return empty();
    }
    if (normalized.includes('select distinct p.code,p.description from identity_roles')) {
      return result(this.accounts.getPermissionRows(this.accounts.getPermissionCodes(String(params[0] ?? ''))));
    }
    if (normalized.includes('select id, name, status from organizations where id=')) {
      const row = this.accounts.getOrganizationRow(String(params[0] ?? ''));
      return result(row ? [{ id: row.id, name: row.name, status: row.status }] : []);
    }
    if (normalized.includes('from agents a') && normalized.includes('conversation_agents')) {
      const conversationId = String(params[0] ?? '');
      const agents = this.conversationAgents.get(conversationId) ?? new Map<string, string>();
      const rows: Array<Record<string, unknown>> = [...agents.entries()].flatMap(([agentId, role]) => {
        const agent = this.accounts.findAgentRowAny(agentId);
        return agent ? [{ ...agent, conversation_role: role }] : [];
      });
      return result(rows);
    }
    if (normalized.includes('insert into conversation_agents')) {
      const conversationId = String(params[0] ?? '');
      const agents = this.conversationAgents.get(conversationId) ?? new Map<string, string>();
      agents.set(String(params[1] ?? ''), String(params[2] ?? 'member'));
      this.conversationAgents.set(conversationId, agents);
      return empty();
    }
    if (normalized.includes('delete from conversation_agents')) {
      this.conversationAgents.get(String(params[0] ?? ''))?.delete(String(params[1] ?? ''));
      return empty();
    }
    if (normalized.includes('from memories')) return { rows: [] };
    if (normalized.includes('from files')) return { rows: [] };
    if (normalized.includes('from upload_sessions')) return { rows: [] };
    if (normalized.includes('from operation_')) return { rows: [] };
    if (normalized.includes('from meeting_')) return { rows: [] };
    if (normalized.includes('from conversation_run_steps')) return { rows: [] };
    if (normalized.includes('from conversation_agents')) return { rows: [] };
    if (normalized.includes('from identity_roles') || normalized.includes('from permissions')) return empty();
    if (normalized.includes('from workspaces')) return result(this.accounts.getWorkspaceRows(String(params[0] ?? '')));
    if (normalized.includes('from agents where id=')) {
      // routes.ts 的 SQL 为 `WHERE id=$1 AND identity_id=$2`（params[0]=agentId、params[1]=identityId），
      // 与 findAgentRow(identityId, agentId) 的签名顺序相反，此处显式换位。
      const agentId = String(params[0] ?? '');
      const identityId = String(params[1] ?? '');
      const agent = this.accounts.findAgentRow(identityId, agentId);
      return result(agent ? [agent] : []);
    }
    if (normalized.includes('from agents')) return result(this.accounts.getAgentRows(String(params[0] ?? '')));
    if (normalized.includes('from models where id=')) {
      const modelId = String(params[0] ?? '');
      return result(this.models.filter((model) => model.id === modelId && model.enabled).map(({ id, provider, base_url }) => ({ id, provider, base_url })));
    }
    if (normalized.includes('from models')) return result(this.models.filter((model) => model.enabled));
    if (normalized.includes('insert into tasks')) {
      const id = String(params[0]);
      if (this.tasks.has(id)) return empty();
      const row = { id, identity_id: String(params[1]), title: String(params[2]), status: 'pending', result: null, created_at: new Date().toISOString() };
      this.tasks.set(id, row);
      return result([row]);
    }
    if (normalized.includes('update tasks set status=')) {
      const row = this.tasks.get(String(params[0]));
      if (!row || row.identity_id !== params[1] || !['pending', 'completed'].includes(String(row.status))) return empty();
      row.status = String(params[2]);
      return result([row]);
    }
    if (normalized.includes('delete from tasks')) {
      const row = this.tasks.get(String(params[0]));
      if (row?.identity_id === params[1]) this.tasks.delete(String(params[0]));
      return empty();
    }
    if (normalized.includes('from tasks')) {
      if (normalized.includes('where id=$1')) {
        const row = this.tasks.get(String(params[0]));
        return result(row && row.identity_id === params[1] ? [row] : []);
      }
      const rows = [...this.tasks.values()].filter(row => row.identity_id === params[0]);
      return result(rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 50));
    }
    return empty();
  }

  async connect(): Promise<{ query: (sql: string, params?: readonly unknown[]) => Promise<QueryResult>; release: () => void }> {
    return { query: (sql, params) => this.sanyPool.handles(sql) ? this.sanyPool.query(sql, params) : this.query(sql, params), release: () => undefined };
  }
}
