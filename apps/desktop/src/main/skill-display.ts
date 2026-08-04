const SKILL_LABELS: Record<string, string> = {
  'knowledge:search': '知识检索',
  'workspace:readFile': '工作区文件读取',
  'project:search': '项目全文检索',
  'knowledge:listGraph': '知识图谱查询',
  list_project_agents: '群聊成员查询',
  delegate_tasks: '智能体任务委派',
  publish_artifact: '成果文件发布',
};

export function getSkillDisplayName(name: string): string {
  return SKILL_LABELS[name] ?? (name.replace(/[_:]+/g, ' ').trim() || '工具');
}
