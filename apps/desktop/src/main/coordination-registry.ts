import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DelegatableAgentInfo } from '@kunqing/native-agent-core';
import { loadAgentCoordinationSummary } from './agent-identity';

type CoordinationRow = {
  id: string;
  name: string;
  role: string;
  definitionId: string;
  runtimeMode: string;
  identityRelPath: string | null;
  profileEnabled: number;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function describeAgentCapabilities(definitionId: string, runtimeMode: string, name: string): string {
  if (/邮箱秘书/u.test(name)) return '读取邮件、下载附件并返回邮件事实和附件清单';
  if (definitionId.startsWith('operation-agent-') || /操作智能体/i.test(name)) return '操作绑定平台，选择已生效技能执行网页任务，读取并分析页面结果';
  if (definitionId === 'builtin.orchestrator' || /统筹/i.test(name)) return '还原用户目标、判断任务复杂度、拆解业务 TODO、按依赖调度成员并汇总交付';
  if (definitionId === 'builtin.local-executor' || /本地执行智能体/i.test(name)) return '在自身 loop 内完成知识处理、检索、调研、材料编写、内部核验和成果交付';
  if (definitionId === 'builtin.knowledge-manager' || /知识管理/i.test(name)) return '执行 OCR、标准化、切片、向量、图谱及知识入库';
  if (definitionId === 'builtin.researcher' || /调研|研究/i.test(name)) return '检索和核验公开资料，形成带来源的事实与分析';
  if (definitionId === 'builtin.material-writer' || /材料编写|写作/i.test(name)) return '读取知识和模板，编写并交付规范材料';
  if (definitionId === 'builtin.acceptance-reviewer' || /验收|审核/i.test(name)) return '依据需求和证据验收成果，给出通过或返修结论';
  if (/codebuddy/i.test(`${definitionId} ${name}`)) return '验收代码和本地成果文件，返回明确结论和证据';
  if (/kimi(?:\s|-)?code/i.test(`${definitionId} ${name}`)) return '编写、修改和验证代码，返回真实文件与验证结果';
  if (runtimeMode === 'external-cli' || /code|代码|编程/i.test(`${definitionId} ${name}`)) return '通过外部 CLI 实施代码或文件任务并返回真实结果';
  return '根据角色卡和已授权技能完成专属任务并返回可验收结果';
}

function operationContext(db: Database.Database, definitionId: string): { summary: string; skills: string[]; available: boolean } {
  if (!definitionId.startsWith('operation-agent-')) return { summary: '', skills: [], available: true };
  const platform = db.prepare(
    `SELECT id, name, url, description FROM operation_platforms
     WHERE owner_agent_id = ? AND status = 'active' LIMIT 1`,
  ).get(definitionId) as { id: string; name: string; url: string; description: string } | undefined;
  if (!platform) return { summary: '绑定平台已注销或不可用', skills: [], available: false };
  const skills = db.prepare(
    `SELECT name, description FROM operation_skills
     WHERE platform_id = ? AND status = 'active' AND enabled = 1 ORDER BY updated_at DESC`,
  ).all(platform.id) as Array<{ name: string; description: string }>;
  return {
    summary: `绑定平台：${platform.name}（${platform.url}）；平台说明：${platform.description?.trim() || '未提供'}；已生效技能：${skills.length ? skills.map((skill) => skill.name).join('、') : '暂无'}`,
    skills: skills.map((skill) => `${skill.name}${skill.description?.trim() ? `：${skill.description.trim()}` : ''}`),
    available: true,
  };
}

export function rebuildProjectCoordinationRegistry(db: Database.Database, projectId: string): void {
  const rows = db.prepare(
    `SELECT pai.id, ap.name, pai.role, ap.definition_id as definitionId,
            pai.runtime_mode as runtimeMode, pai.identity_rel_path as identityRelPath,
            ap.enabled as profileEnabled
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? ORDER BY pai.ordinal`,
  ).all(projectId) as CoordinationRow[];
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO project_agent_coordination (
       project_id, agent_instance_id, display_name, role, definition_id, runtime_mode,
       responsibility_summary, domain_tags_json, accepted_task_types_json,
       deliverable_types_json, capability_boundaries_json, skill_summary_json,
       can_self_deliver, can_spawn_parallel, availability, priority, source_hash, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, agent_instance_id) DO UPDATE SET
       display_name=excluded.display_name, role=excluded.role, definition_id=excluded.definition_id,
       runtime_mode=excluded.runtime_mode, responsibility_summary=excluded.responsibility_summary,
       domain_tags_json=excluded.domain_tags_json, accepted_task_types_json=excluded.accepted_task_types_json,
       deliverable_types_json=excluded.deliverable_types_json, capability_boundaries_json=excluded.capability_boundaries_json,
       skill_summary_json=excluded.skill_summary_json, can_self_deliver=excluded.can_self_deliver,
       can_spawn_parallel=excluded.can_spawn_parallel, availability=excluded.availability,
       priority=excluded.priority, source_hash=excluded.source_hash, updated_at=excluded.updated_at`,
  );
  const keep = new Set(rows.map((row) => row.id));
  db.transaction(() => {
    for (const row of rows) {
      const coordination = loadAgentCoordinationSummary(projectId, row.identityRelPath, {
        name: row.name,
        runtimeMode: row.runtimeMode,
        definitionId: row.definitionId,
      });
      const operation = operationContext(db, row.definitionId);
      const capability = describeAgentCapabilities(row.definitionId, row.runtimeMode, row.name);
      const responsibility = [capability, coordination, operation.summary].filter(Boolean).join('\n');
      const isLeader = row.role === 'leader' || row.definitionId === 'builtin.orchestrator';
      const canSelfDeliver = isLeader || row.definitionId === 'builtin.local-executor' || row.definitionId.startsWith('operation-agent-') || /kimi|codebuddy/i.test(`${row.definitionId} ${row.name}`);
      const sourceHash = createHash('sha256').update(`${row.name}\n${row.role}\n${row.definitionId}\n${row.runtimeMode}\n${responsibility}\n${operation.skills.join('\n')}`).digest('hex');
      upsert.run(
        projectId, row.id, row.name, row.role, row.definitionId, row.runtimeMode,
        responsibility, json([]), json([capability]), json(canSelfDeliver ? ['自然语言结果', '真实成果或可验收证据'] : ['阶段结果']),
        json(isLeader ? ['不替代专业成员执行复杂具体工作'] : []), json(operation.skills),
        canSelfDeliver ? 1 : 0, row.definitionId === 'builtin.local-executor' ? 1 : 0,
        row.profileEnabled && operation.available ? 'available' : 'disabled', isLeader ? 0 : 100, sourceHash, now,
      );
    }
    if (keep.size === 0) db.prepare('DELETE FROM project_agent_coordination WHERE project_id = ?').run(projectId);
    else {
      const placeholders = [...keep].map(() => '?').join(',');
      db.prepare(`DELETE FROM project_agent_coordination WHERE project_id = ? AND agent_instance_id NOT IN (${placeholders})`).run(projectId, ...keep);
    }
  })();
}

export function listProjectCoordinationRegistry(db: Database.Database, projectId: string): DelegatableAgentInfo[] {
  let rows = db.prepare(
    `SELECT agent_instance_id as id, display_name as name, role, definition_id as definitionId,
            runtime_mode as runtimeMode, responsibility_summary as coordinationProfile
     FROM project_agent_coordination
     WHERE project_id = ? AND availability IN ('available','busy')
     ORDER BY priority, agent_instance_id`,
  ).all(projectId) as Array<DelegatableAgentInfo & { coordinationProfile: string }>;
  if (rows.length === 0) {
    rebuildProjectCoordinationRegistry(db, projectId);
    rows = db.prepare(
      `SELECT agent_instance_id as id, display_name as name, role, definition_id as definitionId,
              runtime_mode as runtimeMode, responsibility_summary as coordinationProfile
       FROM project_agent_coordination
       WHERE project_id = ? AND availability IN ('available','busy')
       ORDER BY priority, agent_instance_id`,
    ).all(projectId) as Array<DelegatableAgentInfo & { coordinationProfile: string }>;
  }
  return rows.map((row) => ({ ...row, capabilities: row.coordinationProfile }));
}
