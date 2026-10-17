import type { ComputeView } from './ComputeSection';

export type WorkstationSection = 'home' | 'apps' | 'sany' | 'projects' | 'knowledge' | 'agents' | 'memory' | 'compute' | 'chats' | 'settings';
export type SearchTarget =
  | { kind: 'page'; section: WorkstationSection; agentView?: 'manage' | 'skills' | 'tools'; settingsView?: 'channels' | 'members' | 'profile' | 'appearance' | 'ops'; computeView?: ComputeView }
  | { kind: 'tasks'; taskId?: string; create?: boolean }
  | { kind: 'project'; id: string }
  | { kind: 'chat'; id: string; projectId?: string }
  | { kind: 'agent'; name: string }
  | { kind: 'create-project' }
  | { kind: 'create-chat' };
export type QuickSearchEntry = { id: string; title: string; description: string; keywords: string; category: string; section: WorkstationSection; target: SearchTarget; adminOnly?: boolean };

export const featureSearchEntries: QuickSearchEntry[] = [
  { id: 'home', title: '首页', description: '总览主页与快捷功能入口', keywords: '总览 工作台 首页 home', category: '功能', section: 'home', target: { kind: 'page', section: 'home' } },
  { id: 'tasks', title: '统一任务', description: '我的待办与全部任务，标记完成或删除', keywords: '我的任务 待办 完成 删除 todo task', category: '功能', section: 'home', target: { kind: 'tasks' } },
  { id: 'create-task', title: '新建任务', description: '创建当前身份的手动待办', keywords: '添加任务 创建任务 安排工作 todo task', category: '功能', section: 'home', target: { kind: 'tasks', create: true } },
  { id: 'projects', title: '项目与群组', description: '项目工作区与关联群组', keywords: '项目管理 项目列表 工作空间 project workspace', category: '功能', section: 'projects', target: { kind: 'page', section: 'projects' } },
  { id: 'create-project', title: '创建项目', description: '新建一个项目工作区', keywords: '新建项目 添加项目 project', category: '功能', section: 'projects', target: { kind: 'create-project' } },
  { id: 'create-chat', title: '创建群组', description: '选择项目和智能体建立协作群组', keywords: '新建群组 新建群聊 添加群组 chat', category: '功能', section: 'chats', target: { kind: 'create-chat' } },
  { id: 'chats', title: '群聊工作空间', description: '与智能体小组对话、查看执行记录及产物', keywords: '聊天 会话 协作 消息 文件 chat', category: '功能', section: 'chats', target: { kind: 'page', section: 'chats' } },
  { id: 'knowledge', title: '知识库', description: '知识库管理、文档上传与检索', keywords: '知识 文件 文档 上传 切片 检索 knowledge', category: '功能', section: 'knowledge', target: { kind: 'page', section: 'knowledge' } },
  { id: 'agents', title: '智能体管理', description: '管理智能体、挂载模型及配置技能', keywords: '智能体 agent bot 助手 模型挂载 技能管理 挂载技能', category: '功能', section: 'agents', target: { kind: 'page', section: 'agents', agentView: 'manage' } },
  { id: 'skills', title: '技能管理', description: '查看技能目录与启用状态', keywords: '技能 skill skills', category: '功能', section: 'agents', target: { kind: 'page', section: 'agents', agentView: 'skills' } },
  { id: 'tools', title: '工具管理', description: '查看服务端与本地执行工具', keywords: '工具 tool tools 执行工具', category: '功能', section: 'agents', target: { kind: 'page', section: 'agents', agentView: 'tools' } },
  { id: 'memory', title: '记忆', description: '浏览长期、短期记忆及群组和智能体范围', keywords: '长期记忆 短期记忆 背景 memory', category: '功能', section: 'memory', target: { kind: 'page', section: 'memory' } },
  { id: 'compute', title: '算力与积分', description: '积分余额、账户额度与算力概览', keywords: '算力 仪表盘 积分 余额 额度 计费 compute dashboard', category: '功能', section: 'compute', target: { kind: 'page', section: 'compute', computeView: 'dashboard' } },
  { id: 'keys', title: 'API 密钥', description: '创建、管理与停用模型调用密钥', keywords: 'apikey api key token 密钥 令牌', category: '功能', section: 'compute', target: { kind: 'page', section: 'compute', computeView: 'keys' } },
  { id: 'usage', title: '使用记录', description: '算力使用量与消费明细', keywords: '调用记录 用量 日志 账单 usage token 消费', category: '功能', section: 'compute', target: { kind: 'page', section: 'compute', computeView: 'usage' } },
  { id: 'market', title: '模型广场', description: '模型列表、能力与可用状态', keywords: '模型市场 模型矩阵 大模型 model market', category: '功能', section: 'compute', target: { kind: 'page', section: 'compute', computeView: 'market' } },
  { id: 'settings', title: '平台设置', description: '渠道、个人信息、外观及运维设置', keywords: '配置 设置 settings', category: '功能', section: 'settings', target: { kind: 'page', section: 'settings', settingsView: 'channels' } },
  { id: 'channels', title: '渠道管理', description: '模型接入渠道与连接配置', keywords: '渠道 模型 服务商 channel provider', category: '功能', section: 'settings', target: { kind: 'page', section: 'settings', settingsView: 'channels' } },
  { id: 'profile', title: '个人信息', description: '修改昵称、头像与个人资料', keywords: '昵称 头像 用户 账号 个人 profile nickname', category: '功能', section: 'settings', target: { kind: 'page', section: 'settings', settingsView: 'profile' } },
  { id: 'appearance', title: '外观设置', description: '主题、紧凑模式与减少动画', keywords: '外观 主题 深色 浅色 动画 theme appearance', category: '功能', section: 'settings', target: { kind: 'page', section: 'settings', settingsView: 'appearance' } },
  { id: 'ops', title: '运维管理', description: '执行设备与服务运行状态', keywords: '运维 设备 本地执行 服务 状态 operations', category: '功能', section: 'settings', target: { kind: 'page', section: 'settings', settingsView: 'ops' } },
  { id: 'members', title: '成员管理', description: '企业成员、角色与权限', keywords: '成员 管理员 用户 角色 权限 邀请 企业 member', category: '功能', section: 'settings', adminOnly: true, target: { kind: 'page', section: 'settings', settingsView: 'members' } },
  { id: 'compute-members', title: '成员积分管理', description: '企业成员的算力额度分配', keywords: '成员 积分 分配 回收 额度 企业', category: '功能', section: 'compute', adminOnly: true, target: { kind: 'page', section: 'compute', computeView: 'members' } },
];

const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim();
export function searchQuickEntries(entries: QuickSearchEntry[], query: string, currentSection: WorkstationSection): QuickSearchEntry[] {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  const score = (entry: QuickSearchEntry): number => {
    const title = normalized(entry.title);
    return (title === normalized(query) && terms.length ? 100 : 0) + terms.reduce((sum, term) => sum + (title.startsWith(term) ? 30 : title.includes(term) ? 20 : 0), 0) + (entry.section === currentSection ? 5 : 0);
  };
  return entries.filter(entry => (!terms.length ? entry.category === '功能' : terms.every(term => normalized(`${entry.title} ${entry.description} ${entry.keywords}`).includes(term))))
    .sort((a, b) => score(b) - score(a)).slice(0, 50);
}
