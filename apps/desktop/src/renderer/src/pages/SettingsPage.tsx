import {
  Activity,
  Bot,
  BrainCircuit,
  Cable,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Cloud,
  Cpu,
  Database,
  ExternalLink,
  Gauge,
  Gem,
  MessageSquareMore,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TestTube2,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';

const secondaryNavClass = ({ isActive }: { isActive: boolean }): string => `settings-nav-link${isActive ? ' settings-nav-link--active' : ''}`;

type CliAgent = { id: string; name: string; subtitle: string; status: '可用' | '未安装' | '未登录'; tone: string; uses?: number };

const initialCliAgents: CliAgent[] = [
  { id: 'aion', name: 'Aion CLI', subtitle: '本地统筹与流程编排', status: '可用', tone: 'black', uses: 18 },
  { id: 'auggie', name: 'Auggie', subtitle: '外部智能体连接器', status: '未安装', tone: 'gray' },
  { id: 'claude', name: 'Claude Code', subtitle: '代码分析与研发协作', status: '未登录', tone: 'orange' },
  { id: 'codebuddy', name: 'CodeBuddy', subtitle: '研发辅助智能体', status: '未安装', tone: 'violet' },
  { id: 'codex', name: 'Codex CLI', subtitle: '本地代码任务与仓库协作', status: '未安装', tone: 'slate' },
  { id: 'gemini', name: 'Gemini CLI', subtitle: '通用分析与多模态协作', status: '未安装', tone: 'blue' },
];

const modelSeed = [
  { id: 'deepseek', name: 'DeepSeek', models: 'DeepSeek V3 / R1', connected: true, icon: <BrainCircuit size={21} /> },
  { id: 'openai', name: 'OpenAI', models: 'GPT 系列', connected: true, icon: <Sparkles size={21} /> },
  { id: 'google', name: 'Google', models: 'Gemini 系列', connected: true, icon: <Gem size={21} /> },
  { id: 'glm', name: 'GLM（智谱 AI）', models: 'GLM-4', connected: false, icon: <Database size={21} /> },
  { id: 'kimi', name: 'Kimi（Moonshot AI）', models: 'Moonshot / Kimi', connected: false, icon: <Cloud size={21} /> },
];

const channelSeed = [
  { id: 'telegram', name: 'Telegram', status: 'ACTIVE', enabled: true, icon: <MessageSquareMore size={19} />, detail: 'Bot Long Polling · 双向' },
  { id: 'lark', name: '飞书 / Lark', status: 'CONNECTED', enabled: false, icon: <Webhook size={19} />, detail: 'WebSocket 长连接 · 双向' },
  { id: 'dingtalk', name: '钉钉', status: 'READY', enabled: true, icon: <Zap size={19} />, detail: 'Stream 模式 · 双向' },
  { id: 'wechat', name: '企业微信群机器人', status: 'NOT SET', enabled: false, icon: <MessageSquareMore size={19} />, detail: 'Webhook · 仅出站' },
];

export function SettingsPage(): React.JSX.Element {
  return (
    <div className="settings-layout">
      <aside className="settings-sidebar">
        <p>AI 核心</p>
        <nav aria-label="设置菜单">
          <NavLink to="/settings/agents" className={secondaryNavClass}><Bot size={17} /><span>智能体接入</span></NavLink>
          <NavLink to="/settings/models" className={secondaryNavClass}><BrainCircuit size={17} /><span>模型管理</span></NavLink>
          <NavLink to="/settings/channels" className={secondaryNavClass}><Cable size={17} /><span>渠道</span></NavLink>
          <button className="settings-nav-link settings-nav-link--disabled" type="button" disabled title="即将上线"><Cpu size={17} /><span>算力</span><em>即将上线</em></button>
        </nav>
        <div className="settings-sidebar-note"><ShieldCheck size={16} /><div><strong>本地优先</strong><span>配置与运行记录保存在当前 K_Studio。</span></div></div>
      </aside>
      <section className="settings-content">
        <Routes>
          <Route path="agents" element={<AgentsSettings />} />
          <Route path="models" element={<ModelsSettings />} />
          <Route path="channels" element={<ChannelsSettings />} />
          <Route path="*" element={<Navigate to="/settings/agents" replace />} />
        </Routes>
      </section>
    </div>
  );
}

function SettingsHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }): React.JSX.Element {
  return <header className="settings-heading"><div><h2>{title}</h2><p>{description}</p></div>{action}</header>;
}

