import {
  Activity,
  AlertTriangle,
  Bot,
  BrainCircuit,
  Cable,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Copy,
  Cpu,
  ExternalLink,
  FileCode,
  FolderOpen,
  Gauge,
  Globe,
  Info,
  Key,
  Layers,
  Loader2,
  MessageSquareMore,
  Monitor,
  Moon,
  Play,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sun,
  TerminalSquare,
  TestTube2,
  ToggleLeft,
  Trash2,
  UserCheck,
  Webhook,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';

const secondaryNavClass = ({ isActive }: { isActive: boolean }): string => `settings-nav-link${isActive ? ' settings-nav-link--active' : ''}`;
const OPERATIONS_SESSION_KEY = 'kunqing.operationsAccess';
const OPERATIONS_ACCESS_KEY = '123456';

export function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [operationsLoginOpen, setOperationsLoginOpen] = useState(false);
  const [operationsKey, setOperationsKey] = useState('');
  const [operationsLoginError, setOperationsLoginError] = useState('');

  const openOperations = (): void => {
    if (window.sessionStorage.getItem(OPERATIONS_SESSION_KEY) === 'granted') {
      navigate('/settings/operations');
      return;
    }
    setOperationsKey('');
    setOperationsLoginError('');
    setOperationsLoginOpen(true);
  };

  const verifyOperationsAccess = (event: FormEvent): void => {
    event.preventDefault();
    if (operationsKey !== OPERATIONS_ACCESS_KEY) {
      setOperationsLoginError('运维权限密钥错误');
      return;
    }
    window.sessionStorage.setItem(OPERATIONS_SESSION_KEY, 'granted');
    setOperationsLoginOpen(false);
    navigate('/settings/operations');
  };

  return (
    <>
    <div className="settings-layout">
      <aside className="settings-sidebar">
        <p>AI 核心</p>
        <nav aria-label="设置菜单">
          <NavLink to="/settings/agents" className={secondaryNavClass}><Bot size={17} /><span>智能体接入</span></NavLink>
          <NavLink to="/settings/models" className={secondaryNavClass}><BrainCircuit size={17} /><span>模型管理</span></NavLink>
          <NavLink to="/settings/channels" className={secondaryNavClass}><Cable size={17} /><span>渠道</span></NavLink>
          <button className="settings-nav-link settings-nav-link--disabled" type="button" disabled title="即将上线"><Cpu size={17} /><span>算力</span><em>即将上线</em></button>
        </nav>
        <hr className="settings-sidebar-divider" />
        <p>AI 生产力</p>
        <nav aria-label="AI 生产力设置">
          <NavLink to="/settings/skills" className={secondaryNavClass}><Puzzle size={17} /><span>技能</span></NavLink>
          <NavLink to="/settings/tools" className={secondaryNavClass}><Wrench size={17} /><span>工具</span></NavLink>
        </nav>
        <hr className="settings-sidebar-divider" />
        <p>扩展设置</p>
        <nav aria-label="扩展设置">
          <NavLink to="/settings/operations" className={secondaryNavClass} onClick={(event) => { event.preventDefault(); openOperations(); }}><ShieldCheck size={17} /><span>运维管理</span></NavLink>
          <button className="settings-nav-link settings-nav-link--disabled" type="button" disabled title="延后"><Settings2 size={17} /><span>K_Studio</span><em>延后</em></button>
          <button className="settings-nav-link settings-nav-link--disabled" type="button" disabled title="延后"><Sun size={17} /><span>外观</span><em>延后</em></button>
          <button className="settings-nav-link settings-nav-link--disabled" type="button" disabled title="延后"><Server size={17} /><span>系统</span><em>延后</em></button>
          <button className="settings-nav-link settings-nav-link--disabled" type="button" disabled title="延后"><Info size={17} /><span>关于</span><em>延后</em></button>
        </nav>
        <div className="settings-sidebar-note"><ShieldCheck size={16} /><div><strong>本地优先</strong><span>配置与运行记录保存在当前 K_Studio。</span></div></div>
      </aside>
      <section className="settings-content">
        <Routes>
          <Route path="agents" element={<AgentsSettings />} />
          <Route path="models" element={<ModelsSettings />} />
          <Route path="channels" element={<ChannelsSettings />} />
          <Route path="skills" element={<EmptySettingsPage label="技能设置页面" />} />
          <Route path="tools" element={<EmptySettingsPage label="工具设置页面" />} />
          <Route path="operations" element={<OperationsProtectedRoute />} />
          <Route path="kstudio" element={<KStudioSettings />} />
          <Route path="appearance" element={<AppearanceSettings />} />
          <Route path="system" element={<SystemSettings />} />
          <Route path="about" element={<AboutSettings />} />
          <Route path="*" element={<Navigate to="/settings/agents" replace />} />
        </Routes>
      </section>
    </div>
    {operationsLoginOpen && (
      <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOperationsLoginOpen(false)}>
        <form className="operations-login-dialog" role="dialog" aria-modal="true" aria-labelledby="operations-login-title" onSubmit={verifyOperationsAccess}>
          <button type="button" className="icon-button operations-login-dialog__close" aria-label="关闭" onClick={() => setOperationsLoginOpen(false)}><X size={18} /></button>
          <span className="operations-login-dialog__icon"><Key size={22} /></span>
          <h2 id="operations-login-title">运维权限验证</h2>
          <p>请输入运维权限密钥后进入部署与授权配置。</p>
          <label>
            <span>运维权限密钥</span>
            <input autoFocus type="password" value={operationsKey} onChange={(event) => { setOperationsKey(event.target.value); setOperationsLoginError(''); }} placeholder="请输入密钥" />
            {operationsLoginError && <small>{operationsLoginError}</small>}
          </label>
          <button type="submit" className="primary-button">验证并进入</button>
        </form>
      </div>
    )}
    </>
  );
}

function SettingsHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }): React.JSX.Element {
  return <header className="settings-heading"><div><h2>{title}</h2><p>{description}</p></div>{action}</header>;
}

function EmptySettingsPage({ label }: { label: string }): React.JSX.Element {
  return <div className="settings-empty-page" aria-label={label} />;
}

function OperationsProtectedRoute(): React.JSX.Element {
  return window.sessionStorage.getItem(OPERATIONS_SESSION_KEY) === 'granted'
    ? <OperationsSettings />
    : <Navigate to="/settings/agents" replace />;
}

type DeploymentMode = 'saas' | 'private';

