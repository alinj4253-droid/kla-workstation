import {
  Activity,
  Bot,
  BrainCircuit,
  Cable,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Cpu,
  ExternalLink,
  Gauge,
  Info,
  Loader2,
  MessageSquareMore,
  Monitor,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  TestTube2,
  UserCheck,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
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
          <NavLink to="/settings/assistants" className={secondaryNavClass}><UserCheck size={17} /><span>助手管理</span></NavLink>
          <NavLink to="/settings/models" className={secondaryNavClass}><BrainCircuit size={17} /><span>模型管理</span></NavLink>
          <NavLink to="/settings/capabilities" className={secondaryNavClass}><Puzzle size={17} /><span>能力扩展</span></NavLink>
          <NavLink to="/settings/channels" className={secondaryNavClass}><Cable size={17} /><span>渠道</span></NavLink>
          <button className="settings-nav-link settings-nav-link--disabled" type="button" disabled title="即将上线"><Cpu size={17} /><span>算力</span><em>即将上线</em></button>
        </nav>
        <p>工作区</p>
        <nav aria-label="工作区设置菜单">
          <NavLink to="/settings/appearance" className={secondaryNavClass}><Monitor size={17} /><span>外观</span></NavLink>
          <NavLink to="/settings/system" className={secondaryNavClass}><Settings2 size={17} /><span>系统</span></NavLink>
          <NavLink to="/settings/about" className={secondaryNavClass}><Info size={17} /><span>关于</span></NavLink>
        </nav>
        <div className="settings-sidebar-note"><ShieldCheck size={16} /><div><strong>本地优先</strong><span>配置与运行记录保存在当前 K_Studio。</span></div></div>
      </aside>
      <section className="settings-content">
        <Routes>
          <Route path="agents" element={<AgentsSettings />} />
          <Route path="assistants" element={<AssistantsSettings />} />
          <Route path="models" element={<ModelsSettings />} />
          <Route path="capabilities" element={<CapabilitiesSettings />} />
          <Route path="channels" element={<ChannelsSettings />} />
          <Route path="appearance" element={<AppearanceSettings />} />
          <Route path="system" element={<SystemSettings />} />
          <Route path="about" element={<AboutSettings />} />
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
  const [tab, setTab] = useState<'providers' | 'profiles'>('providers');
  const [providers, setProviders] = useState<Record<string, unknown>[]>([]);
  const [profiles, setProfiles] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; latencyMs: number; error?: string }>>({});
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [pr, pf] = await Promise.all([
        (window.kunqing?.models.listProviders() as Promise<{ ok: boolean; data: Record<string, unknown>[] }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
        (window.kunqing?.models.listProfiles() as Promise<{ ok: boolean; data: Record<string, unknown>[] }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
      ]);
      setProviders(pr.data ?? []);
      setProfiles(pf.data ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const testProvider = async (id: string): Promise<void> => {
    setTestingId(id);
    try {
      const res = await (window.kunqing?.models.testProvider({ providerId: id }) as Promise<{ ok: boolean; data: { success: boolean; latencyMs: number; error?: string } }> | undefined);
      if (res?.data) setTestResult(prev => ({ ...prev, [id]: res.data }));
    } catch {
      setTestResult(prev => ({ ...prev, [id]: { success: false, latencyMs: 0, error: '调用失败' } }));
    }
    setTestingId(null);
  };

  return (
    <div className="settings-page">
      <SettingsHeading
        title="模型管理"
        description="管理模型供应商和模型 Profile，将模型分配给智能体槽位。"
        action={<a className="text-link" href="https://platform.openai.com/docs" target="_blank" rel="noreferrer">查看配置指南 <ExternalLink size={13} /></a>}
      />
      <div className="settings-tabs">
        <button type="button" className={`settings-tab${tab === 'providers' ? ' settings-tab--active' : ''}`} onClick={() => setTab('providers')}>供应商</button>
        <button type="button" className={`settings-tab${tab === 'profiles' ? ' settings-tab--active' : ''}`} onClick={() => setTab('profiles')}>模型配置</button>
      </div>
      {loading ? (
        <div className="settings-loading"><Loader2 size={20} className="spin" /> 加载中...</div>
      ) : tab === 'providers' ? (
        <>
          <div className="model-provider-grid">
            {providers.length === 0 && <p className="model-empty">尚未添加供应商</p>}
            {providers.map((p) => {
              const result = testResult[p.id as string];
              return (
              <article className="model-provider-card" key={p.id as string}>
                <header>
                  <span className="model-provider-badge">{p.type as string}</span>
                  <span className={`connection-status connection-status--${(p.status as string) === 'available' ? 'ok' : 'off'}`}>
                    {(p.status as string) === 'available' ? '可用' : '未知'}
                  </span>
                </header>
                <h3>{p.name as string}</h3>
                <p className="model-provider-url">{(p.baseUrl as string) ?? '默认地址'}</p>
                <footer>
                  <div className="model-provider-actions">
                    {result && (
                      <span className={`test-badge test-badge--${result.success ? 'ok' : 'error'}`}>
                        {result.success ? `连通 (${result.latencyMs}ms)` : (result.error ?? '测试失败')}
                      </span>
                    )}
                    <button type="button" className="secondary-button secondary-button--small" onClick={() => void testProvider(p.id as string)} disabled={testingId === p.id}>
                      {testingId === p.id ? '测试中…' : '测试连接'}
                    </button>
                  </div>
                </footer>
              </article>);
            })}
          </div>
          <button type="button" className="add-agent-button" onClick={() => setProviderDialogOpen(true)}><Plus size={17} /> 添加供应商</button>
          {providerDialogOpen && <ProviderDialog onClose={() => setProviderDialogOpen(false)} onSaved={() => { setProviderDialogOpen(false); void load(); }} />}
        </>
      ) : (
        <ProfilesTab profiles={profiles} providers={providers} onRefresh={load} />
      )}
      {profileDialogOpen && <ProfileDialog providers={providers} onClose={() => setProfileDialogOpen(false)} onSaved={() => { setProfileDialogOpen(false); void load(); }} />}
    </div>
  );
}

function ProviderDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [type, setType] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [authType, setAuthType] = useState('api-key');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await window.kunqing?.models.saveProvider({ name: name.trim(), type, baseUrl: baseUrl.trim() || 'https://api.openai.com/v1', authType });
      onSaved();
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="model-dialog" onSubmit={(e) => void submit(e)}>
        <header>
          <div><h3>添加供应商</h3><p>供应商是模型 API 的提供方，如 OpenAI、Ollama 等。</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <label><span>名称 *</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的 OpenAI" /></label>
        <label><span>类型</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="openai">OpenAI Compatible</option>
            <option value="anthropic">Anthropic</option>
            <option value="google">Google AI</option>
            <option value="ollama">Ollama</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label><span>API 地址</span><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></label>
        <label><span>认证方式</span>
          <select value={authType} onChange={(e) => setAuthType(e.target.value)}>
            <option value="api-key">API Key</option>
            <option value="none">无认证</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </form>
    </div>
  );
}