function AgentsSettings(): React.JSX.Element {
  const [agents, setAgents] = useState(initialCliAgents);
  const [filter, setFilter] = useState<'全部' | '可用' | '未接入'>('全部');
  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState<string>();
  const [addOpen, setAddOpen] = useState(false);
  const filtered = useMemo(() => agents.filter((agent) => (filter === '全部' || (filter === '可用' ? agent.status === '可用' : agent.status !== '可用')) && agent.name.toLowerCase().includes(query.toLowerCase())), [agents, filter, query]);

  const testAgent = (id: string): void => {
    setTesting(id);
    window.setTimeout(() => {
      setAgents((current) => current.map((agent) => agent.id === id ? { ...agent, status: '可用' } : agent));
      setTesting(undefined);
    }, 650);
  };

  return (
    <div className="settings-page settings-page--agents">
      <SettingsHeading title="智能体接入" description="接入 CLI 智能体或配置内置智能体；外部程序仅在本机以受控子进程运行。" action={<button type="button" className="secondary-button"><RefreshCw size={15} /> 重新检测</button>} />
      <div className="settings-filter-row">
        <div className="segmented-control">{(['全部', '可用', '未接入'] as const).map((item) => <button type="button" className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>{item}<span>{item === '全部' ? agents.length : item === '可用' ? agents.filter((a) => a.status === '可用').length : agents.filter((a) => a.status !== '可用').length}</span></button>)}</div>
        <label className="settings-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索智能体..." /></label>
      </div>
      <div className="agent-connection-list">
        {filtered.map((agent) => <article className="agent-connection-row" key={agent.id}><span className={`connection-icon connection-icon--${agent.tone}`}><TerminalSquare size={18} /></span><div className="connection-copy"><strong>{agent.name}</strong><span>{agent.subtitle}</span></div><span className={`connection-status connection-status--${agent.status === '可用' ? 'ok' : 'off'}`}>{agent.status}</span>{agent.uses && <span className="connection-uses"><Bot size={14} /> +{agent.uses}</span>}<button type="button" className="secondary-button secondary-button--small" onClick={() => testAgent(agent.id)} disabled={testing === agent.id}><TestTube2 size={14} /> {testing === agent.id ? '测试中…' : '测试连接'}</button><button type="button" className="secondary-button secondary-button--small"><Settings2 size={14} /> 编辑</button></article>)}
      </div>
      <button type="button" className="add-agent-button" onClick={() => setAddOpen(true)}><Plus size={17} /> 添加自定义智能体</button>
      {addOpen && <AddAgentDialog onClose={() => setAddOpen(false)} onAdd={(agent) => { setAgents((current) => [...current, agent]); setAddOpen(false); }} />}
    </div>
  );
}

function AddAgentDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (agent: CliAgent) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [executable, setExecutable] = useState('');
  const [args, setArgs] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault(); setSubmitted(true);
    if (!name.trim() || !executable.trim()) return;
    onAdd({ id: `custom-${Date.now()}`, name: name.trim(), subtitle: args ? `自定义参数：${args}` : '自定义本地 CLI 智能体', status: '未登录', tone: 'slate' });
  };
  return <div className="modal-backdrop" role="presentation"><form className="agent-dialog" onSubmit={submit}><header><div><h3>添加自定义智能体</h3><p>保存可执行文件和独立参数，不保存拼接的 Shell 命令。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><label><span>显示名称 *</span><input className={submitted && !name.trim() ? 'input-invalid' : ''} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Codex CLI" /></label><label><span>可执行文件 *</span><input className={submitted && !executable.trim() ? 'input-invalid' : ''} value={executable} onChange={(e) => setExecutable(e.target.value)} placeholder="由用户选择或检测本机路径" /></label><label><span>参数数组（预览）</span><input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="每个参数将在保存时独立解析" /></label><label><span>工作区访问模式</span><select defaultValue="managed-copy"><option value="managed-copy">托管副本（推荐）</option><option value="full-group-workspace">完整群聊工作区（需二次确认）</option></select></label><div className="dialog-warning"><ShieldCheck size={17} /><span>外部 CLI 是受信任的本地程序。托管副本可缩小误操作范围，但不是操作系统沙箱。</span></div><footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">保存并测试</button></footer></form></div>;
}

