const SKILL_LABELS: Record<string, string> = {
  'knowledge:search': '知识检索',
  'knowledge:readDocument': '完整文件读取',
  'template:list': '模板发现',
  'template:read': '模板读取',
  'template:materialize': '模板套用',
  'workspace:readFile': '工作区文件读取',
  'project:search': '项目全文检索',
  'knowledge:listGraph': '知识图谱查询',
  list_project_agents: '群聊成员查询',
  delegate_tasks: '智能体任务委派',
  publish_artifact: '成果文件发布',
  'skill:load': '技能说明读取',
  'workflow:load': '协同工作流读取',
  'knowledge:ingest': '知识文件处理',
  'knowledge:process': '本地知识化',
  'process-knowledge-files': '知识文件处理',
  'retrieve-knowledge': '混合知识检索',
  'local:ocr': 'PaddleOCR 本地识别',
  'local:embed': '本地知识向量化',
};

export function getSkillDisplayName(name: string): string {
  return SKILL_LABELS[name] ?? (name.replace(/[_:]+/g, ' ').trim() || '工具');
}