function ProfileDialog({ providers, onClose, onSaved }: { providers: Record<string, unknown>[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [modelSlot, setModelSlot] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || !providerId || !modelId.trim()) return;
    setSaving(true);
    try {
      await window.kunqing?.models.saveProfile({ name: name.trim(), providerId, modelId: modelId.trim(), modelSlot });
      onSaved();
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="model-dialog" onSubmit={(e) => void submit(e)}>
        <header>
          <div><h3>添加模型 Profile</h3><p>Profile 绑定供应商和具体模型 ID，可选分配到智能体槽位。</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <label><span>名称 *</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：GPT-4o 快速" /></label>
        <label><span>供应商 *</span>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">-- 选择供应商 --</option>
            {providers.map((p) => <option key={p.id as string} value={p.id as string}>{p.name as string}</option>)}
          </select>
        </label>
        <label><span>模型 ID *</span><input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="例如：gpt-4o" /></label>
        <label><span>分配槽位</span>
          <select value={modelSlot} onChange={(e) => setModelSlot(e.target.value)}>
            <option value="">不分配</option>
            <option value="reasoning">推理 (reasoning)</option>
            <option value="fast">快速 (fast)</option>
            <option value="embedding">嵌入 (embedding)</option>
          </select>
        </label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || !name.trim() || !providerId || !modelId.trim()}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </form>
    </div>
  );
}

