import { Bot, CheckCircle2, Copy, Cpu, Globe, Loader2, LockKeyhole, Plus, Puzzle, Search, Server, Settings2, Square, TerminalSquare, Unplug, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type AgentProfile = {
  id: string;
  name: string;
  definitionId: string;
  runtimeMode: string;
  modelProfileId?: string | null;
  adapterType?: string | null;
  enabled: boolean;
  isBuiltin: boolean;
  overrides?: { enabledSkills?: string[]; effectivePermissions?: string[]; modelOptions?: { temperature?: number; thinking?: boolean; thinkingLevel?: string } };
  executablePath?: string;
  detectedVersion?: string | null;
  isDetectedOnly?: boolean;
};

type ModelOption = { id: string; name: string; modelId: string; type: string };
type SkillOption = { id: string; name: string; description: string; enabled: boolean; agentDefinitionId?: string | null };
type AgentTab = '全部' | '官方内置' | '外接三方' | '自定义';
type ConnectionWizardComponent = React.ComponentType<{
  onClose: () => void;
  onAdded: () => void;
  initialAdapterType?: string;
}>;

type WorkBuddyStatus = { connected: boolean; connectionId?: string; profileId?: string | null; name?: string; endpoint?: string; status?: string; detectedVersion?: string | null; toolName?: string | null; toolCount?: number | null; authConfigured?: boolean };
type NeutralRelayStatus = { running: boolean; port: number; url: string; token: string; taskCount: number; pendingCount: number };

// WorkBuddy MCP is retained for a later implementation, but is intentionally
// hidden from the product surface until its task-consumer lifecycle is ready.
const WORKBUDDY_INTEGRATION_ENABLED = false;

function category(agent: AgentProfile): Exclude<AgentTab, '全部'> {
  if (agent.isBuiltin || agent.definitionId.startsWith('builtin.')) return '官方内置';
  if (agent.runtimeMode === 'external-cli') return '外接三方';
  return '自定义';
}

function isWorkBuddyProfile(agent: AgentProfile): boolean {
  return agent.adapterType === 'workbuddy' || agent.definitionId === 'custom.workbuddy';
}

function externalRoleLabel(agent: AgentProfile): string {
  if (agent.adapterType === 'codebuddy' || /codebuddy/i.test(`${agent.definitionId} ${agent.name}`)) return '验收智能体';
  if (agent.adapterType === 'kimi' || /kimi(?:\s|-)?code/i.test(`${agent.definitionId} ${agent.name}`)) return '代码编写智能体';
  return '外接三方智能体';
}

function defaultModelOptions(model: ModelOption | undefined): { temperature: number; thinking: boolean; thinkingLevel: string } {
  const identity = `${model?.type ?? ''} ${model?.modelId ?? ''}`.toLocaleLowerCase();
  const temperature = /deepseek|kimi|claude/.test(identity) ? 0.6 : 0.7;
  const thinking = /(reason|thinking|deepseek-v|r1|o1|o3|qwen3)/.test(identity);
  return { temperature, thinking, thinkingLevel: thinking ? 'medium' : 'none' };
}

function supportsTemperature(model: ModelOption | undefined, thinking: boolean): boolean {
  const identity = `${model?.type ?? ''} ${model?.modelId ?? ''}`.toLocaleLowerCase();
  return !(thinking && (/(?:^|\s|[-_.])(o1|o3|o4)(?:\s|[-_.]|$)|gpt-5/.test(identity) || /anthropic|claude/.test(identity)));
}

export function AgentManagementSettings({ ConnectionWizard }: { ConnectionWizard?: ConnectionWizardComponent }): React.JSX.Element {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<AgentTab>('全部');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<{ mode: 'model' | 'skills' | 'permissions'; agent: AgentProfile } | null>(null);
  const [connectionAgent, setConnectionAgent] = useState<AgentProfile | null>(null);
  const [workbuddyStatus, setWorkbuddyStatus] = useState<WorkBuddyStatus>({ connected: false });
  const [neutralRelayStatus, setNeutralRelayStatus] = useState<NeutralRelayStatus>({ running: false, port: 0, url: '', token: '', taskCount: 0, pendingCount: 0 });
  const [workbuddyOpen, setWorkbuddyOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const [agentResult, modelResult, skillResult, workbuddyResult, relayResult, detectedResult] = await Promise.all([
      window.kunqing?.agents.listProfiles() as Promise<{ ok?: boolean; data?: AgentProfile[] }> | undefined,
      window.kunqing?.models.listUnified() as Promise<{ ok?: boolean; data?: ModelOption[] }> | undefined,
      window.kunqing?.settings.listSkills() as Promise<{ ok?: boolean; data?: SkillOption[] }> | undefined,
      // WorkBuddy integration is currently hidden and older preload bundles may
      // not expose these methods. Treat both calls as optional so the settings
      // page remains usable while the integration is paused.
      window.kunqing?.agents?.getWorkBuddyStatus?.() as Promise<{ ok?: boolean; data?: WorkBuddyStatus }> | undefined,
      window.kunqing?.agents?.getNeutralRelayStatus?.() as Promise<{ ok?: boolean; data?: NeutralRelayStatus }> | undefined,
      window.kunqing?.agents.detectCli?.() as Promise<{ ok?: boolean; data?: Array<{ adapterType: string; executablePath: string; detectedVersion: string | null; status: string }> }> | undefined,
    ]);
    const saved = agentResult?.ok ? agentResult.data ?? [] : [];
    const savedTypes = new Set(saved.map((agent) => agent.adapterType).filter(Boolean));
    const detectedOnly = detectedResult?.ok
      ? (detectedResult.data ?? []).filter((item) => item.status === 'available' && !savedTypes.has(item.adapterType)).map((item) => ({
        id: `detected-${item.adapterType}`,
        name: item.adapterType === 'kimi' ? 'Kimi Code' : item.adapterType === 'codebuddy' ? 'CodeBuddy' : item.adapterType,
        definitionId: item.adapterType === 'kimi' ? 'custom.kimi-code' : item.adapterType === 'codebuddy' ? 'custom.codebuddy' : `custom.${item.adapterType}`,
        runtimeMode: 'external-cli', enabled: false, isBuiltin: false,
        adapterType: item.adapterType, executablePath: item.executablePath, detectedVersion: item.detectedVersion, isDetectedOnly: true,
      } satisfies AgentProfile))
      : [];
    setAgents([...saved, ...detectedOnly]);
    setModels(modelResult?.ok ? modelResult.data ?? [] : []);
    setSkills(skillResult?.ok ? skillResult.data ?? [] : []);
    if (workbuddyResult?.ok && workbuddyResult.data) setWorkbuddyStatus(workbuddyResult.data);
    if (relayResult?.ok && relayResult.data) setNeutralRelayStatus(relayResult.data);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => agents.filter((agent) => {
    const matchesTab = tab === '全部' || category(agent) === tab;
    const matchesQuery = !query.trim() || `${agent.name} ${agent.definitionId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    return matchesTab && matchesQuery;
  }), [agents, query, tab]);

  return <div className="settings-page settings-page--agent-management">
    <header className="settings-heading"><div><h2>智能体管理</h2><p>统一管理官方智能体、外接三方和自定义智能体的模型、技能与权限。</p></div>{WORKBUDDY_INTEGRATION_ENABLED && <button type="button" className="primary-button" onClick={() => setWorkbuddyOpen(true)}><Plus size={15} />接入 WorkBuddy</button>}</header>
    <div className="settings-filter-row">
      <div className="segmented-control">{(['全部', '官方内置', '外接三方', '自定义'] as const).map((item) => <button type="button" className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item}<span>{agents.filter((agent) => !isWorkBuddyProfile(agent) && (item === '全部' || category(agent) === item)).length}</span></button>)}</div>
      <label className="settings-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索智能体..." /></label>
    </div>
    {loading ? <div className="settings-loading"><Loader2 size={18} className="spin" />加载智能体...</div> : <div className="managed-agent-grid">
      {WORKBUDDY_INTEGRATION_ENABLED && (tab === '全部' || tab === '外接三方') && (!query.trim() || 'workbuddy 外接 mcp 中立 中继'.includes(query.trim().toLocaleLowerCase())) && <WorkBuddyCard status={workbuddyStatus} relayStatus={neutralRelayStatus} onConnect={() => setWorkbuddyOpen(true)} onRefresh={() => void load()} onRelayStatusChange={setNeutralRelayStatus} />}
      {visible.filter((agent) => !isWorkBuddyProfile(agent)).length === 0 && <div className="settings-empty-state"><Bot size={31} /><strong>没有匹配的智能体</strong></div>}
      {visible.filter((agent) => !isWorkBuddyProfile(agent)).map((agent) => {
        const mounted = models.find((model) => model.id === agent.modelProfileId);
        return <article className="managed-agent-card" key={agent.id}>
          <header><span>{agent.runtimeMode === 'external-cli' ? <TerminalSquare size={20} /> : <Bot size={20} />}</span><div><strong>{agent.name}</strong><small>{agent.runtimeMode === 'external-cli' ? `${category(agent)} · ${externalRoleLabel(agent)}` : category(agent)}</small></div><em>{agent.enabled ? '已启用' : '已停用'}</em></header>
          <dl><dt>身份定义</dt><dd>{agent.definitionId}</dd><dt>运行方式</dt><dd>{agent.runtimeMode === 'external-cli' ? '外接 CLI' : '本地模型智能体'}</dd><dt>挂载模型</dt><dd>{mounted ? `${mounted.name} · ${mounted.modelId}` : agent.runtimeMode === 'external-cli' ? '由外部智能体管理' : '使用默认槽位'}</dd></dl>
          <footer>
            <button type="button" onClick={() => setDialog({ mode: 'model', agent })}><Cpu size={14} />挂载模型</button>
            <button type="button" onClick={() => setDialog({ mode: 'skills', agent })}><Puzzle size={14} />技能管理</button>
            <button type="button" onClick={() => setDialog({ mode: 'permissions', agent })}><LockKeyhole size={14} />权限管理</button>
            {WORKBUDDY_INTEGRATION_ENABLED && agent.adapterType === 'workbuddy' ? <button type="button" onClick={() => setWorkbuddyOpen(true)}><Settings2 size={14} />配置接入</button> : agent.runtimeMode === 'external-cli' && agent.adapterType !== 'workbuddy' && ConnectionWizard && <button type="button" onClick={() => setConnectionAgent(agent)}><Settings2 size={14} />{agent.isDetectedOnly ? '接入此 CLI' : '配置接入'}</button>}
          </footer>
        </article>;
      })}
    </div>}
    {dialog?.mode === 'model' && <ModelMountDialog agent={dialog.agent} models={models} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} />}
    {dialog?.mode === 'skills' && <SkillManagementDialog agent={dialog.agent} skills={skills} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} />}
    {dialog?.mode === 'permissions' && <PermissionDialog agent={dialog.agent} onClose={() => setDialog(null)} />}
    {connectionAgent && ConnectionWizard && <ConnectionWizard {...(connectionAgent.adapterType ? { initialAdapterType: connectionAgent.adapterType } : {})} onClose={() => setConnectionAgent(null)} onAdded={() => { setConnectionAgent(null); void load(); }} />}
    {WORKBUDDY_INTEGRATION_ENABLED && workbuddyOpen && <WorkBuddyConnectionDialog status={workbuddyStatus} onClose={() => setWorkbuddyOpen(false)} onSaved={() => { setWorkbuddyOpen(false); void load(); }} />}
  </div>;
}

function WorkBuddyCard({ status, relayStatus, onConnect, onRefresh, onRelayStatusChange }: { status: WorkBuddyStatus; relayStatus: NeutralRelayStatus; onConnect: () => void; onRefresh: () => void; onRelayStatusChange: (status: NeutralRelayStatus) => void }): React.JSX.Element {
  const [relayWorking, setRelayWorking] = useState(false);
  const [relayMessage, setRelayMessage] = useState('');
  const disconnect = async (): Promise<void> => {
    await window.kunqing?.agents.disconnectWorkBuddy();
    onRefresh();
  };
  const startRelay = async (): Promise<void> => {
    setRelayWorking(true); setRelayMessage('');
    const result = await window.kunqing?.agents.startNeutralRelay() as { ok?: boolean; data?: NeutralRelayStatus; error?: { message?: string } } | undefined;
    setRelayWorking(false);
    if (result?.ok && result.data) onRelayStatusChange(result.data);
    else setRelayMessage(result?.error?.message || '中立 MCP 服务启动失败');
  };
  const stopRelay = async (): Promise<void> => {
    setRelayWorking(true); setRelayMessage('');
    const result = await window.kunqing?.agents.stopNeutralRelay() as { ok?: boolean; data?: NeutralRelayStatus; error?: { message?: string } } | undefined;
    setRelayWorking(false);
    if (result?.ok && result.data) onRelayStatusChange(result.data);
    else setRelayMessage(result?.error?.message || '中立 MCP 服务停止失败');
  };
  const copyRelayConfig = async (): Promise<void> => {
    if (!relayStatus.running || !relayStatus.url || !relayStatus.token) return;
    const config = JSON.stringify({ mcpServers: { neutralRelay: { type: 'streamableHttp', url: relayStatus.url, headers: { Authorization: `Bearer ${relayStatus.token}` } } } }, null, 2);
    try {
      await navigator.clipboard.writeText(config);
      setRelayMessage('配置已复制，可直接粘贴到 WorkBuddy 的 MCP 配置中');
    } catch {
      setRelayMessage('浏览器未授予剪贴板权限，请手动复制下方配置');
    }
  };
  return <article className="managed-agent-card managed-agent-card--workbuddy">
    <header><span><Globe size={20} /></span><div><strong>WorkBuddy</strong><small>外接三方 · MCP</small></div><em className={status.connected ? 'agent-status--connected' : ''}>{status.connected ? '已连接' : '未连接'}</em></header>
    <dl><dt>连接方式</dt><dd>WorkBuddy MCP Connector</dd><dt>地址</dt><dd>{status.endpoint || '尚未配置'}</dd><dt>认证状态</dt><dd>{status.connected ? (status.authConfigured ? '已配置认证' : '无认证头') : '连接后检测'}</dd><dt>可用工具</dt><dd>{status.connected ? (status.toolCount ? `${status.toolCount} 个工具，已完成握手` : '已完成握手，可加入群聊') : '连接后自动读取'}</dd></dl>
    <footer>{status.connected ? <><button type="button" onClick={onConnect}><Settings2 size={14} />配置接入</button><button type="button" onClick={() => void disconnect()}><Unplug size={14} />断开</button></> : <button type="button" className="primary-button" onClick={onConnect}><Plus size={14} />连接 WorkBuddy</button>}</footer>
    <section className="neutral-relay-panel">
      <div className="neutral-relay-heading"><div><strong><Server size={16} />中立 MCP 中继服务</strong><small>独立于 KLA 和 WorkBuddy，仅在本机回环地址提供任务中继。</small></div><em className={relayStatus.running ? 'agent-status--connected' : ''}>{relayStatus.running ? '运行中' : '未启动'}</em></div>
      {!relayStatus.running ? <button type="button" className="secondary-button neutral-relay-start" disabled={relayWorking} onClick={() => void startRelay()}>{relayWorking ? <><Loader2 size={14} className="spin" />启动中...</> : <><Server size={14} />启动中立 MCP 服务</>}</button> : <>
        <div className="neutral-relay-steps"><div><b>1</b><span>在 KLA 启动中立中继服务</span></div><div><b>2</b><span>复制配置，粘贴到 WorkBuddy 的 MCP / 连接器设置</span></div><div><b>3</b><span>在 WorkBuddy 启用该连接器，它会主动领取 KLA 投递的任务</span></div></div>
        <label className="neutral-relay-field"><span>MCP 地址</span><input readOnly value={relayStatus.url} onFocus={(event) => event.currentTarget.select()} /></label>
        <label className="neutral-relay-field"><span>临时 Token</span><input readOnly type="password" value={relayStatus.token} onFocus={(event) => event.currentTarget.select()} /></label>
        <div className="neutral-relay-config"><div><span>WorkBuddy 配置 JSON</span><code>{JSON.stringify({ mcpServers: { neutralRelay: { type: 'streamableHttp', url: relayStatus.url, headers: { Authorization: 'Bearer &lt;临时 Token&gt;' } } } }, null, 2)}</code></div><button type="button" className="secondary-button" onClick={() => void copyRelayConfig()}><Copy size={14} />复制配置</button></div>
        <div className="neutral-relay-meta">待处理任务 {relayStatus.pendingCount} · 已传递任务 {relayStatus.taskCount}</div>
        <button type="button" className="text-button neutral-relay-stop" disabled={relayWorking} onClick={() => void stopRelay()}>{relayWorking ? <><Loader2 size={13} className="spin" />停止中...</> : <><Square size={13} />停止中继服务</>}</button>
      </>}
      {relayMessage && <p className="neutral-relay-message">{relayMessage}</p>}
    </section>
  </article>;
}

function WorkBuddyConnectionDialog({ status, onClose, onSaved }: { status: WorkBuddyStatus; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [name, setName] = useState(status.name || 'WorkBuddy');
  const [transport, setTransport] = useState<'streamableHttp' | 'sse'>('streamableHttp');
  const [url, setUrl] = useState(status.endpoint || 'https://mcp.wkinfo.com.cn/mcp-servers/integrated/');
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [apiKey, setApiKey] = useState('');
  const [toolName, setToolName] = useState(status.toolName || '');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const importConfig = async (): Promise<void> => {
    const result = await window.kunqing?.agents.importWorkBuddyConfig() as { ok?: boolean; data?: { name?: string; transport?: string; url?: string; timeoutMs?: number; headers?: Record<string, string> } | null } | undefined;
    if (!result?.data || !(result.data as { url?: string }).url) { setError('WorkBuddy 配置文件存在，但没有可用的 MCP Server。请在 WorkBuddy 中先添加连接器，或手动填写 MCP 地址。'); return; }
    setName(result.data.name || 'WorkBuddy');
    setTransport(result.data.transport === 'sse' ? 'sse' : 'streamableHttp');
    setUrl(result.data.url || '');
    setTimeoutMs(Number(result.data.timeoutMs ?? 60000));
    const authorization = result.data.headers?.Authorization || result.data.headers?.authorization || '';
    if (authorization) setApiKey(authorization.replace(/^Bearer\s+/i, ''));
    setError('');
  };
  const save = async (): Promise<void> => {
    if (!url.trim()) { setError('请输入 WorkBuddy MCP 地址'); return; }
    setWorking(true); setError('');
    const headers = apiKey.trim() ? { Authorization: /^Bearer\s/i.test(apiKey.trim()) ? apiKey.trim() : `Bearer ${apiKey.trim()}` } : null;
    const payload = { name: name.trim() || 'WorkBuddy', transport, url: url.trim(), timeoutMs: Math.max(5000, Math.min(600000, timeoutMs)), ...(headers ? { headers } : {}), ...(toolName.trim() ? { toolName: toolName.trim() } : {}) };
    const result = await window.kunqing?.agents.connectWorkBuddy(payload) as { ok?: boolean; error?: { message?: string }; data?: unknown } | undefined;
    setWorking(false);
    if (result?.ok) onSaved(); else setError(result?.error?.message || '连接失败，请检查地址和认证信息');
  };
  return <div className="modal-backdrop modal-backdrop--nested" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="agent-dialog agent-management-dialog" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <header><div><h3>接入 WorkBuddy</h3><p>KLA 作为 MCP Client 调用 WorkBuddy 的 MCP 能力。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
    <label><span>显示名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label><span>传输方式</span><select value={transport} onChange={(event) => setTransport(event.target.value as 'streamableHttp' | 'sse')}><option value="streamableHttp">Streamable HTTP</option><option value="sse">SSE</option></select></label>
    <label><span>MCP 地址 *</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://.../mcp" /></label>
    <label><span>请求超时（毫秒）</span><input type="number" min={5000} max={600000} step={1000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value) || 60000)} /></label>
    <label><span>认证 Token（可选）</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Bearer Token" /></label>
    <label><span>任务工具名称（可选）</span><input value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder="留空则按工具描述自动匹配" /></label>
    {error && <p className="dialog-error">{error}</p>}
    <div className="dialog-hint"><CheckCircle2 size={15} />可点击“从 WorkBuddy 配置读取”，导入 <code>~/.workbuddy/mcp.json</code> 或本地 Connector Proxy 的连接。若地址是 KLA 当前启动的中立 MCP 中继，测试时会自动使用当前会话 Token，无需从 WorkBuddy 反向填写。</div>
    <footer><button type="button" className="secondary-button" onClick={() => void importConfig()}>从 WorkBuddy 配置读取</button><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={working}>{working ? <><Loader2 size={14} className="spin" />连接中...</> : '测试并连接'}</button></footer>
  </form></div>;
}

function ModelMountDialog({ agent, models, onClose, onSaved }: { agent: AgentProfile; models: ModelOption[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const initialModel = models.find((model) => model.id === agent.modelProfileId) ?? models[0];
  const defaults = defaultModelOptions(initialModel);
  const [modelId, setModelId] = useState(initialModel?.id ?? '');
  const [temperature, setTemperature] = useState(agent.overrides?.modelOptions?.temperature ?? defaults.temperature);
  const [thinking, setThinking] = useState(agent.overrides?.modelOptions?.thinking ?? defaults.thinking);
  const [thinkingLevel, setThinkingLevel] = useState(agent.overrides?.modelOptions?.thinkingLevel ?? defaults.thinkingLevel);
  const [saving, setSaving] = useState(false);
  const selectedModel = models.find((model) => model.id === modelId);
  const temperatureEnabled = supportsTemperature(selectedModel, thinking);

  const selectModel = (id: string): void => {
    setModelId(id);
    const next = defaultModelOptions(models.find((model) => model.id === id));
    setTemperature(next.temperature); setThinking(next.thinking); setThinkingLevel(next.thinkingLevel);
  };
  const save = async (): Promise<void> => {
    if (!modelId) return;
    setSaving(true);
    const result = await window.kunqing?.agents.updateProfileModel({ profileId: agent.id, modelProfileId: modelId, temperature, thinking, thinkingLevel }) as { ok?: boolean } | undefined;
    setSaving(false);
    if (result?.ok) onSaved();
  };
  return <DialogShell title={`为 ${agent.name} 挂载模型`} description="参数会随智能体任务快照保存。" onClose={onClose}>
    {models.length === 0 ? <p className="dialog-empty">请先在模型管理中添加模型。</p> : <>
      <label><span>模型选择</span><select value={modelId} onChange={(event) => selectModel(event.target.value)}>{models.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.modelId}</option>)}</select></label>
      <label><span>Temperature</span><input type="number" min="0" max="2" step="0.1" disabled={!temperatureEnabled} value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />{!temperatureEnabled && <small className="dialog-field-hint">当前思考模式由模型控制温度</small>}</label>
      <label className="dialog-toggle"><span><strong>Thinking</strong><small>允许模型使用思考模式</small></span><input type="checkbox" checked={thinking} onChange={(event) => { setThinking(event.target.checked); if (!event.target.checked) setThinkingLevel('none'); }} /></label>
      <label><span>思考等级</span><select value={thinkingLevel} disabled={!thinking} onChange={(event) => setThinkingLevel(event.target.value)}><option value="none">none</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
    </>}
    <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={!modelId || saving} onClick={() => void save()}>{saving ? '保存中...' : '确认挂载'}</button></footer>
  </DialogShell>;
}

function SkillManagementDialog({ agent, skills, onClose, onSaved }: { agent: AgentProfile; skills: SkillOption[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const official = category(agent) === '官方内置';
  const bound = skills.filter((skill) => skill.agentDefinitionId === agent.definitionId);
  const initial = agent.overrides?.enabledSkills ?? (official ? bound.map((skill) => skill.id) : []);
  const [selected, setSelected] = useState(new Set(initial));
  const [saving, setSaving] = useState(false);
  const shown = official ? bound : skills;
  const save = async (): Promise<void> => {
    if (official) { onClose(); return; }
    setSaving(true);
    const result = await window.kunqing?.agents.updateProfileSkills({ profileId: agent.id, enabledSkills: [...selected] }) as { ok?: boolean } | undefined;
    setSaving(false);
    if (result?.ok) onSaved();
  };
  return <DialogShell title={`${agent.name} · 技能管理`} description={official ? '官方内置智能体的技能由产品维护，不可添加或删除。' : '选择该智能体可以读取和调用的技能。'} onClose={onClose}>
    <div className="agent-skill-list">{shown.length === 0 ? <p className="dialog-empty">当前没有可展示的技能。</p> : shown.map((skill) => <label key={skill.id} className={official ? 'agent-skill-row agent-skill-row--readonly' : 'agent-skill-row'}><input type="checkbox" disabled={official} checked={selected.has(skill.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(skill.id); else next.delete(skill.id); return next; })} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>)}</div>
    <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{official ? '知道了' : saving ? '保存中...' : '保存技能'}</button></footer>
  </DialogShell>;
}

function PermissionDialog({ agent, onClose }: { agent: AgentProfile; onClose: () => void }): React.JSX.Element {
  const options = ['读取群聊消息', '读取工作区', '写入工作区', '调用工具', '网络访问'];
  const selected = new Set(agent.overrides?.effectivePermissions ?? options.slice(0, 3));
  return <DialogShell title={`${agent.name} · 权限管理`} description="当前沿用已有权限配置，细粒度策略将在后续补充。" onClose={onClose}>
    <div className="agent-skill-list">{options.map((option) => <label className="agent-skill-row agent-skill-row--readonly" key={option}><input type="checkbox" disabled checked={selected.has(option)} readOnly /><span><strong>{option}</strong></span></label>)}</div>
    <footer><button type="button" className="primary-button" onClick={onClose}>知道了</button></footer>
  </DialogShell>;
}

function DialogShell({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return <div className="modal-backdrop modal-backdrop--nested" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="agent-dialog agent-management-dialog"><header><div><h3>{title}</h3><p>{description}</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>{children}</div></div>;
}