function defaultActivationDate(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

function OperationsSettings(): React.JSX.Element {
  const [mode, setMode] = useState<DeploymentMode>('saas');
  const [availableTokens, setAvailableTokens] = useState('1000000');
  const [activationExpiresAt, setActivationExpiresAt] = useState(defaultActivationDate);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    (async (): Promise<void> => {
      try {
        const result = await window.kunqing?.settings.getAll() as { ok: boolean; data?: Record<string, unknown> } | undefined;
        const data = result?.data ?? {};
        if (data.deploymentMode === 'saas' || data.deploymentMode === 'private') setMode(data.deploymentMode);
        const tokenValue = Number(data.operationsAvailableTokens);
        if (Number.isFinite(tokenValue) && tokenValue >= 0) setAvailableTokens(String(Math.floor(tokenValue)));
        if (typeof data.operationsActivationExpiresAt === 'string' && data.operationsActivationExpiresAt) setActivationExpiresAt(data.operationsActivationExpiresAt);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveOperationsSettings = async (): Promise<void> => {
    const tokenValue = Math.max(0, Math.floor(Number(availableTokens) || 0));
    if (mode === 'private' && !activationExpiresAt) {
      setNotice('请选择产品激活有效期');
      return;
    }
    setSaving(true);
    setNotice('');
    const result = await window.kunqing?.settings.update({
      deploymentMode: mode,
      operationsAvailableTokens: tokenValue,
      operationsActivationExpiresAt: activationExpiresAt,
    }) as { ok: boolean } | undefined;
    setSaving(false);
    setNotice(result?.ok ? '运维配置已保存到当前 K_Studio' : '保存失败，请稍后重试');
  };

  return (
    <div className="settings-page operations-settings-page">
      <div className="operations-brand">
        <span><ShieldCheck size={28} /></span>
        <h2>运维管理</h2>
        <p>选择产品交付方式并维护本地授权参数</p>
      </div>

      {loading ? <div className="settings-loading"><Loader2 size={20} className="spin" /> 加载运维配置...</div> : (
        <>
          <div className="operations-deployment-cards" role="radiogroup" aria-label="部署版本">
            <button type="button" role="radio" aria-checked={mode === 'saas'} className={`operations-deployment-card${mode === 'saas' ? ' operations-deployment-card--selected' : ''}`} onClick={() => { setMode('saas'); setNotice(''); }}>
              <span><Globe size={23} /></span>
              <strong>SaaS 版本</strong>
              <p>由平台提供模型额度，运维人员可以调整当前工作站的可用 Token。</p>
              {mode === 'saas' && <CheckCircle2 size={18} className="operations-deployment-card__check" />}
            </button>
            <button type="button" role="radio" aria-checked={mode === 'private'} className={`operations-deployment-card${mode === 'private' ? ' operations-deployment-card--selected' : ''}`} onClick={() => { setMode('private'); setNotice(''); }}>
              <span><Server size={23} /></span>
              <strong>私有化部署版本</strong>
              <p>模型和数据均在私有环境运行，运维人员可以维护产品激活有效期。</p>
              {mode === 'private' && <CheckCircle2 size={18} className="operations-deployment-card__check" />}
            </button>
          </div>

          <section className="operations-config-panel">
            <header><div><strong>{mode === 'saas' ? 'SaaS 额度配置' : '私有化授权配置'}</strong><span>{mode === 'saas' ? '调整后将作为当前工作站的 Token 可用额度。' : '当前仅保存有效期，激活校验机制将在后续版本接入。'}</span></div>{mode === 'saas' ? <Gauge size={19} /> : <Key size={19} />}</header>
            {mode === 'saas' ? (
              <label className="operations-field">
                <span>Token 总量</span>
                <div><input type="number" min="0" step="1000" value={availableTokens} onChange={(event) => { setAvailableTokens(event.target.value); setNotice(''); }} /><small>Token</small></div>
              </label>
            ) : (
              <label className="operations-field">
                <span>产品激活有效期</span>
                <div><input type="date" value={activationExpiresAt} onChange={(event) => { setActivationExpiresAt(event.target.value); setNotice(''); }} /></div>
              </label>
            )}
            <footer>
              {notice && <span className={notice.includes('失败') || notice.includes('请选择') ? 'operations-notice operations-notice--error' : 'operations-notice'}>{notice}</span>}
              <button type="button" className="primary-button" disabled={saving} onClick={() => void saveOperationsSettings()}>{saving ? '保存中...' : '保存运维配置'}</button>
            </footer>
          </section>
        </>
      )}
    </div>
  );
}

interface AgentCardData {
  id: string;
  name: string;
  /** 定义版本 */
  definitionVersion: string;
  /** 运行框架 */
  framework: string;
  /** 模型 Profile */
  modelProfile: string;
  /** 技能列表 */
  skills: string[];
  /** 有效权限 */
  permissions: string[];
  /** 测试状态 */
  testStatus: 'passed' | 'failed' | 'untested';
  /** 被引用群聊数 */
  referencedChats: number;
  /** 是否内置 */
  isBuiltin: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 适配器类型 */
  adapterType?: string;
  /** 可执行文件路径 */
  executablePath?: string;
  /** 检测到的版本 */
  detectedVersion?: string;
}

const MOCK_AGENT_CARDS: AgentCardData[] = [
  { id: 'builtin.orchestrator', name: '统筹管理智能体', definitionVersion: '1.0.0', framework: 'LangGraph.js', modelProfile: 'GPT-4o (默认)', skills: ['任务拆解', '结果汇总', '团队 MCP'], permissions: ['read', 'write', 'delegate'], testStatus: 'passed', referencedChats: 3, isBuiltin: true, enabled: true },
  { id: 'builtin.knowledge-manager', name: '知识管理智能体', definitionVersion: '1.0.0', framework: 'LangGraph.js', modelProfile: 'GPT-4o-mini (默认)', skills: ['文档解析', '知识图谱', 'Wiki 生成'], permissions: ['read', 'write'], testStatus: 'passed', referencedChats: 2, isBuiltin: true, enabled: true },
  { id: 'codex', name: 'Codex CLI', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '终端执行'], permissions: ['read', 'write', 'execute'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'codex', executablePath: 'codex', detectedVersion: '0.1.0' },
  { id: 'claude-code', name: 'Claude Code', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索', '推理'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'claude-code', executablePath: 'claude', detectedVersion: '0.1.0' },
  { id: 'aion', name: 'Aion CLI', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索'], permissions: ['read', 'write', 'delegate'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'aion', executablePath: 'aion', detectedVersion: '0.1.0' },
  { id: 'gemini', name: 'Gemini CLI', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索', '推理'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'gemini', executablePath: 'gemini', detectedVersion: '0.1.0' },
  { id: 'qwen-code', name: 'Qwen Code', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'qwen-code', executablePath: 'qwen-code', detectedVersion: '0.1.0' },
  { id: 'opencode', name: 'Opencode', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索', '网络访问'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'opencode', executablePath: 'opencode', detectedVersion: '0.1.0' },
  { id: 'codegeex', name: 'CodeGeeX', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'codegeex', executablePath: 'codegeex', detectedVersion: '0.1.0' },
  { id: 'kimi', name: 'Kimi', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索', '推理'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'kimi', executablePath: 'kimi', detectedVersion: '0.1.0' },
  { id: 'minimax', name: 'MiniMax', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'minimax', executablePath: 'minimax', detectedVersion: '0.1.0' },
  { id: 'marcode', name: 'MarsCode', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'marcode', executablePath: 'marcode', detectedVersion: '0.1.0' },
  { id: 'codebuddy', name: 'CodeBuddy', definitionVersion: '0.1.0', framework: 'external-cli', modelProfile: '-', skills: ['代码生成', '文件读写', '搜索', '网络访问'], permissions: ['read', 'write'], testStatus: 'untested', referencedChats: 0, isBuiltin: false, enabled: false, adapterType: 'codebuddy', executablePath: 'codebuddy', detectedVersion: '0.1.0' },
];

function AgentsSettings(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentCardData[]>([]);
  const [filter, setFilter] = useState<'内置智能体' | 'CLI 智能体' | '自定义配置'>('内置智能体');
  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState<string>();
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [agentDialog, setAgentDialog] = useState<{ type: 'switchModel' | 'manageSkills' | 'tightenPermissions' | 'cloneProfile'; agent: AgentCardData } | null>(null);

  // 构建卡片的辅助函数，复用逻辑
  const buildCards = useCallback((
    cliData: Array<{ id: string; adapterType: string; executablePath: string; detectedVersion: string | null; status: string }>,
    connData: Array<{ id: string; name: string; adapterType: string; executablePath: string; detectedVersion: string | null; status: string }>,
    profData: Array<{ id: string; name: string; runtimeMode: string; enabled: boolean; definitionId?: string }>,
    defData: Array<{ id: string; version: string; kind: string; isBuiltin: boolean }>
  ): AgentCardData[] => {
    const defMap = new Map(defData.map((d) => [d.id, d]));
    const savedTypes = new Set(connData.map((c) => c.adapterType));

    const cliCards: AgentCardData[] = cliData
      .filter((c) => !savedTypes.has(c.adapterType))
      .map((c) => {
        const card: AgentCardData = {
          id: c.id,
          name: c.adapterType,
          definitionVersion: defMap.get(c.adapterType)?.version ?? '-',
          framework: 'external-cli',
          modelProfile: '-',
          skills: [],
          permissions: [],
          testStatus: 'untested' as const,
          referencedChats: 0,
          isBuiltin: false,
          enabled: false,
          adapterType: c.adapterType,
          executablePath: c.executablePath,
        };
        if (c.detectedVersion != null) card.detectedVersion = c.detectedVersion;
        return card;
      });

    const connCards: AgentCardData[] = connData.map((c) => {
      const card: AgentCardData = {
        id: c.id,
        name: c.name || c.adapterType,
        definitionVersion: defMap.get(c.adapterType)?.version ?? '-',
        framework: 'external-cli',
        modelProfile: '-',
        skills: [],
        permissions: [],
        testStatus: 'untested' as const,
        referencedChats: 0,
        isBuiltin: false,
        enabled: true,
        adapterType: c.adapterType,
        executablePath: c.executablePath,
      };
      if (c.detectedVersion != null) card.detectedVersion = c.detectedVersion;
      return card;
    });

    const profCards: AgentCardData[] = profData
      .filter((p) => p.runtimeMode === 'external-cli' || p.runtimeMode === 'native-model')
      .map((p) => {
        const def = defMap.get(p.definitionId ?? '');
        return {
          id: p.id,
          name: p.name,
          definitionVersion: def?.version ?? '-',
          framework: p.runtimeMode === 'native-model' ? 'LangGraph.js' : 'external-cli',
          modelProfile: '-',
          skills: [],
          permissions: [],
          testStatus: 'passed' as const,
          referencedChats: 0,
          isBuiltin: def?.isBuiltin ?? true,
          enabled: p.enabled,
        };
      });

    return [...connCards, ...cliCards, ...profCards];
  }, []);

  // 只加载已保存的连接，不检测 PATH
  const loadSavedAgents = useCallback(async (): Promise<void> => {
    // 先展示 mock 数据，不显示 loading
    setAgents(MOCK_AGENT_CARDS);

    try {
      const [connRes, profRes, defRes] = await Promise.all([
        (window.kunqing?.agents.listCliConnections() as Promise<{ ok: boolean; data: Array<{ id: string; name: string; adapterType: string; executablePath: string; detectedVersion: string | null; status: string }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
        (window.kunqing?.agents.listProfiles() as Promise<{ ok: boolean; data: Array<{ id: string; name: string; runtimeMode: string; enabled: boolean; definitionId?: string }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
        (window.kunqing?.agents.listDefinitions() as Promise<{ ok: boolean; data: Array<{ id: string; version: string; kind: string; isBuiltin: boolean }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
      ]);

      const cards = buildCards([], connRes?.data ?? [], profRes?.data ?? [], defRes?.data ?? []);
      setAgents(cards.length > 0 ? cards : MOCK_AGENT_CARDS);
    } catch { /* ignore */ }
  }, [buildCards]);

  // 完整重新检测（用户主动点击）
  const loadAgents = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [cliRes, connRes, profRes, defRes] = await Promise.all([
        (window.kunqing?.agents.detectCli() as Promise<{ ok: boolean; data: Array<{ id: string; adapterType: string; executablePath: string; detectedVersion: string | null; status: string }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
        (window.kunqing?.agents.listCliConnections() as Promise<{ ok: boolean; data: Array<{ id: string; name: string; adapterType: string; executablePath: string; detectedVersion: string | null; status: string }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
        (window.kunqing?.agents.listProfiles() as Promise<{ ok: boolean; data: Array<{ id: string; name: string; runtimeMode: string; enabled: boolean; definitionId?: string }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
        (window.kunqing?.agents.listDefinitions() as Promise<{ ok: boolean; data: Array<{ id: string; version: string; kind: string; isBuiltin: boolean }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
      ]);

      const cards = buildCards(cliRes?.data ?? [], connRes?.data ?? [], profRes?.data ?? [], defRes?.data ?? []);
      setAgents(cards.length > 0 ? cards : MOCK_AGENT_CARDS);
    } catch { setAgents(MOCK_AGENT_CARDS); }
    setLoading(false);
  }, [buildCards]);

  useEffect(() => {
    // 页面加载时，只加载已保存的连接，不检测 PATH
    void loadSavedAgents();
  }, [loadSavedAgents]);

  const filtered = useMemo(() => {
    return agents.filter((agent) => {
      const matchFilter = filter === '内置智能体' ? agent.isBuiltin : filter === 'CLI 智能体' ? !agent.isBuiltin && agent.framework === 'external-cli' : !agent.isBuiltin && agent.framework !== 'external-cli';
      const matchQuery = agent.name.toLowerCase().includes(query.toLowerCase());
      return matchFilter && matchQuery;
    });
  }, [agents, filter, query]);

  const testAgent = async (id: string): Promise<void> => {
    setTesting(id);
    try {
      const result = await window.kunqing?.agents.testCliConnection({ connectionId: id });
      const resultData = result as { ok: boolean; data: { success: boolean; version: string | null; error?: string } };
      if (resultData?.ok && resultData?.data?.success) {
        setAgents((current) => current.map((agent) => {
          if (agent.id !== id) return agent;
          const updated: AgentCardData = { ...agent, testStatus: 'passed' as const };
          if (resultData.data.version) {
            updated.detectedVersion = resultData.data.version;
          }
          return updated;
        }));
      } else {
        setAgents((current) => current.map((agent) => agent.id === id ? { ...agent, testStatus: 'failed' as const } : agent));
      }
    } catch { 
      setAgents((current) => current.map((agent) => agent.id === id ? { ...agent, testStatus: 'failed' as const } : agent));
    }
    setTesting(undefined);
  };

  const deleteAgent = async (id: string): Promise<void> => {
    try {
      // 先更新 UI，立即从列表中移除该记录，避免用户等待
      setAgents(prev => prev.filter(agent => agent.id !== id));
      // 然后执行删除操作
      await window.kunqing?.agents.deleteCliConnection({ connectionId: id });
    } catch { /* ignore */ }
  };

  const frameworkIcon = (fw: string): React.ReactNode => {
    if (fw === 'LangGraph.js') return <Layers size={14} />;
    if (fw === 'external-cli') return <TerminalSquare size={14} />;
    return <Cpu size={14} />;
  };

  return (
    <div className="settings-page settings-page--agents">
      <SettingsHeading title="智能体接入" description="接入 CLI 智能体或配置内置智能体；外部程序仅在本机以受控子进程运行。" action={<button type="button" className="secondary-button" onClick={() => void loadAgents()}><RefreshCw size={15} /> 重新检测</button>} />
      {loading ? (
        <div className="settings-loading"><Loader2 size={20} className="spin" /> 检测中...</div>
      ) : (
      <>
      <div className="settings-filter-row">
        <div className="segmented-control">{(['内置智能体', 'CLI 智能体', '自定义配置'] as const).map((item) => <button type="button" className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>{item}<span>{agents.filter((a) => item === '内置智能体' ? a.isBuiltin : item === 'CLI 智能体' ? !a.isBuiltin && a.framework === 'external-cli' : !a.isBuiltin && a.framework !== 'external-cli').length}</span></button>)}</div>
        <label className="settings-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索智能体..." /></label>
      </div>
      <div className="agent-card-grid">
        {filtered.length === 0 && <p className="model-empty">{filter === '内置智能体' ? '暂无内置智能体' : filter === 'CLI 智能体' ? '未检测到 CLI 智能体' : '暂无自定义配置'}</p>}
        {filtered.map((agent) => (
          <article className={`agent-card${agent.isBuiltin ? ' agent-card--builtin' : ''}${!agent.enabled ? ' agent-card--disabled' : ''}`} key={agent.id}>
            <header className="agent-card__header">
              <span className="agent-card__icon">{agent.isBuiltin ? <Bot size={20} /> : <TerminalSquare size={20} />}</span>
              <div>
                <strong>{agent.name}</strong>
                <span className="agent-card__id"><code>{agent.id}</code></span>
              </div>
              <span className={`agent-card__badge agent-card__badge--${agent.testStatus === 'passed' ? 'ok' : agent.testStatus === 'failed' ? 'fail' : 'none'}`}>
                {agent.testStatus === 'passed' ? '已测试' : agent.testStatus === 'failed' ? '失败' : '未测试'}
              </span>
            </header>
            <div className="agent-card__body">
              <div className="agent-card__field"><span className="agent-card__label">定义版本</span><span className="agent-card__value">{agent.definitionVersion}</span></div>
              <div className="agent-card__field"><span className="agent-card__label">运行框架</span><span className="agent-card__value">{frameworkIcon(agent.framework)} {agent.framework}</span></div>
              <div className="agent-card__field"><span className="agent-card__label">模型 Profile</span><span className="agent-card__value">{agent.modelProfile}</span></div>
              {agent.skills.length > 0 && (
                <div className="agent-card__field agent-card__field--full">
                  <span className="agent-card__label">技能</span>
                  <span className="agent-card__tags">{agent.skills.map((s) => <code key={s}>{s}</code>)}</span>
                </div>
              )}
              {agent.permissions.length > 0 && (
                <div className="agent-card__field agent-card__field--full">
                  <span className="agent-card__label">有效权限</span>
                  <span className="agent-card__tags">{agent.permissions.map((p) => <code key={p} className="agent-card__perm">{p}</code>)}</span>
                </div>
              )}
              <div className="agent-card__field"><span className="agent-card__label">被引用群聊</span><span className="agent-card__value"><MessageSquareMore size={13} /> {agent.referencedChats} 个群聊</span></div>
            </div>
            <footer className="agent-card__footer">
              <button type="button" className="secondary-button secondary-button--small" onClick={() => void testAgent(agent.id)} disabled={testing === agent.id}>
                <TestTube2 size={13} /> {testing === agent.id ? '测试中…' : '测试连接'}
              </button>
              {agent.isBuiltin ? (
                <div className="agent-card__builtin-actions">
                  <button type="button" className="secondary-button secondary-button--small" title="更换兼容模型" onClick={() => setAgentDialog({ type: 'switchModel', agent })}><Cpu size={13} /> 更换模型</button>
                  <button type="button" className="secondary-button secondary-button--small" title="关闭非必需技能" onClick={() => setAgentDialog({ type: 'manageSkills', agent })}><Puzzle size={13} /> 技能</button>
                  <button type="button" className="secondary-button secondary-button--small" title="收紧权限" onClick={() => setAgentDialog({ type: 'tightenPermissions', agent })}><ShieldOff size={13} /> 权限</button>
                  <button type="button" className="secondary-button secondary-button--small" title="克隆为自定义 Profile" onClick={() => setAgentDialog({ type: 'cloneProfile', agent })}><Copy size={13} /> 克隆</button>
                </div>
              ) : (
                <div className="agent-card__cli-actions">
                  <span className="agent-card__cli-path" title={agent.executablePath}>
                    {agent.executablePath}
                    {agent.detectedVersion && <span className="agent-card__version">v{agent.detectedVersion}</span>}
                  </span>
                  <button type="button" className="secondary-button secondary-button--small" title="删除" onClick={() => void deleteAgent(agent.id)}>
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              )}
            </footer>
          </article>
        ))}
      </div>
      <button type="button" className="add-agent-button" onClick={() => setAddOpen(true)}><Plus size={17} /> 添加自定义智能体</button>
      {addOpen && <ConnectionWizardDialog onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); setFilter('CLI 智能体'); void loadSavedAgents(); }} />}
      {agentDialog && <AgentActionDialog dialog={agentDialog} onClose={() => setAgentDialog(null)} onRefresh={loadAgents} />}
      </>
      )}
    </div>
  );
}

interface WizardSnapshot {
  step: string; name: string; adapterType: string; executablePath: string;
  detectedVersion: string | null; strategyId: string; capabilities: string[];
  authMethod: string; authRequired: boolean; trustTier: string;
  connectionId: string | null;
  smokeWorkspaceDir: string | null;
  smokeTestResult: 'pending' | 'passed' | 'failed' | null;
  error?: { code: string; message: string; retryable: boolean };
  failedAtStep?: string;
}

function ConnectionWizardDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }): React.JSX.Element {
  const [snap, setSnap] = useState<WizardSnapshot | null>(null);
  const [name, setName] = useState('');
  const [adapterType, setAdapterType] = useState('codex');
  const [executable, setExecutable] = useState('');
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [working, setWorking] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);

  const updateSnap = (res: { ok: boolean; data: WizardSnapshot } | undefined): void => {
    if (res?.data) setSnap(res.data);
  };

  const handleStartAuto = async (): Promise<void> => {
    setWorking(true);
    try {
      const res = await (window.kunqing?.agents.wizardStartAuto({ adapterType }) as Promise<{ ok: boolean; data: WizardSnapshot }>);
      updateSnap(res);
      if (res?.data?.step === 'readingVersion') {
        const step2 = await (window.kunqing?.agents.wizardReadVersion() as Promise<{ ok: boolean; data: WizardSnapshot }>);
        updateSnap(step2);
      }
    } catch { /* ignore */ }
    setWorking(false);
  };

  const handleStartManual = async (): Promise<void> => {
    if (!name.trim() || !executable.trim()) return;
    setWorking(true);
    try {
      const res = await (window.kunqing?.agents.wizardStartManual({ name: name.trim(), adapterType, executablePath: executable.trim() }) as Promise<{ ok: boolean; data: WizardSnapshot }>);
      updateSnap(res);
      if (res?.data?.step === 'selectingExecutable') {
        const step2 = await (window.kunqing?.agents.wizardSetExecutable({ executablePath: executable.trim() }) as Promise<{ ok: boolean; data: WizardSnapshot }>);
        updateSnap(step2);
        if (step2?.data?.step === 'readingVersion') {
          const step3 = await (window.kunqing?.agents.wizardReadVersion() as Promise<{ ok: boolean; data: WizardSnapshot }>);
          updateSnap(step3);
        }
      }
    } catch { /* ignore */ }
    setWorking(false);
  };

  const handleNext = async (action: 'readVersion' | 'probeAuth' | 'prepareSmokeWorkspace' | 'runSmokeTest' | 'save'): Promise<void> => {
    setWorking(true);
    try {
      let res: { ok: boolean; data: WizardSnapshot } | undefined;
      if (action === 'readVersion') res = await (window.kunqing?.agents.wizardReadVersion() as Promise<{ ok: boolean; data: WizardSnapshot }>);
      else if (action === 'probeAuth') res = await (window.kunqing?.agents.wizardProbeAuth() as Promise<{ ok: boolean; data: WizardSnapshot }>);
      else if (action === 'prepareSmokeWorkspace') res = await (window.kunqing?.agents.wizardPrepareSmokeWorkspace() as Promise<{ ok: boolean; data: WizardSnapshot }>);
      else if (action === 'runSmokeTest') res = await (window.kunqing?.agents.wizardRunSmokeTest() as Promise<{ ok: boolean; data: WizardSnapshot }>);
      else if (action === 'save') res = await (window.kunqing?.agents.wizardSave() as Promise<{ ok: boolean; data: WizardSnapshot }>);
      updateSnap(res);
    } catch { /* ignore */ }
    setWorking(false);
  };

  const handleRetry = async (): Promise<void> => {
    setWorking(true);
    try {
      const res = await (window.kunqing?.agents.wizardRetry() as Promise<{ ok: boolean; data: WizardSnapshot }>);
      updateSnap(res);
    } catch { /* ignore */ }
    setWorking(false);
  };

  const handleCancel = async (): Promise<void> => {
    await window.kunqing?.agents.wizardCancel();
    onClose();
  };

  const handleFinish = (): void => {
    window.kunqing?.agents.wizardCancel().catch(() => {});
    onAdded();
  };

  if (!snap || snap.step === 'idle') {
    return (
      <div className="modal-backdrop" role="presentation">
        <form className="agent-dialog" onSubmit={(e) => { e.preventDefault(); void (mode === 'auto' ? handleStartAuto() : handleStartManual()); }}>
          <header>
            <div><h3>接入智能体</h3><p>选择接入方式，完成连接配置向导。</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
          </header>
          <label><span>接入方式</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'auto' | 'manual')}>
              <option value="auto">自动检测（扫描 PATH）</option>
              <option value="manual">手动指定路径</option>
            </select>
          </label>
          <label><span>适配器类型</span>
            <select value={adapterType} onChange={(e) => setAdapterType(e.target.value)}>
              <option value="codex">Codex CLI</option>
              <option value="claude-code">Claude Code</option>
              <option value="aion">Aion CLI</option>
              <option value="gemini">Gemini CLI</option>
              <option value="qwen-code">Qwen Code</option>
              <option value="opencode">Opencode</option>
              <option value="codegeex">CodeGeeX</option>
              <option value="kimi">Kimi</option>
              <option value="minimax">MiniMax</option>
              <option value="marcode">MarsCode</option>
              <option value="codebuddy">CodeBuddy</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          {mode === 'manual' && (
            <>
              <label><span>显示名称 *</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的Codex" />
              </label>
              <label><span>可执行文件路径 *</span>
                <input value={executable} onChange={(e) => setExecutable(e.target.value)} placeholder="/usr/local/bin/codex 或 C:\codex\codex.exe" />
              </label>
            </>
          )}
          <div className="dialog-warning"><ShieldCheck size={17} /><span>外部 CLI 是受信任的本地程序。托管副本可缩小误操作范围，但不是操作系统沙箱。</span></div>
          <footer>
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={working || (mode === 'manual' && (!name.trim() || !executable.trim()))}>
              {working ? '检测中…' : '开始检测'}
            </button>
          </footer>
        </form>
      </div>
    );
  }

  if (snap.step === 'readingVersion') {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p>正在读取版本信息…</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleCancel()}><X size={18} /></button>
          </header>
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <Loader2 size={24} className="spin" />
            <p style={{ marginTop: 8, color: 'var(--kq-text-tertiary)' }}>路径: {snap.executablePath}</p>
          </div>
        </div>
      </div>
    );
  }

  if (snap.step === 'selectingStrategy') {
    const s = snap as WizardSnapshot & { step: 'selectingStrategy' };
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p style={{ color: 'var(--kq-primary)' }}>版本信息已获取</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleCancel()}><X size={18} /></button>
          </header>
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 40, color: 'var(--kq-primary)', marginBottom: 8 }}>✓</div>
            <p>路径: {s.executablePath}</p>
            {s.detectedVersion && <p>版本: {s.detectedVersion}</p>}
          </div>
          <footer>
            <button type="button" className="secondary-button" onClick={() => void handleCancel()}>取消</button>
            <button type="button" className="primary-button" onClick={() => void handleNext('probeAuth')} disabled={working}>
              {working ? '处理中…' : '下一步：认证探测'}
            </button>
          </footer>
        </div>
      </div>
    );
  }

  if (snap.step === 'probingAuth') {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p>正在探测认证状态…</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleCancel()}><X size={18} /></button>
          </header>
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <Loader2 size={24} className="spin" />
          </div>
        </div>
      </div>
    );
  }

  if (snap.step === 'preparingSmokeWorkspace') {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p style={{ color: 'var(--kq-primary)' }}>认证探测完成</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleCancel()}><X size={18} /></button>
          </header>
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 40, color: 'var(--kq-primary)', marginBottom: 8 }}>✓</div>
            <p style={{ fontSize: 10, color: 'var(--kq-text-tertiary)' }}>将创建沙箱目录并运行 Smoke 测试</p>
          </div>
          <footer>
            <button type="button" className="secondary-button" onClick={() => void handleCancel()}>取消</button>
            <button type="button" className="primary-button" onClick={() => void handleNext('prepareSmokeWorkspace')} disabled={working}>
              {working ? '处理中…' : '下一步：运行 Smoke 测试'}
            </button>
          </footer>
        </div>
      </div>
    );
  }

  if (snap.step === 'smokeTesting') {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p>准备运行 Smoke 测试</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleCancel()}><X size={18} /></button>
          </header>
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <p style={{ fontSize: 10, color: 'var(--kq-text-tertiary)' }}>
              工作区: {snap.smokeWorkspaceDir || '-'}
            </p>
          </div>
          <footer>
            <button type="button" className="primary-button" onClick={() => void handleNext('runSmokeTest')} disabled={working}>
              {working ? '运行中…' : '运行 Smoke 测试'}
            </button>
          </footer>
        </div>
      </div>
    );
  }

  if (snap.step === 'reviewingCapabilitiesAndRisk') {
    const s = snap as WizardSnapshot & { step: 'reviewingCapabilitiesAndRisk' };
    const hasNetworkAccess = s.capabilities.includes('network-access');
    const canDelegate = s.capabilities.includes('code-generation') || s.capabilities.includes('reasoning');
    const workspaceModeLabel = s.trustTier === 'sandboxed' ? '沙箱隔离' : s.trustTier === 'restricted' ? '受限模式' : '直接操作工作区';
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p>确认能力与风险信息</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleCancel()}><X size={18} /></button>
          </header>
          {hasNetworkAccess && (
            <div className="dialog-warning" style={{ margin: '0 0 12px' }}>
              <ShieldCheck size={17} />
              <span><strong>数据出站风险：</strong>该智能体具备网络访问能力，可能与外部服务通信。请确保您信任该 CLI 工具，理解其数据使用政策，避免将敏感代码或凭据发送到第三方。</span>
            </div>
          )}
          <div className="system-info-card" style={{ margin: '12px 0', padding: 12 }}>
            <h4>连接概要</h4>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 10, margin: 0 }}>
              <dt>名称</dt><dd>{s.name}</dd>
              <dt>适配器</dt><dd>{s.adapterType}</dd>
              <dt>路径</dt><dd><code>{s.executablePath}</code></dd>
              <dt>版本</dt><dd>{s.detectedVersion || '-'}</dd>
              <dt>策略</dt><dd>{s.strategyId}</dd>
              <dt>能力</dt><dd>{s.capabilities.join(', ') || '-'}</dd>
              <dt>认证方式</dt><dd>{s.authMethod}</dd>
              <dt>工作区模式</dt><dd>{workspaceModeLabel}</dd>
              <dt>可委派性</dt><dd>{canDelegate ? '允许委派' : '不支持委派'}</dd>
              <dt>超时</dt>
              <dd>
                <input type="number" min={1} max={180} value={timeoutMinutes}
                  onChange={(e) => setTimeoutMinutes(Math.max(1, Math.min(180, Number(e.target.value) || 30)))}
                  style={{ width: 60, fontSize: 10, padding: '1px 4px' }} />
                <span style={{ marginLeft: 4 }}>分钟（{Math.floor(timeoutMinutes / 60)}小时{timeoutMinutes % 60 > 0 ? ` ${timeoutMinutes % 60}分钟` : ''}）</span>
              </dd>
            </dl>
          </div>
          <label><span>信任等级</span>
            <select value={snap.trustTier} onChange={async (e) => {
              const res = await (window.kunqing?.agents.wizardSetTrustTier({ tier: e.target.value }) as Promise<{ ok: boolean; data: WizardSnapshot }> | undefined);
              if (res?.data) setSnap(res.data);
            }}>
              <option value="trusted">受信任</option>
              <option value="sandboxed">沙箱托管</option>
              <option value="restricted">受限</option>
            </select>
          </label>
          <footer>
            <button type="button" className="secondary-button" onClick={() => void handleCancel()}>取消</button>
            <button type="button" className="primary-button" onClick={() => void handleNext('save')} disabled={working}>
              {working ? '保存中…' : '保存连接'}
            </button>
          </footer>
        </div>
      </div>
    );
  }

  if (snap.step === 'saving') {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header><div><h3>接入智能体</h3><p>正在保存连接…</p></div></header>
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <Loader2 size={24} className="spin" />
          </div>
        </div>
      </div>
    );
  }

  if (snap.step === 'ready') {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p>连接已就绪</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleFinish()}><X size={18} /></button>
          </header>
          <div style={{ padding: '20px 0', textAlign: 'center' }}>
            <CheckCircle2 size={32} style={{ color: 'var(--kq-success)' }} />
            <p style={{ marginTop: 8 }}>{snap.name} 已成功接入</p>
          </div>
          <footer>
            <button type="button" className="primary-button" onClick={() => void handleFinish()}>完成</button>
          </footer>
        </div>
      </div>
    );
  }

  if (snap.step === 'failed') {
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="agent-dialog">
          <header>
            <div><h3>接入智能体</h3><p>连接失败</p></div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => void handleCancel()}><X size={18} /></button>
          </header>
          <div className="dialog-warning" style={{ margin: '12px 0' }}>
            <AlertTriangle size={17} />
            <span>{snap.error?.message || '未知错误'}（{snap.error?.code}）</span>
          </div>
          <footer>
            <button type="button" className="secondary-button" onClick={() => void handleCancel()}>取消</button>
            {snap.error?.retryable && (
              <button type="button" className="primary-button" onClick={() => void handleRetry()} disabled={working}>
                {working ? '重试中…' : '重试'}
              </button>
            )}
          </footer>
        </div>
      </div>
    );
  }

  return <></>;
}