function ProfilesTab({ profiles, providers, onRefresh }: { profiles: Record<string, unknown>[]; providers: Record<string, unknown>[]; onRefresh: () => Promise<void> }): React.JSX.Element {
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  const [assigningProfileId, setAssigningProfileId] = useState('');

  const slotLabels: Record<string, string> = { reasoning: '推理 (reasoning)', fast: '快速 (fast)', embedding: '嵌入 (embedding)' };

  const currentBindings: Record<string, { profileName: string; profileId: string }> = {};
  for (const p of profiles) {
    const slot = p.modelSlot as string | null;
    if (slot) currentBindings[slot] = { profileName: p.name as string, profileId: p.id as string };
  }

  const setSlot = async (slot: string, profileId: string): Promise<void> => {
    try {
      await window.kunqing?.models.setSlot({ slot, modelProfileId: profileId });
      await onRefresh();
    } catch { /* ignore */ }
    setEditingSlot(null);
  };

  return (
    <div>
      <div className="slot-binding-section">
        <h4>智能体槽位绑定</h4>
        <p className="slot-hint">将模型 Profile 分配到各槽位，智能体将使用对应模型执行任务。</p>
        {Object.entries(slotLabels).map(([slot, label]) => (
          <div className="slot-row" key={slot}>
            <span className="slot-label">{label}</span>
            {editingSlot === slot ? (
              <div className="slot-edit">
                <select value={assigningProfileId} onChange={(e) => setAssigningProfileId(e.target.value)}>
                  <option value="">-- 选择 Profile --</option>
                  {profiles.map((p) => <option key={p.id as string} value={p.id as string}>{p.name as string}</option>)}
                </select>
                <button type="button" className="primary-button primary-button--small" onClick={() => void setSlot(slot, assigningProfileId)} disabled={!assigningProfileId}>确认</button>
                <button type="button" className="secondary-button secondary-button--small" onClick={() => setEditingSlot(null)}>取消</button>
              </div>
            ) : (
              <div className="slot-value">
                <span className={currentBindings[slot] ? '' : 'slot-unset'}>{currentBindings[slot]?.profileName ?? '未设置'}</span>
                <button type="button" className="secondary-button secondary-button--small" onClick={() => { setEditingSlot(slot); setAssigningProfileId(currentBindings[slot]?.profileId ?? ''); }}>更换</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="model-profile-header">
        <h4>已保存的 Profile</h4>
        <button type="button" className="secondary-button secondary-button--small" onClick={() => void onRefresh()}><RefreshCw size={14} /> 刷新</button>
      </div>
      <div className="model-profile-list">
        {profiles.length === 0 && <p className="model-empty">尚未添加模型 Profile</p>}
        {profiles.map((p) => (
          <div className="model-profile-row" key={p.id as string}>
            <strong>{p.name as string}</strong>
            <span className="profile-provider">{(p.providerName as string) ?? p.providerId as string}</span>
            <span className="profile-model">{p.modelId as string}</span>
            <span className="profile-slot">{(p.modelSlot as string) ? slotLabels[p.modelSlot as string] ?? (p.modelSlot as string) : '未分配'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaceholderSettings({ title, description }: { title: string; description: string }): React.JSX.Element {
  return <div className="settings-page"><SettingsHeading title={title} description={description} /><div className="file-empty" style={{ padding: '80px 40px', textAlign: 'center' }}><ShieldCheck size={38} /><strong>功能开发中</strong><span>此设置页面将在后续版本中实现。</span></div></div>;
}

function AssistantsSettings(): React.JSX.Element {
  return <PlaceholderSettings title="助手管理" description="管理已保存的智能体 Profile，编辑显示名、描述、默认模型和技能开关。" />;
}

function CapabilitiesSettings(): React.JSX.Element {
  return <PlaceholderSettings title="能力扩展" description="管理内置 Skill、Tool 和 MCP Server 配置，控制智能体可用的扩展能力。" />;
}

function AppearanceSettings(): React.JSX.Element {
  return <PlaceholderSettings title="外观" description="切换亮色 / 暗色 / 跟随系统主题。" />;
}

function SystemSettings(): React.JSX.Element {
  return <PlaceholderSettings title="系统" description="K_Studio 根目录、完整性检查、日志级别、导出诊断包。" />;
}

function AboutSettings(): React.JSX.Element {
  return <PlaceholderSettings title="关于" description="版本、构建号、Electron / Chromium / Node 版本与开源许可。" />;
}

function ChannelsSettings(): React.JSX.Element {
  const [channels, setChannels] = useState(channelSeed);
  const toggle = (id: string): void => setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, enabled: !channel.enabled } : channel));
  return <div className="settings-page channels-page"><SettingsHeading title="渠道配置" description="连接 Telegram、飞书、钉钉和企业微信群机器人，让群聊可从本地工作站收发消息。" /><div className="channel-guide"><span><b>1</b><CheckCircle2 size={14} /> 选择一个渠道并完成凭据配置</span><span><b>2</b><Activity size={14} /> 启用后在本机常驻监听，由群聊 Leader 处理消息</span></div><div className="channel-dashboard"><div className="channel-list">{channels.map((channel) => <article className="channel-row" key={channel.id}><button type="button" className="channel-expand" aria-label={`展开 ${channel.name}`}><ChevronDown size={15} /></button><span className="channel-icon">{channel.icon}</span><div><strong>{channel.name}</strong><span>{channel.detail}</span></div><em className={`channel-tag channel-tag--${channel.enabled ? 'ok' : 'off'}`}>{channel.status}</em><button type="button" role="switch" aria-checked={channel.enabled} className={`toggle-switch${channel.enabled ? ' toggle-switch--on' : ''}`} onClick={() => toggle(channel.id)}><span /></button></article>)}</div><aside className="realtime-card"><header><h3>实时概览</h3><Gauge size={18} /></header><div><span><small>今日请求</small><strong>1,284</strong><em>+12%</em></span><span><small>连接渠道</small><strong>{channels.filter((channel) => channel.enabled).length}/4</strong><em>运行正常</em></span></div><div className="mini-chart">{[26,42,38,58,83,56,43].map((height, index) => <i key={index} style={{ height }} className={index === 4 ? 'active' : ''} />)}</div></aside></div><div className="channel-bottom"><article><header><h3>最近动态</h3><button type="button">查看全部</button></header><ul><li><i className="summary-dot summary-dot--ok" /><span><strong>Telegram 收到新消息</strong><small>12 秒前 · 已转交群聊 Leader</small></span></li><li><i className="summary-dot summary-dot--danger" /><span><strong>飞书连接需要重新验证</strong><small>45 分钟前 · 凭据已过期</small></span></li><li><i className="summary-dot" /><span><strong>微信外发测试完成</strong><small>2 小时前 · 已成功送达</small></span></li></ul></article><aside><CircleHelp size={19} /><div><strong>需要帮助配置渠道？</strong><span>查看本地部署与凭据保管指南</span></div><button type="button"><ExternalLink size={14} /></button></aside></div></div>;
}