function ModelsSettings(): React.JSX.Element {
  const [models, setModels] = useState(modelSeed);
  const toggle = (id: string): void => setModels((current) => current.map((model) => model.id === id ? { ...model, connected: !model.connected } : model));
  return <div className="settings-page"><SettingsHeading title="模型管理 (Model Management)" description="连接并验证供应商端点，再将模型 Profile 分配给智能体；密钥不会写入普通配置。" action={<a className="text-link" href="https://platform.openai.com/docs" target="_blank" rel="noreferrer">查看配置指南 <ExternalLink size={13} /></a>} /><div className="model-card-grid">{models.map((model) => <article className="model-card" key={model.id}><header><span className="model-icon">{model.icon}</span><span className={`connection-status connection-status--${model.connected ? 'ok' : 'off'}`}>{model.connected ? '已连接' : '未连接'}</span></header><h3>{model.name}</h3><p>{model.models}</p><footer><button type="button" className="secondary-button">配置</button><button type="button" className={model.connected ? 'danger-button' : 'primary-button'} onClick={() => toggle(model.id)}>{model.connected ? '断开连接' : '立即连接'}</button></footer></article>)}<button type="button" className="custom-model-card"><Plus size={20} /><strong>添加自定义模型</strong><span>OpenAI-compatible / Ollama / vLLM</span></button></div><div className="model-summary"><span><i className="summary-dot summary-dot--ok" /> {models.filter((model) => model.connected).length} 个连接活跃</span><span><i className="summary-dot" /> {models.filter((model) => !model.connected).length} 个待连接</span><button type="button"><TestTube2 size={14} /> 查看连接与功能详情</button></div></div>;
}

function ChannelsSettings(): React.JSX.Element {
  const [channels, setChannels] = useState(channelSeed);
  const toggle = (id: string): void => setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, enabled: !channel.enabled } : channel));
  return <div className="settings-page channels-page"><SettingsHeading title="渠道配置" description="连接 Telegram、飞书、钉钉和企业微信群机器人，让群聊可从本地工作站收发消息。" /><div className="channel-guide"><span><b>1</b><CheckCircle2 size={14} /> 选择一个渠道并完成凭据配置</span><span><b>2</b><Activity size={14} /> 启用后在本机常驻监听，由群聊 Leader 处理消息</span></div><div className="channel-dashboard"><div className="channel-list">{channels.map((channel) => <article className="channel-row" key={channel.id}><button type="button" className="channel-expand" aria-label={`展开 ${channel.name}`}><ChevronDown size={15} /></button><span className="channel-icon">{channel.icon}</span><div><strong>{channel.name}</strong><span>{channel.detail}</span></div><em className={`channel-tag channel-tag--${channel.enabled ? 'ok' : 'off'}`}>{channel.status}</em><button type="button" role="switch" aria-checked={channel.enabled} className={`toggle-switch${channel.enabled ? ' toggle-switch--on' : ''}`} onClick={() => toggle(channel.id)}><span /></button></article>)}</div><aside className="realtime-card"><header><h3>实时概览</h3><Gauge size={18} /></header><div><span><small>今日请求</small><strong>1,284</strong><em>+12%</em></span><span><small>连接渠道</small><strong>{channels.filter((channel) => channel.enabled).length}/4</strong><em>运行正常</em></span></div><div className="mini-chart">{[26,42,38,58,83,56,43].map((height, index) => <i key={index} style={{ height }} className={index === 4 ? 'active' : ''} />)}</div></aside></div><div className="channel-bottom"><article><header><h3>最近动态</h3><button type="button">查看全部</button></header><ul><li><i className="summary-dot summary-dot--ok" /><span><strong>Telegram 收到新消息</strong><small>12 秒前 · 已转交群聊 Leader</small></span></li><li><i className="summary-dot summary-dot--danger" /><span><strong>飞书连接需要重新验证</strong><small>45 分钟前 · 凭据已过期</small></span></li><li><i className="summary-dot" /><span><strong>微信外发测试完成</strong><small>2 小时前 · 已成功送达</small></span></li></ul></article><aside><CircleHelp size={19} /><div><strong>需要帮助配置渠道？</strong><span>查看本地部署与凭据保管指南</span></div><button type="button"><ExternalLink size={14} /></button></aside></div></div>;
}