const BUILTIN_MODELS = ['GPT-4o', 'GPT-4o-mini', 'Claude 3.5 Sonnet', 'Claude 3 Haiku', 'Gemini 2.0 Flash', 'DeepSeek-V3'];

const ALL_SKILLS = ['任务拆解', '结果汇总', '团队 MCP', '文档解析', '知识图谱', 'Wiki 生成', '代码审查', '测试生成'];

const ALL_PERMISSIONS: { id: string; label: string }[] = [
  { id: 'read', label: '读取项目文件' },
  { id: 'write', label: '写入项目文件' },
  { id: 'execute', label: '执行终端命令' },
  { id: 'delegate', label: '委派子任务' },
  { id: 'network', label: '网络访问' },
];

function AgentActionDialog({ dialog, onClose, onRefresh }: { dialog: { type: string; agent: AgentCardData }; onClose: () => void; onRefresh?: () => void }): React.JSX.Element {
  const { type, agent } = dialog;
  const [selectedModel, setSelectedModel] = useState(agent.modelProfile);
  const [enabledSkills, setEnabledSkills] = useState<string[]>(agent.skills);
  const [effectivePermissions, setEffectivePermissions] = useState<string[]>(agent.permissions);
  const [cloneName, setCloneName] = useState(`${agent.name} (自定义)`);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const call = async (action: string, input: Record<string, unknown>): Promise<{ ok: boolean; message: string }> => {
    const api = (window.kunqing?.agents as any)?.[action];
    if (!api) return { ok: false, message: `API ${action} 不可用` };
    try {
      const res = await api(input) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
      if (res?.ok) return { ok: true, message: '' };
      return { ok: false, message: res?.error?.message ?? '操作失败' };
    } catch (err) {
      return { ok: false, message: `请求异常: ${String(err)}` };
    }
  };

  const handleSwitchModel = async (): Promise<void> => {
    setWorking(true);
    setResult(null);
    const res = await call('updateProfileModel', { profileId: agent.id, modelProfileId: selectedModel });
    setResult(res.ok ? { ok: true, message: `模型已切换为 ${selectedModel}。修改全局 Profile 只影响之后新建的群聊，已有群聊实例默认固定快照。` } : res);
    setWorking(false);
    if (res.ok && onRefresh) setTimeout(onRefresh, 500);
  };

  const handleSaveSkills = async (): Promise<void> => {
    setWorking(true);
    setResult(null);
    const res = await call('updateProfileSkills', { profileId: agent.id, enabledSkills });
    setResult(res.ok ? { ok: true, message: '技能配置已更新。' } : res);
    setWorking(false);
    if (res.ok && onRefresh) setTimeout(onRefresh, 500);
  };

  const handleSavePermissions = async (): Promise<void> => {
    setWorking(true);
    setResult(null);
    const res = await call('updateProfilePermissions', { profileId: agent.id, effectivePermissions });
    setResult(res.ok ? { ok: true, message: '权限配置已更新。' } : res);
    setWorking(false);
    if (res.ok && onRefresh) setTimeout(onRefresh, 500);
  };

  const handleClone = async (): Promise<void> => {
    setWorking(true);
    setResult(null);
    const res = await call('cloneProfile', { profileId: agent.id, name: cloneName });
    setResult(res.ok ? { ok: true, message: `自定义 Profile "${cloneName}" 已创建，请切换到"自定义配置"视图查看。` } : res);
    setWorking(false);
    if (res.ok && onRefresh) setTimeout(onRefresh, 500);
  };

  const titleMap: Record<string, string> = {
    switchModel: '更换兼容模型',
    manageSkills: '管理技能',
    tightenPermissions: '收紧权限',
    cloneProfile: '克隆为自定义 Profile',
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="agent-dialog">
        <header>
          <div><h3>{titleMap[type] ?? '操作'}</h3><p>{agent.name}</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        {result && (
          <div className="dialog-warning" style={{ margin: '0 0 12px', background: result.ok ? '#e6f7ec' : '#fde8e8', borderColor: result.ok ? '#b7ebc3' : '#f5b7b7' }}>
            {result.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
            <span>{result.message}</span>
          </div>
        )}

        {type === 'switchModel' && (
          <div style={{ padding: '8px 0' }}>
            <p style={{ fontSize: 10, color: 'var(--kq-text-secondary)', marginBottom: 10 }}>当前模型：<strong>{agent.modelProfile}</strong></p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {BUILTIN_MODELS.map((m) => (
                <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, padding: '6px 8px', background: selectedModel === m ? '#eeedff' : '#f8f8fa', borderRadius: 6, cursor: 'pointer' }}>
                  <input type="radio" name="model" checked={selectedModel === m} onChange={() => setSelectedModel(m)} disabled={working} />
                  {m}
                </label>
              ))}
            </div>
            {!result && (
              <button type="button" className="primary-button" onClick={() => void handleSwitchModel()} disabled={working || selectedModel === agent.modelProfile} style={{ marginTop: 10 }}>
                {working ? '保存中…' : '应用'}
              </button>
            )}
          </div>
        )}

        {type === 'manageSkills' && (
          <div style={{ padding: '8px 0' }}>
            <p style={{ fontSize: 10, color: 'var(--kq-text-secondary)', marginBottom: 10 }}>关闭非必需技能可减少模型调用和上下文占用。</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ALL_SKILLS.map((s) => (
                <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, padding: '6px 8px', background: enabledSkills.includes(s) ? '#eeedff' : '#f8f8fa', borderRadius: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={enabledSkills.includes(s)} onChange={() => setEnabledSkills((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])} disabled={working} />
                  {s}
                </label>
              ))}
            </div>
            {!result && (
              <button type="button" className="primary-button" onClick={() => void handleSaveSkills()} disabled={working} style={{ marginTop: 10 }}>
                {working ? '保存中…' : '保存'}
              </button>
            )}
          </div>
        )}

        {type === 'tightenPermissions' && (
          <div style={{ padding: '8px 0' }}>
            <p style={{ fontSize: 10, color: 'var(--kq-text-secondary)', marginBottom: 10 }}>取消权限可收紧智能体的操作范围，但不能超出定义声明的最大权限。</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ALL_PERMISSIONS.map((p) => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, padding: '6px 8px', background: effectivePermissions.includes(p.id) ? '#eeedff' : '#f8f8fa', borderRadius: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={effectivePermissions.includes(p.id)} onChange={() => setEffectivePermissions((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])} disabled={working} />
                  {p.label}
                </label>
              ))}
            </div>
            {!result && (
              <button type="button" className="primary-button" onClick={() => void handleSavePermissions()} disabled={working} style={{ marginTop: 10 }}>
                {working ? '保存中…' : '保存'}
              </button>
            )}
          </div>
        )}

        {type === 'cloneProfile' && (
          <div style={{ padding: '8px 0' }}>
            <p style={{ fontSize: 10, color: 'var(--kq-text-secondary)', marginBottom: 10 }}>将 <strong>{agent.name}</strong> 的当前配置克隆为自定义 Profile，可在不修改原智能体定义的前提下进行个性化调整。</p>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10 }}>
              <span>自定义名称</span>
              <input type="text" value={cloneName} onChange={(e) => setCloneName(e.target.value)} style={{ padding: '6px 8px', fontSize: 10, border: '1px solid var(--kq-border)', borderRadius: 6 }} disabled={working} />
            </label>
            {!result && (
              <button type="button" className="primary-button" onClick={() => void handleClone()} disabled={working || !cloneName.trim()} style={{ marginTop: 10 }}>
                {working ? '克隆中…' : <><Copy size={15} /> 确认克隆</>}
              </button>
            )}
          </div>
        )}

        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            {result?.ok ? '关闭' : '取消'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ModelsSettings(): React.JSX.Element {
  const [tab, setTab] = useState<'providers' | 'profiles'>('providers');
  const [providers, setProviders] = useState<Record<string, unknown>[]>([]);
  const [profiles, setProfiles] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; latencyMs: number; error?: string }>>({});
  const [modelIdInput, setModelIdInput] = useState<Record<string, string>>({});
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Record<string, unknown> | null>(null);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Record<string, unknown> | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);

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

  const testProvider = async (id: string, modelId?: string): Promise<void> => {
    setTestingId(id);
    try {
      const params: { providerId: string; modelId?: string } = { providerId: id };
      if (modelId !== undefined) params.modelId = modelId;
      const res = await (window.kunqing?.models.testProvider(params) as Promise<{ ok: boolean; data: { success: boolean; latencyMs: number; error?: string } }> | undefined);
      if (res?.data) {
        setTestResult(prev => ({ ...prev, [id]: res.data }));
        if (res.data.success) setModelIdInput(prev => ({ ...prev, [id]: '' }));
      }
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
              const needsModelId = result && !result.success && result.error?.includes('未提供 modelId');
              const pid = p.id as string;
              return (
              <article className="model-provider-card" key={pid}>
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
                    {result && !needsModelId && (
                      <span className={`test-badge test-badge--${result.success ? 'ok' : 'error'}`}>
                        {result.success ? `连通 (${result.latencyMs}ms)` : (result.error ?? '测试失败')}
                      </span>
                    )}
                    {needsModelId ? (
                      <div className="model-id-prompt">
                        <span className="test-badge test-badge--error">缺少模型 ID</span>
                        <div className="model-id-input-row">
                          <input
                            value={modelIdInput[pid] ?? ''}
                            onChange={(e) => setModelIdInput(prev => ({ ...prev, [pid]: e.target.value }))}
                            placeholder="输入模型 ID，如 gpt-4o"
                          />
                          <button type="button" className="primary-button primary-button--small" onClick={() => void testProvider(pid, modelIdInput[pid]?.trim())} disabled={testingId === pid || !modelIdInput[pid]?.trim()}>
                            {testingId === pid ? '测试中…' : '测试'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button type="button" className="secondary-button secondary-button--small" onClick={() => void testProvider(pid)} disabled={testingId === pid}>
                          {testingId === pid ? '测试中…' : '测试连接'}
                        </button>
                        <button type="button" className="secondary-button secondary-button--small" onClick={() => { setEditingProvider(p as Record<string, unknown>); setProviderDialogOpen(true); }}>编辑</button>
                        <button type="button" className="secondary-button secondary-button--small" style={{ color: 'var(--kq-danger)' }} onClick={() => { if (confirm('确认删除此供应商及其所有 Profile？')) { window.kunqing?.models.deleteProvider({ id: pid }); void load(); } }}>删除</button>
                      </>
                    )}
                  </div>
                </footer>
              </article>);
            })}
          </div>
          <button type="button" className="add-agent-button" onClick={() => { setEditingProvider(null); setProviderDialogOpen(true); }}><Plus size={17} /> 添加供应商</button>
          {providerDialogOpen && <ProviderDialog editProvider={editingProvider} onClose={() => { setProviderDialogOpen(false); setEditingProvider(null); }} onSaved={() => { setProviderDialogOpen(false); setEditingProvider(null); void load(); }} />}
        </>
      ) : (
        <ProfilesTab profiles={profiles} providers={providers} onRefresh={load} onAddProfile={() => { setEditingProfile(null); setProfileDialogOpen(true); }} onEditProfile={(p) => { setEditingProfile(p); setProfileDialogOpen(true); }} onDeleteProfile={(id) => { if (confirm('确认删除此 Profile？')) { window.kunqing?.models.deleteProfile({ id }); void load(); } }} />
      )}
      {profileDialogOpen && <ProfileDialog editProfile={editingProfile} providers={providers} onClose={() => { setProfileDialogOpen(false); setEditingProfile(null); }} onSaved={() => { setProfileDialogOpen(false); setEditingProfile(null); void load(); }} />}
    </div>
  );
}

