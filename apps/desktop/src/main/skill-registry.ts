import type Database from 'better-sqlite3';
import { getLogger } from './logger';

export type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  promptMd: string | null;
  requiredCapabilities: string[];
  enabled: boolean;
  isBuiltin: boolean;
};

export type SkillBinding = {
  agentDefinitionId: string;
  agentDefinitionVersion: string;
  skillId: string;
  ordinal: number;
};

export class SkillRegistry {
  constructor(private db: Database.Database) {}

  listSkills(definitionId?: string, definitionVersion?: string): SkillDefinition[] {
    if (definitionId && definitionVersion) {
      return this.db.prepare(
        `SELECT s.id, s.name, s.description, s.prompt_md as promptMd,
                s.required_capabilities_json as requiredCapabilitiesJson,
                s.enabled, s.is_builtin as isBuiltin
         FROM skills s
         JOIN agent_skills a ON a.skill_id = s.id
         WHERE a.agent_definition_id = ? AND a.agent_definition_version = ?
         ORDER BY a.ordinal`,
      ).all(definitionId, definitionVersion) as SkillDefinition[];
    }

    return this.db.prepare(
      `SELECT id, name, description, prompt_md as promptMd,
              required_capabilities_json as requiredCapabilitiesJson,
              enabled, is_builtin as isBuiltin
       FROM skills WHERE enabled = 1
       ORDER BY name`,
    ).all() as SkillDefinition[];
  }

  getSkill(skillId: string): SkillDefinition | null {
    const row = this.db.prepare(
      `SELECT id, name, description, prompt_md as promptMd,
              required_capabilities_json as requiredCapabilitiesJson,
              enabled, is_builtin as isBuiltin
       FROM skills WHERE id = ?`,
    ).get(skillId) as SkillDefinition | null;
    return row ?? null;
  }

  getBindings(definitionId: string, definitionVersion: string): SkillBinding[] {
    return this.db.prepare(
      'SELECT agent_definition_id as agentDefinitionId, agent_definition_version as agentDefinitionVersion, skill_id as skillId, ordinal FROM agent_skills WHERE agent_definition_id = ? AND agent_definition_version = ? ORDER BY ordinal',
    ).all(definitionId, definitionVersion) as SkillBinding[];
  }

  /** 种子数据：安装内置技能 */
  seedBuiltinSkills(): void {
    const logger = getLogger();
    const now = new Date().toISOString();

    const orchestratorSkills = [
      {
        id: 'skill.team-planning',
        name: 'team-planning',
        description: '团队规划与任务拆分：分析用户需求，判断是否需要委派子智能体',
        promptMd: `## 团队规划 (Team Planning)

作为统筹智能体，你的核心职责是：
1. 分析用户输入，判断是否需要动用子智能体
2. 如果需要知识管理相关能力，明确回复 "NEED_KM" 作为首行
3. 对于不需要子智能体的任务，直接规划回答策略
4. 对复杂任务进行步骤拆解`,
        requiredCapabilities: ['read:message', 'read:knowledge'],
      },
      {
        id: 'skill.result-synthesis',
        name: 'result-synthesis',
        description: '结果汇总与合成：收集子智能体输出，生成统一回复',
        promptMd: `## 结果汇总 (Result Synthesis)

当收到子智能体的返回结果后：
1. 仔细阅读子智能体的输出内容
2. 提取关键信息，进行归纳总结
3. 用清晰的结构化 Markdown 呈现最终回答
4. 注明信息来源（如来自知识库查询）`,
        requiredCapabilities: ['read:message'],
      },
    ];

    const knowledgeManagerSkills = [
      {
        id: 'skill.document-ingestion',
        name: 'document-ingestion',
        description: '文档导入与解析：处理上传文件，提取文本内容',
        promptMd: `## 文档导入 (Document Ingestion)

负责将上传的文件解析为可处理的文本：
1. 检查文件格式和大小
2. 调用解析器提取文本内容
3. 对过长文档进行分块处理
4. 保存原始文件引用`,
        requiredCapabilities: ['read:file', 'write:knowledge'],
      },
      {
        id: 'skill.entity-relation-extraction',
        name: 'entity-relation-extraction',
        description: '实体与关系抽取：从文档中提取知识图谱实体和关系',
        promptMd: `## 实体关系抽取 (Entity & Relation Extraction)

从文档内容中提取结构化知识：
1. 识别关键实体（人物、组织、概念、术语等）
2. 抽取实体之间的关系
3. 为每个实体和关系标注置信度
4. 低置信度候选手动复核`,
        requiredCapabilities: ['read:knowledge', 'write:knowledge'],
      },
      {
        id: 'skill.provenance-validation',
        name: 'provenance-validation',
        description: '来源溯源与验证：确保知识可追溯到原始文档',
        promptMd: `## 来源溯源 (Provenance Validation)

确保每个知识片段都有清晰来源：
1. 记录每个实体/关系对应的原始文档位置
2. 过滤低置信度（<0.65）的候选
3. 将待复核候选写入 review 目录
4. 支持来源回溯查询`,
        requiredCapabilities: ['read:file', 'write:knowledge'],
      },
      {
        id: 'skill.wiki-materialization',
        name: 'wiki-materialization',
        description: 'Wiki 页面生成：基于图谱生成可读的 Wiki 页面',
        promptMd: `## Wiki 页面生成 (Wiki Materialization)

基于知识图谱生成人类可读的 Wiki 页面：
1. 为每个重要实体生成 Wiki 条目
2. 包含实体摘要、关联关系和相关来源
3. 使用 Markdown 格式输出
4. 保存到工作区的 wiki 目录`,
        requiredCapabilities: ['write:knowledge', 'write:output'],
      },
      {
        id: 'skill.graph-projection',
        name: 'graph-projection',
        description: '图谱可视化投影：生成前端可用的图谱可视化数据',
        promptMd: `## 图谱可视化 (Graph Projection)

生成适合前端渲染的图谱投影数据：
1. 导出所有节点和边
2. 为每个节点添加 label 和分组信息
3. 生成 force-graph 格式的 JSON
4. 保存到 knowledge/projection 目录`,
        requiredCapabilities: ['read:knowledge'],
      },
    ];

    const insertSkill = this.db.prepare(
      `INSERT OR IGNORE INTO skills (id, name, description, prompt_md, required_capabilities_json, enabled, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    );

    const bindSkill = this.db.prepare(
      `INSERT OR IGNORE INTO agent_skills (agent_definition_id, agent_definition_version, skill_id, ordinal)
       VALUES (?, ?, ?, ?)`,
    );

    const transaction = this.db.transaction(() => {
      for (const skill of orchestratorSkills) {
        insertSkill.run(skill.id, skill.name, skill.description, skill.promptMd, JSON.stringify(skill.requiredCapabilities), now, now);
        bindSkill.run('builtin.orchestrator', '1.0.0', skill.id, orchestratorSkills.indexOf(skill));
      }

      for (const skill of knowledgeManagerSkills) {
        insertSkill.run(skill.id, skill.name, skill.description, skill.promptMd, JSON.stringify(skill.requiredCapabilities), now, now);
        bindSkill.run('builtin.knowledge-manager', '1.0.0', skill.id, knowledgeManagerSkills.indexOf(skill));
      }
    });

    transaction();
    logger?.info('SkillRegistry: 内置技能种子数据已安装');
  }
}