import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getLogger } from './logger';

export type WorkflowDefinition = {
  id: string;
  version: string;
  name: string;
  description: string;
  checksum: string;
  ordinal: number;
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * 协同工作流是统筹智能体可选择的业务级编排模板，不是单智能体技能，
 * 也不包含 API 凭据或直接可执行工具实现。
 */
export class WorkflowRegistry {
  constructor(private db: Database.Database) {}

  listForDefinition(definitionId: string, definitionVersion: string): WorkflowDefinition[] {
    try {
      return this.db.prepare(
        `SELECT w.id, w.version, w.name, w.description, w.checksum, b.ordinal
         FROM workflow_packages w
         JOIN agent_definition_workflows b ON b.workflow_id = w.id AND b.workflow_version = w.version
         WHERE b.agent_definition_id = ? AND b.agent_definition_version = ? AND w.enabled = 1
         ORDER BY b.ordinal`,
      ).all(definitionId, definitionVersion) as WorkflowDefinition[];
    } catch {
      return [];
    }
  }

  loadForDefinition(definitionId: string, definitionVersion: string, workflowId: string, workflowVersion?: string): string | null {
    try {
      const row = this.db.prepare(
        `SELECT w.spec_md as specMd
         FROM workflow_packages w
         JOIN agent_definition_workflows b ON b.workflow_id = w.id AND b.workflow_version = w.version
         WHERE b.agent_definition_id = ? AND b.agent_definition_version = ?
           AND w.id = ? AND (? IS NULL OR w.version = ?) AND w.enabled = 1
         ORDER BY b.ordinal LIMIT 1`,
      ).get(definitionId, definitionVersion, workflowId, workflowVersion ?? null, workflowVersion ?? null) as { specMd: string } | undefined;
      return row?.specMd ?? null;
    } catch {
      return null;
    }
  }

  snapshotForRun(runId: string, definitionId: string, definitionVersion: string): WorkflowDefinition[] {
    const workflows = this.listForDefinition(definitionId, definitionVersion);
    try {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM agent_run_workflows WHERE run_id = ?').run(runId);
        const insert = this.db.prepare(
          `INSERT INTO agent_run_workflows (run_id, workflow_id, workflow_version, checksum, snapshot_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const now = new Date().toISOString();
        for (const workflow of workflows) insert.run(runId, workflow.id, workflow.version, workflow.checksum, JSON.stringify(workflow), now);
      })();
    } catch (err) {
      getLogger()?.warn({ err, runId }, 'WorkflowRegistry: Run 工作流快照写入失败');
    }
    return workflows;
  }

  seedBuiltinWorkflows(): void {
    const spec = `# 复杂任务协同交付

按当前业务目标动态决定是否采用此工作流，不要固定分配成员。

1. 澄清目标、输入、交付物和验收标准。
2. 从业务维度拆分可并行和有依赖的工作包。
3. 根据群聊成员的真实能力选择负责人，并通过正式群聊消息委派。
4. 等待各负责人反馈；仅在有信息缺口、风险或阶段成果时发正式消息。
5. 汇总前检查事实、文件和验收标准，发现缺口则继续调度。
6. 对适合归集的任务，安排知识管理智能体整理知识文档、经验和业务流程。
7. 交付成果文件与简洁结论。`;
    const manifest = {
      schemaVersion: 1,
      id: 'collaborative-delivery',
      version: '1.0.0',
      appliesTo: ['builtin.orchestrator'],
      planningMode: 'dynamic-dag',
    };
    const checksum = digest(`${JSON.stringify(manifest)}\n${spec}`);
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `INSERT INTO workflow_packages (id, version, name, description, spec_md, manifest_json, checksum, enabled, created_at, updated_at)
         VALUES ('collaborative-delivery', '1.0.0', '复杂任务协同交付', '按业务目标动态拆分、并行委派、验收和知识归集。', ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id, version) DO UPDATE SET spec_md = excluded.spec_md, manifest_json = excluded.manifest_json,
           checksum = excluded.checksum, updated_at = excluded.updated_at`,
      ).run(spec, JSON.stringify(manifest), checksum, now, now);
      this.db.prepare(
        `INSERT OR IGNORE INTO agent_definition_workflows
           (agent_definition_id, agent_definition_version, workflow_id, workflow_version, ordinal)
         VALUES ('builtin.orchestrator', '1.0.0', 'collaborative-delivery', '1.0.0', 0)`,
      ).run();
    } catch (err) {
      getLogger()?.warn({ err }, 'WorkflowRegistry: 内置工作流安装失败');
    }
  }
}