function ProviderDialog({ editProvider, onClose, onSaved }: { editProvider?: Record<string, unknown> | null; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const isEdit = !!editProvider;
  const [name, setName] = useState((editProvider?.name as string) ?? '');
  const [type, setType] = useState((editProvider?.type as string) ?? 'openai');
  const [baseUrl, setBaseUrl] = useState((editProvider?.baseUrl as string) ?? '');
  const [authType, setAuthType] = useState((editProvider?.authType as string) ?? 'api-key');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (isEdit) {
        const updateParams: { id: string; name?: string; type?: string; baseUrl?: string | null; authType?: string; apiKey?: string } = { id: editProvider.id as string, name: name.trim(), type, baseUrl: baseUrl.trim() || null, authType };
        if (apiKey.trim()) updateParams.apiKey = apiKey.trim();
        const updateRes = await (window.kunqing?.models.updateProvider(updateParams) as Promise<{ ok: boolean; error?: { message: string } }> | undefined);
        if (updateRes && !updateRes.ok) throw new Error(updateRes.error?.message ?? '更新供应商失败');
      } else {
        const providerParams: { name: string; type: string; baseUrl: string; authType: string; apiKey?: string } = { name: name.trim(), type, baseUrl: baseUrl.trim() || 'https://api.openai.com/v1', authType };
        if (apiKey.trim()) providerParams.apiKey = apiKey.trim();
        const saveRes = await (window.kunqing?.models.saveProvider(providerParams) as Promise<{ ok: boolean; error?: { message: string } }> | undefined);
        if (saveRes && !saveRes.ok) throw new Error(saveRes.error?.message ?? '保存供应商失败');
      }
      onSaved();
    } catch (err) {
      console.error('保存供应商失败', err);
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="model-dialog" onSubmit={(e) => void submit(e)}>
        <header>
          <div><h3>{isEdit ? '编辑供应商' : '添加供应商'}</h3><p>供应商是模型 API 的提供方，如 OpenAI、Ollama 等。</p></div>
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
        <label><span><Key size={14} /> {isEdit ? '新 API Key（留空则不修改）' : 'API Key（可选，将加密保存）'}</span><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." /></label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </form>
    </div>
  );
}

function ProfileDialog({ editProfile, providers, onClose, onSaved }: { editProfile?: Record<string, unknown> | null; providers: Record<string, unknown>[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const isEdit = !!editProfile;
  const [name, setName] = useState((editProfile?.name as string) ?? '');
  const [providerId, setProviderId] = useState((editProfile?.providerId as string) ?? '');
  const [modelId, setModelId] = useState((editProfile?.modelId as string) ?? '');
  const [modelSlot, setModelSlot] = useState((editProfile?.modelSlot as string) ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || !providerId || !modelId.trim()) return;
    setSaving(true);
    try {
      const profileParams: { id?: string; name: string; providerId: string; modelId: string; modelSlot?: string } = { name: name.trim(), providerId, modelId: modelId.trim() };
      if (isEdit) profileParams.id = editProfile.id as string;
      if (modelSlot) profileParams.modelSlot = modelSlot;
      await window.kunqing?.models.saveProfile(profileParams);
      onSaved();
    } catch (err) { console.error('保存 Profile 失败', err); }
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="model-dialog" onSubmit={(e) => void submit(e)}>
        <header>
          <div><h3>{isEdit ? '编辑模型 Profile' : '添加模型 Profile'}</h3><p>Profile 绑定供应商和具体模型 ID，可选分配到智能体槽位。</p></div>
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

function ProfilesTab({ profiles, providers, onRefresh, onAddProfile, onEditProfile, onDeleteProfile }: { profiles: Record<string, unknown>[]; providers: Record<string, unknown>[]; onRefresh: () => Promise<void>; onAddProfile: () => void; onEditProfile: (p: Record<string, unknown>) => void; onDeleteProfile: (id: string) => void }): React.JSX.Element {
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
        <button type="button" className="secondary-button secondary-button--small" onClick={onAddProfile}><Plus size={14} /> 添加 Profile</button>
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
            <div className="profile-row-actions">
              <button type="button" className="secondary-button secondary-button--small" onClick={() => onEditProfile(p as Record<string, unknown>)}>编辑</button>
              <button type="button" className="secondary-button secondary-button--small" style={{ color: 'var(--kq-danger)' }} onClick={() => onDeleteProfile(p.id as string)}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaceholderSettings({ title, description }: { title: string; description: string }): React.JSX.Element {
  return <div className="settings-page"><SettingsHeading title={title} description={description} /><div className="file-empty" style={{ padding: '80px 40px', textAlign: 'center' }}><ShieldCheck size={38} /><strong>功能开发中</strong><span>此设置页面将在后续版本中实现。</span></div></div>;
}

interface AgentProfile {
  id: string; name: string; definitionId: string; runtimeMode: string; enabled: boolean; delegatable: boolean;
}

interface AgentDefinition {
  id: string; version: string; kind: string; isBuiltin: boolean; installedAt: string;
}

function AssistantsSettings(): React.JSX.Element {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [definitions, setDefinitions] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [profRes, defRes] = await Promise.all([
        (window.kunqing?.agents.listProfiles() as Promise<{ ok: boolean; data: AgentProfile[] }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
        (window.kunqing?.agents.listDefinitions() as Promise<{ ok: boolean; data: AgentDefinition[] }> | undefined) ?? Promise.resolve({ ok: true, data: [] }),
      ]);
      setProfiles(profRes?.data ?? []);
      setDefinitions(defRes?.data ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleEnabled = async (profileId: string, enabled: boolean): Promise<void> => {
    try {
      await window.kunqing?.agents.setProfileEnabled({ profileId, enabled });
      setProfiles((prev) => prev.map((p) => p.id === profileId ? { ...p, enabled } : p));
    } catch { /* ignore */ }
  };

  return (
    <div className="settings-page">
      <SettingsHeading title="助手管理" description="管理已保存的智能体 Profile，编辑显示名、描述、默认模型和技能开关。" />
      {loading ? (
        <div className="settings-loading"><Loader2 size={20} className="spin" /> 加载中...</div>
      ) : (
        <div className="system-info-card" style={{ padding: 0 }}>
          {profiles.length === 0 ? (
            <p style={{ padding: 20, textAlign: 'center', color: 'var(--kq-text-tertiary)' }}>暂无 Profile</p>
          ) : (
            <table className="scan-findings-table">
              <thead><tr><th>名称</th><th>定义 ID</th><th>运行模式</th><th>可委派</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td><code>{p.definitionId}</code></td>
                    <td>{p.runtimeMode}</td>
                    <td>{p.delegatable ? '是' : '否'}</td>
                    <td>{p.enabled ? <span style={{ color: 'var(--kq-success)' }}>已启用</span> : <span style={{ color: 'var(--kq-text-tertiary)' }}>已禁用</span>}</td>
                    <td>
                      <button type="button" className="secondary-button secondary-button--small" onClick={() => void toggleEnabled(p.id, !p.enabled)}>
                        {p.enabled ? '禁用' : '启用'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <button type="button" className="add-agent-button" onClick={() => setAddOpen(true)} style={{ marginTop: 12 }}><Plus size={17} /> 新建 Profile</button>
      {addOpen && <AddProfileDialog definitions={definitions} onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); void load(); }} />}
    </div>
  );
}

function AddProfileDialog({ definitions, onClose, onAdded }: { definitions: AgentDefinition[]; onClose: () => void; onAdded: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [definitionId, setDefinitionId] = useState(definitions[0]?.id ?? '');
  const [runtimeMode, setRuntimeMode] = useState('built-in');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim() || !definitionId) return;
    setSaving(true);
    try {
      await window.kunqing?.agents.saveProfile({ name: name.trim(), definitionId, runtimeMode });
      onAdded();
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="agent-dialog" onSubmit={(e) => void submit(e)}>
        <header>
          <div><h3>新建智能体 Profile</h3><p>创建一个新的智能体 Profile，关联到定义和运行模式。</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <label>
          <span>名称 *</span>
          <input className={submitted && !name.trim() ? 'input-invalid' : ''} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：我的助手" />
        </label>
        <label>
          <span>定义</span>
          <select value={definitionId} onChange={(e) => setDefinitionId(e.target.value)}>
            {definitions.map((d) => <option key={d.id} value={d.id}>{d.id} v{d.version}</option>)}
          </select>
        </label>
        <label>
          <span>运行模式</span>
          <select value={runtimeMode} onChange={(e) => setRuntimeMode(e.target.value)}>
            <option value="built-in">内置</option>
            <option value="external-cli">外部 CLI</option>
          </select>
        </label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || !name.trim() || !definitionId}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </div>
  );
}

interface SkillRow {
  id: string; name: string; description: string; promptMd: string | null;
  requiredCapabilities: string[]; enabled: boolean; isBuiltin: boolean; agentDefinitionId: string | null;
}

const AGENT_REQUIREMENTS: Array<{ id: string; name: string; capabilities: string[] }> = [
  { id: 'builtin.orchestrator', name: '统筹管理智能体', capabilities: ['streaming', 'toolCalling', 'structuredOutput'] },
  { id: 'builtin.knowledge-manager', name: '知识管理智能体', capabilities: ['streaming', 'structuredOutput'] },
];

interface ToolConfig {
  id: string; name: string; description: string; enabled: boolean;
  config: Record<string, string>;
}

interface McpServerConfig {
  id: string; name: string; transport: 'stdio' | 'sse'; command?: string; url?: string;
  enabled: boolean; status: 'connected' | 'disconnected' | 'error';
}

const MOCK_TOOLS: ToolConfig[] = [
  { id: 'tool.file-reader', name: '文件读取器', description: '读取工作区文件内容', enabled: true, config: { maxSize: '1MB' } },
  { id: 'tool.web-search', name: '网络搜索', description: '通过搜索引擎获取实时信息', enabled: true, config: { engine: 'bing', maxResults: '5' } },
  { id: 'tool.db-query', name: '数据库查询', description: '对本地 SQLite 执行只读查询', enabled: false, config: { timeout: '10s' } },
];

const MOCK_MCP_SERVERS: McpServerConfig[] = [
  { id: 'mcp.filesystem', name: 'Filesystem', transport: 'stdio', command: 'npx', enabled: true, status: 'connected' },
  { id: 'mcp.github', name: 'GitHub', transport: 'sse', url: 'https://api.github.com/mcp', enabled: false, status: 'disconnected' },
  { id: 'mcp.notion', name: 'Notion', transport: 'sse', url: 'https://www.notion.com/api/mcp', enabled: true, status: 'error' },
];

function CapabilitiesSettings(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [tools, setTools] = useState<ToolConfig[]>(MOCK_TOOLS);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<string | null>(null);

  useEffect(() => {
    (window.kunqing?.settings.listSkills() as Promise<{ ok: boolean; data: SkillRow[] }> | undefined)
      ?.then((res) => { if (res?.data) setSkills(res.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    (window.kunqing?.settings.listMcpServers() as Promise<{ ok: boolean; data: McpServerConfig[] }> | undefined)
      ?.then((res) => { if (res?.data) setMcpServers(res.data); })
      .catch(() => {})
      .finally(() => setMcpLoading(false));
  }, []);

  const toggleSkill = async (skillId: string, enabled: boolean): Promise<void> => {
    try {
      await window.kunqing?.settings.setSkillEnabled({ skillId, enabled });
      setSkills((prev) => prev.map((s) => s.id === skillId ? { ...s, enabled } : s));
    } catch { /* ignore */ }
  };

  const toggleTool = (toolId: string): void => {
    setTools((prev) => prev.map((t) => t.id === toolId ? { ...t, enabled: !t.enabled } : t));
  };

  const toggleMcpServer = async (serverId: string): Promise<void> => {
    const current = mcpServers.find((s) => s.id === serverId);
    if (!current) return;
    try {
      await window.kunqing?.settings.setMcpServerEnabled({ serverId, enabled: !current.enabled });
      setMcpServers((prev) => prev.map((s) => s.id === serverId ? { ...s, enabled: !s.enabled } : s));
    } catch { /* ignore */ }
  };

  const mcpStatusIcon = (status: McpServerConfig['status']): React.ReactNode => {
    switch (status) {
      case 'connected': return <span className="capability-status-dot capability-status-dot--ok" />;
      case 'disconnected': return <span className="capability-status-dot capability-status-dot--off" />;
      case 'error': return <span className="capability-status-dot capability-status-dot--err" />;
    }
  };

  return (
    <div className="settings-page">
      <SettingsHeading title="能力扩展" description="管理内置 Skill、Tool 和 MCP Server 配置，控制智能体可用的扩展能力。" />
      {/* 模型能力要求 */}
      <div className="system-info-card">
        <h4><BrainCircuit size={16} /> 智能体模型能力要求</h4>
        <table className="scan-findings-table">
          <thead><tr><th>智能体</th><th>所需能力</th></tr></thead>
          <tbody>
            {AGENT_REQUIREMENTS.map((a) => (
              <tr key={a.id}>
                <td><code>{a.id}</code></td>
                <td>{a.capabilities.map((c) => <code key={c} style={{ marginRight: 4 }}>{c}</code>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 10, color: 'var(--kq-text-tertiary)', marginTop: 8 }}>
          能力不足的模型将被阻止绑定到此智能体。非内置智能体无能力限制。
        </p>
      </div>

      {/* 内置技能 */}
      <div className="system-info-card">
        <h4><Puzzle size={16} /> 内置技能 {!loading && <span className="capability-count">{skills.filter((s) => s.isBuiltin).length}</span>}</h4>
        {loading ? <p>加载中...</p> : (
          <table className="scan-findings-table">
            <thead><tr><th>技能 ID</th><th>绑定智能体</th><th>所需权限</th><th>开关</th></tr></thead>
            <tbody>
              {skills.filter((s) => s.isBuiltin).map((s) => (
                <tr key={s.id}>
                  <td><code>{s.id}</code></td>
                  <td>{s.agentDefinitionId ? <code>{s.agentDefinitionId}</code> : '-'}</td>
                  <td>{s.requiredCapabilities.map((c) => <code key={c} style={{ marginRight: 4 }}>{c}</code>)}</td>
                  <td>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={s.enabled}
                      className={`toggle-switch${s.enabled ? ' toggle-switch--on' : ''}`}
                      onClick={() => void toggleSkill(s.id, !s.enabled)}
                    ><span /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Tool 配置 */}
      <div className="system-info-card">
        <h4><Wrench size={16} /> Tool 工具配置 <span className="capability-count">{tools.length}</span></h4>
        <div className="capability-tool-list">
          {tools.map((t) => (
            <div key={t.id} className={`capability-tool-row${t.enabled ? '' : ' capability-tool-row--disabled'}`}>
              <div className="capability-tool-row__info">
                <strong>{t.name}</strong>
                <span>{t.description}</span>
                {editingTool === t.id && (
                  <div className="capability-tool-row__config">
                    {Object.entries(t.config).map(([key, value]) => (
                      <label key={key}>
                        <span>{key}</span>
                        <input defaultValue={value} placeholder={key} />
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="capability-tool-row__actions">
                <button
                  type="button"
                  className="secondary-button secondary-button--small"
                  onClick={() => setEditingTool(editingTool === t.id ? null : t.id)}
                >
                  <Settings2 size={13} /> {editingTool === t.id ? '收起' : '配置'}
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={t.enabled}
                  className={`toggle-switch${t.enabled ? ' toggle-switch--on' : ''}`}
                  onClick={() => toggleTool(t.id)}
                ><span /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* MCP Server 配置 */}
      <div className="system-info-card">
        <h4><Server size={16} /> MCP Server 配置 <span className="capability-count">{mcpServers.length}</span></h4>
        <div className="capability-mcp-list">
          {mcpServers.map((s) => (
            <div key={s.id} className={`capability-mcp-row${s.enabled ? '' : ' capability-mcp-row--disabled'}`}>
              <span className="capability-mcp-row__icon">
                {mcpStatusIcon(s.status)}
              </span>
              <div className="capability-mcp-row__info">
                <strong>{s.name}</strong>
                <span className="capability-mcp-row__transport">{s.transport === 'stdio' ? <><TerminalSquare size={11} /> stdio</> : <><Globe size={11} /> SSE</>}</span>
                <code className="capability-mcp-row__addr">{s.transport === 'stdio' ? s.command : s.url}</code>
              </div>
              <span className={`channel-tag channel-tag--${s.status === 'connected' ? 'ok' : s.status === 'error' ? 'off' : 'off'}`}>{s.status}</span>
              <button
                type="button"
                role="switch"
                aria-checked={s.enabled}
                className={`toggle-switch${s.enabled ? ' toggle-switch--on' : ''}`}
                onClick={() => void toggleMcpServer(s.id)}
              ><span /></button>
            </div>
          ))}
        </div>
        <button type="button" className="add-agent-button" onClick={() => setMcpAddOpen(true)} style={{ marginTop: 12 }}><Plus size={15} /> 添加 MCP Server</button>
        {mcpAddOpen && <McpServerAddDialog onClose={() => setMcpAddOpen(false)} onAdded={() => setMcpAddOpen(false)} />}
      </div>
    </div>
  );
}

function McpServerAddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    if (!name.trim() || (transport === 'stdio' && !command.trim()) || (transport === 'sse' && !url.trim())) return;
    setSaving(true);
    try {
      const payload: { name: string; transport: string; command?: string; url?: string } = { name: name.trim(), transport };
      if (command.trim()) payload.command = command.trim();
      if (url.trim()) payload.url = url.trim();
      const res = await (window.kunqing?.settings.addMcpServer(payload) as Promise<{ ok: boolean; data?: McpServerConfig }> | undefined);
      if (res?.ok) onAdded();
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="agent-dialog channel-dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <div><h3>添加 MCP Server</h3><p>配置 MCP 协议服务器，扩展智能体能力。</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <label><span>名称 *</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：本地文件系统" /></label>
        <label>
          <span>传输协议</span>
          <select value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'sse')}>
            <option value="stdio">STDIO（子进程）</option>
            <option value="sse">SSE（HTTP 端点）</option>
          </select>
        </label>
        {transport === 'stdio' ? (
          <label><span>启动命令 *</span><input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="例如：npx @modelcontextprotocol/server-filesystem" /></label>
        ) : (
          <label><span>端点 URL *</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></label>
        )}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={saving || !name.trim() || (transport === 'stdio' && !command.trim()) || (transport === 'sse' && !url.trim())} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface StudioStatus {
  initialized: boolean; workspaceId: string; schemaVersion: number; rootPath: string;
}

function KStudioSettings(): React.JSX.Element {
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    (window.kunqing?.studio.getStatus() as Promise<{ ok: boolean; data: StudioStatus }> | undefined)
      ?.then((res) => { if (res?.data) setStatus(res.data); })
      .catch(() => {});
  }, []);

  return (
    <div className="settings-page">
      <SettingsHeading title="K_Studio" description="管理 K_Studio 工作区的根目录、标识和完整性。" />
      <div className="system-info-card">
        <h4><FolderOpen size={16} /> 工作区根目录</h4>
        <code className="system-path">{status?.rootPath || '加载中...'}</code>
        <button type="button" className="secondary-button secondary-button--small"
          onClick={() => window.kunqing?.app.openExternal({ url: status?.rootPath ?? '' }).catch(() => {})}
          disabled={!status?.rootPath}>
          <ExternalLink size={14} /> 在文件管理器中打开
        </button>
      </div>
      <div className="system-info-card">
        <h4><Info size={16} /> 工作区信息</h4>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 10, margin: 0 }}>
          <dt style={{ color: 'var(--kq-text-tertiary)' }}>初始化状态</dt>
          <dd>{status?.initialized ? '已初始化' : '未初始化'}</dd>
          <dt style={{ color: 'var(--kq-text-tertiary)' }}>工作区 ID</dt>
          <dd><code>{status?.workspaceId || '-'}</code></dd>
          <dt style={{ color: 'var(--kq-text-tertiary)' }}>Schema 版本</dt>
          <dd>v{status?.schemaVersion ?? '-'}</dd>
        </dl>
      </div>
      <div className="system-info-card">
        <h4><ShieldCheck size={16} /> 完整性检查</h4>
        <p>验证 K_Studio marker 文件、目录结构和数据库完整性。</p>
        <button type="button" className="secondary-button secondary-button--small" onClick={async () => {
          setChecking(true);
          try {
            const res = await (window.kunqing?.studio.validate({ rootPath: status?.rootPath ?? '' }) as Promise<{ ok: boolean; data: { valid: boolean; reason?: string } }> | undefined);
            if (res?.data?.valid) alert('K_Studio 完整性检查通过');
            else alert(`完整性检查失败: ${res?.data?.reason ?? '未知错误'}`);
          } catch { alert('检查失败'); }
          setChecking(false);
        }} disabled={checking || !status?.rootPath}>立即检查</button>
      </div>
    </div>
  );
}

function AppearanceSettings(): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');

  const applyTheme = (t: 'light' | 'dark' | 'system'): void => {
    if (t === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
  };

  useEffect(() => {
    (window.kunqing?.settings.getAll() as Promise<{ ok: boolean; data: Record<string, unknown> }> | undefined)
      ?.then((res) => {
        const saved = res?.data?.theme as 'light' | 'dark' | 'system' | undefined;
        if (saved) { setTheme(saved); applyTheme(saved); }
      })
      .catch(() => {});

    // 监听系统主题变化（当 theme === 'system' 时自动切换）
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => { if (theme === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const changeTheme = (t: 'light' | 'dark' | 'system'): void => {
    setTheme(t);
    applyTheme(t);
    window.kunqing?.settings.update({ theme: t }).catch(() => {});
  };

  const themeOptions = [
    { value: 'light' as const, icon: <Sun size={20} />, label: '亮色', desc: '浅色背景，适合白天使用' },
    { value: 'dark' as const, icon: <Moon size={20} />, label: '暗色', desc: '深色背景，适合夜间使用' },
    { value: 'system' as const, icon: <Monitor size={20} />, label: '跟随系统', desc: '根据系统主题自动切换' },
  ];

  return (
    <div className="settings-page">
      <SettingsHeading title="外观" description="切换亮色 / 暗色 / 跟随系统主题。" />
      <div className="theme-selector">
        {themeOptions.map((opt) => (
          <button
            type="button"
            key={opt.value}
            className={`theme-card${theme === opt.value ? ' theme-card--active' : ''}`}
            onClick={() => changeTheme(opt.value)}
          >
            {opt.icon}
            <strong>{opt.label}</strong>
            <span>{opt.desc}</span>
            {theme === opt.value && <CheckCircle2 size={18} className="theme-check" />}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ScanFinding {
  location: string; column: string; pattern: string; sample: string; severity: string;
}

interface ScanData {
  passed: boolean; findings: ScanFinding[]; scannedTables: number; scannedRows: number; scannedLogFiles: number;
}

function SystemSettings(): React.JSX.Element {
  const [rootPath, setRootPath] = useState('');
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanData | null>(null);

  useEffect(() => {
    (window.kunqing?.app.bootstrap() as Promise<{ ok: boolean; data: { workspacePath?: string } }> | undefined)
      ?.then((res) => { if (res?.data?.workspacePath) setRootPath(res.data.workspacePath); })
      .catch(() => {});
  }, []);

  const exportDiagnostics = async (): Promise<void> => {
    setExporting(true);
    setDiagResult(null);
    try {
      const res = await (window.kunqing?.settings.exportDiagnostics() as Promise<{ ok: boolean; data: Record<string, unknown> }> | undefined);
      if (res?.data) setDiagResult(JSON.stringify(res.data, null, 2));
      else setDiagResult('导出失败');
    } catch { setDiagResult('导出异常'); }
    setExporting(false);
  };

  const copyToClipboard = (): void => {
    if (diagResult) navigator.clipboard.writeText(diagResult).catch(() => {});
  };

  const runScan = async (): Promise<void> => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await (window.kunqing?.settings.scanSecrets() as Promise<{ ok: boolean; data: ScanData }> | undefined);
      if (res?.data) setScanResult(res.data);
    } catch { /* ignore */ }
    setScanning(false);
  };

  return (
    <div className="settings-page">
      <SettingsHeading title="系统" description="K_Studio 根目录、完整性检查、日志级别、导出诊断包。" />
      <div className="system-info-card">
        <h4><FolderOpen size={16} /> 工作区根目录</h4>
        <code className="system-path">{rootPath || '加载中...'}</code>
        <button type="button" className="secondary-button secondary-button--small" onClick={() => window.kunqing?.app.openExternal({ url: rootPath }).catch(() => {})} disabled={!rootPath}>
          <ExternalLink size={14} /> 在文件管理器中打开
        </button>
      </div>
      <div className="system-info-card">
        <h4><ShieldCheck size={16} /> 完整性检查</h4>
        <p>验证工作区结构、配置和数据库完整性。</p>
        <button type="button" className="secondary-button secondary-button--small" onClick={async () => {
          try {
            const res = await (window.kunqing?.studio.validate({ rootPath }) as Promise<{ ok: boolean; data: { valid: boolean } }> | undefined);
            if (res?.data?.valid) alert('工作区完整性检查通过');
            else alert('工作区结构异常，请检查文件系统');
          } catch { alert('检查失败'); }
        }} disabled={!rootPath}>立即检查</button>
      </div>
      <div className="system-info-card">
        <h4><Key size={16} /> 密钥扫描</h4>
        <p>扫描数据库和日志中是否存在明文凭证泄露。此检查不会将数据发送到外部。</p>
        <button type="button" className="secondary-button" onClick={() => void runScan()} disabled={scanning}>
          {scanning ? '扫描中...' : '开始密钥扫描'}
        </button>
        {scanResult && (
          <div style={{ marginTop: 12 }}>
            {scanResult.passed ? (
              <p style={{ color: 'var(--kq-success)' }}><CheckCircle2 size={14} /> 扫描通过，未发现明文密钥泄露</p>
            ) : (
              <>
                <p style={{ color: 'var(--kq-danger)' }}><ShieldOff size={14} /> 发现 {scanResult.findings.length} 个潜在泄露</p>
                <table className="scan-findings-table">
                  <thead><tr><th>位置</th><th>字段</th><th>模式</th><th>样本</th><th>严重度</th></tr></thead>
                  <tbody>
                    {scanResult.findings.map((f, i) => (
                      <tr key={i}>
                        <td>{f.location}</td>
                        <td>{f.column}</td>
                        <td><code>{f.pattern}</code></td>
                        <td><code>{f.sample}</code></td>
                        <td>{f.severity === 'high' ? <AlertTriangle size={14} /> : null}{f.severity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <p style={{ fontSize: 12, color: 'var(--kq-text-tertiary)' }}>
              已扫描 {scanResult.scannedTables} 个表、{scanResult.scannedRows} 行、{scanResult.scannedLogFiles} 个日志文件
            </p>
          </div>
        )}
      </div>
      <div className="system-info-card">
        <h4><ClipboardList size={16} /> 诊断信息</h4>
        <p>导出环境信息、版本号和配置状态，用于调试和问题反馈。</p>
        <button type="button" className="secondary-button" onClick={() => void exportDiagnostics()} disabled={exporting}>
          {exporting ? '导出中...' : '导出诊断信息'}
        </button>
        {diagResult && (
          <div className="diag-output">
            <pre>{diagResult}</pre>
            <button type="button" className="secondary-button secondary-button--small" onClick={copyToClipboard}>复制到剪贴板</button>
          </div>
        )}
      </div>
    </div>
  );
}

function AboutSettings(): React.JSX.Element {
  const [version, setVersion] = useState('');
  const [platform, setPlatform] = useState('');

  useEffect(() => {
    const v = window.kunqing?.app.getVersion() as Promise<string> | undefined;
    if (v) v.then((s) => setVersion(s)).catch(() => setVersion('0.1.0'));
    else setVersion('0.1.0');
  }, []);

  useEffect(() => {
    const p = (window.kunqing?.app.bootstrap() as Promise<{ ok: boolean; data: { workspacePath?: string } }> | undefined)
      ?.then((res) => { if (res?.data?.workspacePath) setPlatform(navigator.platform); })
      .catch(() => setPlatform(navigator.platform));
  }, []);

  return (
    <div className="settings-page">
      <SettingsHeading title="关于" description="版本、构建号、Electron / Chromium / Node 版本与开源许可。" />
      <div className="about-cards">
        <div className="about-card">
          <h4><Info size={16} /> K_Studio</h4>
          <dl>
            <dt>版本</dt>
            <dd><code>{version || '加载中...'}</code></dd>
            <dt>平台</dt>
            <dd>{platform || navigator.platform}</dd>
            <dt>架构</dt>
            <dd>{navigator.userAgent.includes('x64') ? 'x86_64' : 'arm64'}</dd>
          </dl>
        </div>
        <div className="about-card">
          <h4><Cpu size={16} /> 运行时</h4>
          <dl>
            <dt>Electron</dt>
            <dd><code>{navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] ?? '-'}</code></dd>
            <dt>Chrome</dt>
            <dd><code>{navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '-'}</code></dd>
            <dt>Node</dt>
            <dd><code>{navigator.userAgent.match(/Node\/([\d.]+)/)?.[1] ?? '-'}</code></dd>
            <dt>V8</dt>
            <dd><code>{navigator.userAgent.match(/(?:V8|v8)\/([\d.]+)/)?.[1] ?? '-'}</code></dd>
          </dl>
        </div>
        <div className="about-card">
          <h4><ShieldCheck size={16} /> 许可与致谢</h4>
          <p>K_Studio 使用 MIT 许可证。使用到的开源组件包括 React、Electron、TypeScript、LangGraph、 better-sqlite3 等。</p>
          <a className="text-link" href="#" onClick={(e) => { e.preventDefault(); window.kunqing?.app.openExternal({ url: 'https://github.com/anomalco/kunqing' }).catch(() => {}); }}>查看完整开源许可 <ExternalLink size={13} /></a>
        </div>
      </div>
    </div>
  );
}

// ─── 渠道配置 ──────────────────────────────────────────────────────────────

type ChannelType = 'telegram' | 'lark' | 'dingtalk' | 'wecom-webhook';

interface ChannelConfigFields {
  type: ChannelType;
  /** 每个渠道类型对应的配置字段定义 */
  fields: Array<{ key: string; label: string; placeholder: string; type: 'text' | 'password' | 'url' }>;
  /** 默认配置值 */
  defaults: Record<string, string>;
  /** 测试提示文案 */
  testHint: string;
}

const CHANNEL_CONFIGS: Record<ChannelType, ChannelConfigFields> = {
  telegram: {
    type: 'telegram',
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '例如: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', type: 'password' },
    ],
    defaults: { token: '' },
    testHint: '将使用 getMe API 验证 Token 有效性',
  },
  lark: {
    type: 'lark',
    fields: [
      { key: 'app_id', label: 'App ID', placeholder: '例如: cli_xxxxxxxxxxxxxx', type: 'text' },
      { key: 'app_secret', label: 'App Secret', placeholder: '输入应用凭证密钥', type: 'password' },
    ],
    defaults: { app_id: '', app_secret: '' },
    testHint: '将请求 tenant_access_token 验证凭证',
  },
  dingtalk: {
    type: 'dingtalk',
    fields: [
      { key: 'app_key', label: 'App Key', placeholder: '例如: dingxxxxxxxxxxxx', type: 'text' },
      { key: 'app_secret', label: 'App Secret', placeholder: '输入应用密钥', type: 'password' },
    ],
    defaults: { app_key: '', app_secret: '' },
    testHint: '将请求 access_token 验证凭证',
  },
  'wecom-webhook': {
    type: 'wecom-webhook',
    fields: [
      { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...', type: 'url' },
      { key: 'key', label: '密钥 (Key)', placeholder: 'Webhook URL 中的 key 参数', type: 'password' },
    ],
    defaults: { webhook_url: '', key: '' },
    testHint: '将请求企业微信 API 验证 Webhook 有效性',
  },
};

interface RecentActivity {
  id: string;
  channelType: string;
  channelName: string;
  action: 'connected' | 'disconnected' | 'message_received' | 'message_sent' | 'error';
  summary: string;
  timestamp: string;
}

const MOCK_RECENT_ACTIVITIES: RecentActivity[] = [
  { id: 'a1', channelType: 'telegram', channelName: 'Telegram', action: 'connected', summary: 'Bot 已连接，开始长轮询', timestamp: '2026-07-22 14:32:10' },
  { id: 'a2', channelType: 'lark', channelName: '飞书 / Lark', action: 'message_received', summary: '收到群聊「产品组」消息', timestamp: '2026-07-22 13:15:44' },
  { id: 'a3', channelType: 'dingtalk', channelName: '钉钉', action: 'disconnected', summary: 'Token 已过期，等待重连', timestamp: '2026-07-22 11:08:22' },
  { id: 'a4', channelType: 'wecom-webhook', channelName: '企业微信群机器人', action: 'message_sent', summary: '发送「发布通知」到群聊「全员群」', timestamp: '2026-07-22 09:50:01' },
  { id: 'a5', channelType: 'telegram', channelName: 'Telegram', action: 'message_received', summary: '收到用户 @user123 的私聊消息', timestamp: '2026-07-22 09:12:33' },
];

function ChannelsSettings(): React.JSX.Element {
  const [channels, setChannels] = useState<Array<{ id: string; type: string; name: string; enabled: boolean; status: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [activities] = useState<RecentActivity[]>(MOCK_RECENT_ACTIVITIES);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await (window.kunqing?.channels.list() as Promise<{ ok: boolean; data: Array<{ id: string; type: string; name: string; enabled: boolean; status: string; configJson?: Record<string, unknown> }> }> | undefined);
      if (res?.data) setChannels(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Subscribe to real-time channel events to update status
  useEffect(() => {
    const unsub = window.kunqing?.events.subscribeChannels((event) => {
      if (event.type === 'channel.status') {
        const status = (event.data as { status: string }).status;
        setChannels((prev) => prev.map((c) =>
          c.id === event.channelId
            ? { ...c, status: status === 'connected' ? 'connected' : status === 'disconnected' ? 'disconnected' : status }
            : c,
        ));
      }
    });
    return () => unsub?.();
  }, []);

  const toggle = async (id: string, currentEnabled: boolean): Promise<void> => {
    try {
      setChannels((prev) => prev.map((c) => c.id === id ? { ...c, enabled: !currentEnabled, status: !currentEnabled ? 'connecting' : 'disconnected' } : c));
      await window.kunqing?.channels.setEnabled({ channelId: id, enabled: !currentEnabled });
    } catch { /* ignore */ }
  };

  const iconMap: Record<string, React.ReactNode> = { telegram: <MessageSquareMore size={19} />, lark: <Webhook size={19} />, dingtalk: <Zap size={19} />, 'wecom-webhook': <MessageSquareMore size={19} /> };
  const labelMap: Record<string, string> = { telegram: 'Telegram', lark: '飞书 / Lark', dingtalk: '钉钉', 'wecom-webhook': '企业微信群机器人' };
  const detailMap: Record<string, string> = { telegram: 'Bot Long Polling · 双向', lark: 'WebSocket 长连接 · 双向', dingtalk: 'Stream 模式 · 双向', 'wecom-webhook': 'Webhook · 仅出站' };

  const activityIcon = (action: RecentActivity['action']): React.ReactNode => {
    switch (action) {
      case 'connected': return <CheckCircle2 size={13} style={{ color: 'var(--kq-success)' }} />;
      case 'disconnected': return <Cable size={13} style={{ color: 'var(--kq-warning)' }} />;
      case 'message_received': return <MessageSquareMore size={13} style={{ color: 'var(--kq-primary)' }} />;
      case 'message_sent': return <Send size={13} style={{ color: 'var(--kq-primary)' }} />;
      case 'error': return <AlertTriangle size={13} style={{ color: 'var(--kq-danger)' }} />;
    }
  };

  const activityLabel = (action: RecentActivity['action']): string => {
    switch (action) {
      case 'connected': return '已连接';
      case 'disconnected': return '已断开';
      case 'message_received': return '收到消息';
      case 'message_sent': return '发送消息';
      case 'error': return '错误';
    }
  };

  const connectedCount = channels.filter((c) => c.enabled).length;
  const totalRequests = 128; // 模拟数据

  return (
    <div className="settings-page channels-page">
      <SettingsHeading
        title="渠道配置"
        description="连接 Telegram、飞书、钉钉和企业微信群机器人，让群聊可从本地工作站收发消息。"
        action={<button type="button" className="primary-button" onClick={() => setAddOpen(true)}><Plus size={15} /> 添加渠道</button>}
      />
      <div className="channel-guide">
        <span><b>1</b><CheckCircle2 size={14} /> 选择一个渠道并完成凭据配置</span>
        <span><b>2</b><Activity size={14} /> 启用后在本机常驻监听，由群聊 Leader 处理消息</span>
      </div>
      {loading ? (
        <div className="settings-loading"><Loader2 size={20} className="spin" /> 加载中...</div>
      ) : (
      <>
      <div className="channel-dashboard">
        <div className="channel-list">
          {channels.length === 0 && <p className="model-empty">尚未配置渠道</p>}
          {channels.map((channel) => (
            <article className="channel-row" key={channel.id}>
              <button type="button" className="channel-expand" aria-label={`展开 ${channel.name}`}><ChevronDown size={15} /></button>
              <span className="channel-icon">{iconMap[channel.type] ?? <Cable size={19} />}</span>
              <div>
                <strong>{labelMap[channel.type] ?? channel.name}</strong>
                <span>{detailMap[channel.type] ?? ''}</span>
              </div>
              <em className={`channel-tag channel-tag--${channel.enabled && channel.status === 'connected' ? 'ok' : 'off'}`}>{channel.status}</em>
              <button type="button" role="switch" aria-checked={channel.enabled} className={`toggle-switch${channel.enabled ? ' toggle-switch--on' : ''}`} onClick={() => void toggle(channel.id, channel.enabled)}><span /></button>
            </article>
          ))}
        </div>
        <aside className="realtime-card">
          <header><h3>实时概览</h3><Gauge size={18} /></header>
          <div className="realtime-card__metrics">
            <span><small>今日请求</small><strong>{totalRequests}</strong><em>总消息数</em></span>
            <span><small>连接渠道</small><strong>{connectedCount}/{channels.length}</strong><em>{connectedCount > 0 ? '运行正常' : '全部离线'}</em></span>
            <span><small>在线时长</small><strong>3h 42m</strong><em>今日累计</em></span>
            <span><small>错误率</small><strong>0.8%</strong><em>过去 24h</em></span>
          </div>
          <div className="realtime-card__bar">
            {channels.map((c, i) => (
              <span
                key={c.id}
                className={`realtime-card__bar-seg${c.enabled ? ' realtime-card__bar-seg--active' : ''}`}
                style={{ width: `${100 / channels.length}%` }}
                title={`${c.name}: ${c.enabled ? '已连接' : '离线'}`}
              />
            ))}
          </div>
        </aside>
      </div>
      <div className="channel-bottom">
        <article>
          <header>
            <h3><Activity size={15} /> 最近活动</h3>
            <button type="button" onClick={() => {}}>查看全部</button>
          </header>
          {activities.length === 0 ? (
            <p className="model-empty" style={{ marginTop: 16 }}>暂无活动记录</p>
          ) : (
            <ul>
              {activities.map((a) => (
                <li key={a.id}>
                  {activityIcon(a.action)}
                  <span>
                    <strong>
                      <span className={`channel-activity-tag channel-activity-tag--${a.action}`}>{activityLabel(a.action)}</span>
                      {a.channelName}
                    </strong>
                    <small>{a.summary} · {a.timestamp}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>
        <aside>
          <div>
            <strong>系统状态</strong>
            <span>所有渠道运行正常，消息队列空闲</span>
          </div>
          <button type="button" title="刷新状态"><RefreshCw size={16} /></button>
        </aside>
      </div>
      </>
      )}
      {addOpen && <ChannelAddDialog
        onClose={() => setAddOpen(false)}
        onSaved={() => { setAddOpen(false); void load(); }}
      />}
    </div>
  );
}

function ChannelAddDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [type, setType] = useState<ChannelType>('telegram');
  const [config, setConfig] = useState<Record<string, string>>({ ...CHANNEL_CONFIGS.telegram.defaults });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const channelConfig = CHANNEL_CONFIGS[type];

  const handleTypeChange = (newType: string): void => {
    const t = newType as ChannelType;
    setType(t);
    setConfig({ ...CHANNEL_CONFIGS[t].defaults });
    setTestResult(null);
    setSavedId(null);
  };

  const updateConfig = (key: string, value: string): void => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const allFieldsFilled = (): boolean => {
    return channelConfig.fields.every((f) => (config[f.key] ?? '').trim().length > 0);
  };

  const buildSaveInput = (): { type: string; name: string; config: Record<string, string>; secret?: string } => {
    const cname = labelMap[type] ?? type;
    const { app_secret, ...rest } = config as Record<string, string>;
    return app_secret ? { type, name: cname, config: rest, secret: app_secret } : { type, name: cname, config: rest };
  };

  const handleSave = async (): Promise<void> => {
    if (!allFieldsFilled()) return;
    setSaving(true);
    setTestResult(null);
    try {
      const res = await (window.kunqing?.channels.save(buildSaveInput()) as Promise<{ ok: boolean; data: { id: string } }> | undefined);
      if (res?.ok) {
        setSavedId(res.data.id);
        onSaved();
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleTest = async (): Promise<void> => {
    if (!allFieldsFilled()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const saveRes = await (window.kunqing?.channels.save(buildSaveInput()) as Promise<{ ok: boolean; data: { id: string } }> | undefined);
      if (!saveRes?.ok) {
        setTestResult({ ok: false, message: '保存渠道失败' });
        setTesting(false);
        return;
      }
      const channelId = saveRes.data.id;
      setSavedId(channelId);

      // 测试连接
      const testRes = await (window.kunqing?.channels.test({ channelId }) as Promise<{ ok: boolean; data: { success: boolean; message: string } }> | undefined);
      if (testRes?.ok) {
        setTestResult({ ok: testRes.data.success, message: testRes.data.message });
      } else {
        setTestResult({ ok: false, message: '测试请求失败' });
      }
    } catch (err) {
      setTestResult({ ok: false, message: String(err) });
    }
    setTesting(false);
  };

  const labelMap: Record<string, string> = { telegram: 'Telegram', lark: '飞书 / Lark', dingtalk: '钉钉', 'wecom-webhook': '企业微信群机器人' };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="agent-dialog channel-dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h3>添加渠道</h3>
            <p>选择渠道类型并填写凭据信息，完成后可测试连通性。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <label>
          <span>渠道类型</span>
          <select value={type} onChange={(e) => handleTypeChange(e.target.value)}>
            <option value="telegram">Telegram</option>
            <option value="lark">飞书 / Lark</option>
            <option value="dingtalk">钉钉</option>
            <option value="wecom-webhook">企业微信群机器人</option>
            <option disabled>个人微信 — 即将上线</option>
            <option disabled>企业微信自建应用 — 即将上线</option>
          </select>
        </label>
        {channelConfig.fields.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              type={field.type}
              value={config[field.key] ?? ''}
              onChange={(e) => updateConfig(field.key, e.target.value)}
              placeholder={field.placeholder}
            />
          </label>
        ))}
        <p className="channel-test-hint"><TestTube2 size={13} /> {channelConfig.testHint}</p>
        {testResult && (
          <div className={`channel-test-result channel-test-result--${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span>{testResult.message}</span>
          </div>
        )}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="secondary-button" disabled={!allFieldsFilled() || testing} onClick={() => void handleTest()}>
            {testing ? <><Loader2 size={14} className="spin" /> 测试中…</> : <><TestTube2 size={14} /> 测试连通性</>}
          </button>
          <button type="button" className="primary-button" disabled={!allFieldsFilled() || saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}
