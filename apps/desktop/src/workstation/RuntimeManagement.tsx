import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Cpu, KeyRound, Link2, Plus, Search, Settings, Sparkles, Wrench, X, Cable, Gauge, ShieldCheck, Sun, UserCircle, Users } from 'lucide-react';
import { runtimeApi, type RuntimeAgent, type RuntimeDevice, type RuntimeSkill, type RuntimeTool } from '../api/runtime';
import { computeApi } from '../api/compute';
import { klaApi } from '../api/client';
import { Badge, IconButton } from './ui';
import type { ExecutionLocation } from '@kla-workstation/contracts';

type Props = { identityId: string; notify: (text: string) => void };

const marketAgents = [
  { name: '通用问答助手', category: '办公协作', description: '面向日常问答与信息整合，支持多轮追问、知识引用和来源追踪。', tags: ['通用', '知识检索', '多轮对话'], rating: '4.8', installs: '12.4k', tone: 'cyan' },
  { name: '长文档写作', category: '办公协作', description: '按模板产出报告、方案与白皮书，支持结构化生成与全文一致性检查。', tags: ['通用', '模板套用', '长文本'], rating: '4.7', installs: '9.8k', tone: 'purple' },
  { name: '代码审查', category: '研发工具', description: '对代码做静态检查、依赖风险与敏感信息扫描，给出行级修改建议。', tags: ['研发', '安全检查', '行级建议'], rating: '4.9', installs: '8.1k', tone: 'green' },
  { name: '数据分析', category: '数据与检索', description: '对表格数据做清洗、透视与建模，生成可解释图表与结论。', tags: ['数据', '透视', '图表'], rating: '4.6', installs: '7.6k', tone: 'orange' },
  { name: '网页检索', category: '数据与检索', description: '按关键词检索公开网页，返回带来源链接的摘要并支持交叉验证。', tags: ['检索', '来源链接', '交叉验证'], rating: '4.5', installs: '15.2k', tone: 'cyan' },
  { name: '多语言翻译', category: '办公协作', description: '面向商务与技术文档翻译，支持术语表锁定与全文一致性检查。', tags: ['语言', '术语表', '一致性'], rating: '4.8', installs: '11.3k', tone: 'purple' },
  { name: '演示文稿生成', category: '办公协作', description: '从大纲生成排版一致的演示文稿，输出可继续编辑的文件。', tags: ['办公', '版式', '可编辑'], rating: '4.4', installs: '6.9k', tone: 'green' },
  { name: '表格处理', category: '办公协作', description: '处理数据清洗、公式补全与批量改写，保留原始格式与公式。', tags: ['办公', '清洗', '公式'], rating: '4.5', installs: '5.4k', tone: 'orange' },
  { name: '合同审阅', category: '行业专业', description: '逐条比对合同条款与标准模板，标注偏离项与风险等级。', tags: ['法务', '条款比对', '风险标注'], rating: '4.7', installs: '3.2k', tone: 'cyan' },
  { name: '舆情监测', category: '行业专业', description: '跟踪品牌与竞品的公开声量与情绪趋势，异常波动时给出预警。', tags: ['市场', '声量', '预警'], rating: '4.3', installs: '4.1k', tone: 'purple' },
  { name: '图像理解', category: '数据与检索', description: '读取截图与图表中的数值和界面元素，输出结构化数据。', tags: ['多模态', '读数', '结构化'], rating: '4.6', installs: '7.0k', tone: 'green' },
  { name: '流程自动化', category: '研发工具', description: '把重复操作编排成可复用的步骤流，支持定时触发与失败重试。', tags: ['自动化', '定时', '可回看'], rating: '4.4', installs: '3.8k', tone: 'orange' },
];

function avatarTone(name: string): string {
  const tones = ['cyan', 'green', 'purple', 'orange'];
  return tones[Math.max(0, name.charCodeAt(0)) % tones.length];
}

export function RuntimeAgentManagement({ identityId, notify }: Props): React.JSX.Element {
  const [agents, setAgents] = useState<RuntimeAgent[]>([]);
  const [devices, setDevices] = useState<RuntimeDevice[]>([]);
  const [draft, setDraft] = useState<{ id: string | null; name: string; role: string; modelId: string | null; modelKeyId: string | null; executionLocation: ExecutionLocation; deviceId: string | null; enabled: boolean } | null>(null);
  const [capabilityAgent, setCapabilityAgent] = useState<RuntimeAgent | null>(null);
  const [keys, setKeys] = useState<Array<{id:string;name:string;keyPrefix:string;status:string}>>([]);
  const [keyModels, setKeyModels] = useState<Array<{id:string;name:string}>>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'builtin' | 'external' | 'custom'>('all');
  const [view, setView] = useState<'mine' | 'market'>('mine');
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const [a, d] = await Promise.all([runtimeApi.agents(), runtimeApi.devices()]);
    if (a.ok) setAgents(a.data); else notify(a.message);
    if (d.ok) setDevices(d.data);
  };
  useEffect(() => { let live = true; void load().catch(() => notify('智能体加载失败')); return () => { live = false; }; }, [identityId]);

  useEffect(() => {
    if (!draft) return;
    let live = true;
    void computeApi.keys().then(result => { if (live) { if (result.ok) setKeys(result.data.items.filter(key => key.status === 'active')); else setModelError(result.message); } });
    return () => { live = false; };
  }, [Boolean(draft), identityId]);
  useEffect(() => {
    if (!draft?.modelKeyId) { setKeyModels([]); setModelError(''); return; }
    let live = true;
    setModelLoading(true); setModelError(''); setKeyModels([]);
    void runtimeApi.keyModels(draft.modelKeyId).then(result => {
      if (!live) return;
      if (result.ok) setKeyModels(result.data);
      else setModelError(result.message);
    }).catch(() => { if (live) setModelError('获取模型失败'); }).finally(() => { if (live) setModelLoading(false); });
    return () => { live = false; };
  }, [draft?.modelKeyId, identityId]);

  const visibleAgents = useMemo(() => agents.filter((agent) => {
    const textMatch = `${agent.name} ${agent.role}`.toLowerCase().includes(query.toLowerCase());
    const kind = agent.type === 'external' || agent.type === 'external-cli' ? 'external' : agent.name === '统筹智能体' || agent.name === '本地执行智能体' ? 'builtin' : 'custom';
    return textMatch && (filter === 'all' || filter === kind);
  }), [agents, filter, query]);

  const save = async (): Promise<void> => {
    if (!draft) return;
    if (draft.modelKeyId && (!draft.modelId || !keyModels.some(model => model.id === draft.modelId))) { notify('请先选择该 Key 下可用的模型'); return; }
    setBusy(true);
    try {
      const result = await runtimeApi.saveAgent(draft.id, draft);
      if (!result.ok) { notify(result.message); return; }
      setDraft(null); await load(); notify('智能体定义已保存至服务端');
    } catch { notify('保存失败，请检查后端连接'); } finally { setBusy(false); }
  };

  return <div className="ws-agent-module">
    <div className="ws-agent-heading">
      <div><h1>智能体</h1><p>管理官方智能体、外接三方和自定义智能体；为每个角色配置模型与技能。</p></div>
      {view === 'mine' && <button className="ws-primary" onClick={() => setDraft({ id: null, name: '', role: '', modelId: null, modelKeyId: null, executionLocation: 'server', deviceId: null, enabled: true })}><Plus size={15} /> 新建智能体</button>}
    </div>
    <div className="ws-agent-tabs"><button className={view === 'mine' ? 'active' : ''} onClick={() => setView('mine')}>我的智能体 <small>· {agents.length}</small></button><button className={view === 'market' ? 'active' : ''} onClick={() => setView('market')}>智能体市场 <small>· {marketAgents.length}</small></button></div>
    {view === 'mine' ? <>
      <div className="ws-agent-toolbar"><label className="ws-agent-search"><Search size={15} /><input placeholder="搜索智能体..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="ws-agent-chips"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 {agents.length}</button><button className={filter === 'builtin' ? 'active' : ''} onClick={() => setFilter('builtin')}>官方内置 {agents.filter(a => a.name === '统筹智能体' || a.name === '本地执行智能体').length}</button><button className={filter === 'external' ? 'active' : ''} onClick={() => setFilter('external')}>外接三方 {agents.filter(a => a.type === 'external' || a.type === 'external-cli').length}</button><button className={filter === 'custom' ? 'active' : ''} onClick={() => setFilter('custom')}>自定义 {agents.filter(a => a.name !== '统筹智能体' && a.name !== '本地执行智能体' && a.type !== 'external' && a.type !== 'external-cli').length}</button></div></div>
      <div className="ws-agent-grid">{visibleAgents.map(agent => <article className="ws-agent-card" key={agent.id}>
        <div className="ws-agent-card-head"><span className={`ws-agent-avatar is-${avatarTone(agent.name)}`}>{agent.name.slice(0, 1)}</span><div><h3>{agent.name}</h3><small className="ws-agent-code">{agent.type === 'external' || agent.type === 'external-cli' ? 'external.agent' : `builtin.${agent.id.slice(0, 8)}`}</small></div><button className={`ws-agent-switch ${agent.enabled ? 'active' : ''}`} aria-label="切换启用状态" disabled={agent.name === '统筹智能体'} onClick={() => void runtimeApi.toggleAgent(agent.id, !agent.enabled).then(result => { if (result.ok) void load(); else notify(result.message); }).catch(() => notify('操作失败'))}><span /></button></div>
        <div className="ws-agent-tags"><Badge tone={agent.name === '统筹智能体' || agent.name === '本地执行智能体' || agent.type === 'external' || agent.type === 'external-cli' ? 'blue' : 'muted'}>{agent.name === '统筹智能体' || agent.name === '本地执行智能体' ? '官方内置' : agent.type === 'external' || agent.type === 'external-cli' ? '外接三方' : '自定义'}</Badge><Badge tone={agent.enabled ? 'green' : 'muted'}>{agent.enabled ? '已启用' : '已停用'}</Badge></div>
        <div className="ws-agent-fields"><span><b>运行方式</b>{agent.name === '统筹智能体' ? '服务端编排智能体' : (agent.executionLocation ?? agent.execution_location) === 'local' ? '本地执行智能体' : '服务端执行'}</span><span><b>挂载模型</b>{agent.modelId ?? agent.model_id ?? '使用默认槽位'}</span></div>
        <p className="ws-agent-description">{agent.role || '暂无角色说明'}</p>
        <footer><button onClick={() => setDraft({ id: agent.id, name: agent.name, role: agent.role, modelId: agent.modelId ?? agent.model_id ?? null, modelKeyId: agent.modelKeyId ?? agent.model_key_id ?? null, executionLocation: agent.executionLocation ?? agent.execution_location ?? 'server', deviceId: agent.deviceId ?? agent.device_id ?? null, enabled: agent.enabled })}><Cpu size={14} /> 挂载模型</button><button onClick={() => setCapabilityAgent(agent)}><Sparkles size={14} /> 技能管理</button><button onClick={() => notify(`权限管理：${agent.name}`)}><KeyRound size={14} /> 权限</button></footer>
      </article>)}</div>
    </> : <AgentMarket notify={notify} installedNames={agents.map(agent => agent.name)} onInstalled={load} />}
    {draft && <AgentEditor draft={draft} setDraft={setDraft} keys={keys} keyModels={keyModels} modelLoading={modelLoading} modelError={modelError} devices={devices} busy={busy} save={save} />}
    {capabilityAgent && <AgentCapabilityEditor agent={capabilityAgent} notify={notify} onClose={() => setCapabilityAgent(null)} />}
  </div>;
}

function AgentMarket({ notify, installedNames, onInstalled }: { notify: (text: string) => void; installedNames: string[]; onInstalled: () => Promise<void> }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部分类');
  const [installing, setInstalling] = useState<string | null>(null);
  const list = marketAgents.filter(agent => (!query || `${agent.name} ${agent.description} ${agent.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())) && (category === '全部分类' || agent.category === category));
  const install = async (agent: typeof marketAgents[number]): Promise<void> => {
    setInstalling(agent.name);
    try {
      const result = await runtimeApi.saveAgent(null, { name: agent.name, role: agent.description, modelId: null, modelKeyId: null, executionLocation: 'server', deviceId: null, enabled: true });
      if (!result.ok) { notify(result.message); return; }
      await onInstalled(); notify(`${agent.name}已安装到我的智能体`);
    } catch { notify('安装失败，请检查后端连接'); } finally { setInstalling(null); }
  };
  return <div className="ws-agent-market"><div className="ws-market-controls"><label className="ws-agent-search"><Search size={15} /><input placeholder="搜索市面上的通用智能体..." value={query} onChange={event => setQuery(event.target.value)} /></label><label className="ws-market-select"><select value={category} onChange={event => setCategory(event.target.value)}><option>全部分类</option><option>办公协作</option><option>研发工具</option><option>数据与检索</option><option>行业专业</option></select><ChevronDown size={14} /></label></div><div className="ws-agent-chips"><button className={category === '全部分类' ? 'active' : ''} onClick={() => setCategory('全部分类')}>全部 {marketAgents.length}</button><button className={category === '办公协作' ? 'active' : ''} onClick={() => setCategory('办公协作')}>办公协作</button><button className={category === '研发工具' ? 'active' : ''} onClick={() => setCategory('研发工具')}>研发工具</button><button className={category === '数据与检索' ? 'active' : ''} onClick={() => setCategory('数据与检索')}>数据与检索</button><button className={category === '行业专业' ? 'active' : ''} onClick={() => setCategory('行业专业')}>行业专业</button></div><div className="ws-market-grid">{list.map(agent => <article className="ws-market-card" key={agent.name}><div className="ws-agent-card-head"><span className={`ws-agent-avatar is-${agent.tone}`}>{agent.name.slice(0, 1)}</span><div><h3>{agent.name}</h3><small>{agent.category} · 通用能力</small></div></div><p>{agent.description}</p><div className="ws-agent-tags">{agent.tags.map(tag => <Badge key={tag}>{tag}</Badge>)}</div><footer><small>原型预设 · 评分 {agent.rating}</small><button className="ws-primary" disabled={installedNames.includes(agent.name) || installing === agent.name} onClick={() => void install(agent)}>{installedNames.includes(agent.name) ? '已安装' : installing === agent.name ? '安装中…' : <><Plus size={14} /> 安装</>}</button></footer></article>)}</div></div>;
}

type AgentDraft = { id: string | null; name: string; role: string; modelId: string | null; modelKeyId: string | null; executionLocation: ExecutionLocation; deviceId: string | null; enabled: boolean };
function AgentEditor({ draft, setDraft, keys, keyModels, modelLoading, modelError, devices, busy, save }: { draft: AgentDraft; setDraft: (value: AgentDraft | null) => void; keys: Array<{id:string;name:string;keyPrefix:string;status:string}>; keyModels: Array<{id:string;name:string}>; modelLoading:boolean; modelError:string; devices: RuntimeDevice[]; busy: boolean; save: () => Promise<void> }): React.JSX.Element {
  const coordinator = draft.name === '统筹智能体';
  const deviceOnline = devices.some(device => device.online && (!draft.deviceId || device.id === draft.deviceId));
  return <div className="ws-modal-backdrop"><div className="ws-modal ws-agent-editor"><header><h2>{draft.id ? '配置智能体 · ' + draft.name : '新建智能体'}</h2><IconButton title="关闭" onClick={() => setDraft(null)}><X size={18} /></IconButton></header>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {!draft.id && <><label>名称<input required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>身份与职责<textarea required value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value })} /></label></>}
      <label>执行位置<select value={coordinator ? 'server' : draft.executionLocation} disabled={coordinator} onChange={event => setDraft({ ...draft, executionLocation: event.target.value as ExecutionLocation, deviceId: null })}><option value="server">服务端执行</option><option value="local">本地设备执行</option></select></label>
      {!coordinator && draft.executionLocation === 'local' && <><label>执行设备<select value={draft.deviceId ?? ''} onChange={event => setDraft({ ...draft, deviceId: event.target.value || null })}><option value="">自动选择在线设备</option>{devices.map(device => <option key={device.id} value={device.id}>{device.name} · {device.online ? '在线' : '离线'}</option>)}</select></label>{!deviceOnline && <small className="ws-agent-model-note">当前身份没有在线桌面执行器。浏览器预览无法读取本地文件；请在桌面客户端登录同一账号和身份。</small>}</>}
      <p className="ws-agent-model-intro">每个智能体同一时间只能挂载一个模型，保存后按所选 Key 与模型路由。</p>
      <label>当前身份的 API Key<select value={draft.modelKeyId ?? ''} onChange={event => setDraft({ ...draft, modelKeyId: event.target.value || null, modelId: null })}><option value="">选择 API Key</option>{keys.map(key => <option key={key.id} value={key.id}>{key.name} · {key.keyPrefix}</option>)}</select></label>
      {!keys.length && <small className="ws-agent-model-note">当前身份没有可用 Key，可前往「算力 / API 密钥」创建。</small>}
      <label>该 Key 下可用模型<select value={draft.modelId ?? ''} disabled={!draft.modelKeyId || modelLoading || Boolean(modelError)} onChange={event => setDraft({ ...draft, modelId: event.target.value || null })}><option value="">{modelLoading ? '正在读取模型…' : '选择模型'}</option>{keyModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      {modelError && <small role="alert" className="ws-agent-model-error">{modelError}</small>}
      {draft.modelKeyId && !modelLoading && !modelError && !keyModels.length && <small className="ws-agent-model-note">此 Key 下没有平台已启用的可用模型。</small>}
      <footer><button type="button" onClick={() => setDraft({ ...draft, modelKeyId: null, modelId: null })}>取消挂载</button><button type="button" onClick={() => setDraft(null)}>取消</button><button className="ws-primary" disabled={busy || modelLoading || Boolean(draft.modelKeyId && !draft.modelId)}>{busy ? '保存中…' : '保存挂载'}</button></footer>
    </form></div></div>;
}

function AgentCapabilityEditor({ agent, notify, onClose }: { agent: RuntimeAgent; notify: (text: string) => void; onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<typeof runtimeApi.agentCapabilities>> | null>(null);
  const [skillCodes, setSkillCodes] = useState<string[]>([]);
  const [toolCodes, setToolCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void runtimeApi.agentCapabilities(agent.id).then(result => {
      if (!live) return;
      setData(result);
      if (result.ok) {
        setSkillCodes(result.data.skills.filter(skill => skill.mounted).map(skill => skill.code));
        setToolCodes(result.data.tools.filter(tool => tool.mounted).map(tool => tool.code));
      }
    }).catch(() => { if (live) notify('能力目录加载失败'); });
    return () => { live = false; };
  }, [agent.id]);
  const toggle = (items: string[], code: string, checked: boolean): string[] => checked ? [...items, code] : items.filter(item => item !== code);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await runtimeApi.saveAgentCapabilities(agent.id, skillCodes, toolCodes);
      if (!result.ok) { notify(result.message); return; }
      notify('智能体能力挂载已保存'); onClose();
    } catch (error) { notify(error instanceof Error ? error.message : '挂载保存失败'); }
    finally { setBusy(false); }
  };
  return <div className="ws-modal-backdrop"><div className="ws-modal ws-capability-editor"><header><h2>{agent.name} · 技能管理</h2><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>
    {!data ? <p>正在加载能力目录…</p> : !data.ok ? <p role="alert">{data.message}</p> : <>
      <section><h3>挂载技能</h3><div className="ws-capability-list">{data.data.skills.map(skill => <label key={skill.code}><input type="checkbox" checked={skillCodes.includes(skill.code)} onChange={event => setSkillCodes(items => toggle(items, skill.code, event.target.checked))} /><span><b>{skill.name}</b><small>{skill.description}</small><small>调用工具：{skill.tool_codes.join('、')}</small>{skill.tool_codes.some(code => code.startsWith('local_')) && (agent.executionLocation ?? agent.execution_location) !== 'local' && <small>当前为服务端执行；本地工具不会提供给此智能体</small>}</span></label>)}</div></section>
      <section><h3>直接挂载工具</h3><div className="ws-capability-list">{data.data.tools.filter(tool => tool.location === 'server' || (agent.executionLocation ?? agent.execution_location) === 'local').map(tool => <label key={tool.code}><input type="checkbox" checked={toolCodes.includes(tool.code)} onChange={event => setToolCodes(items => toggle(items, tool.code, event.target.checked))} /><span><b>{tool.name}</b><small>{tool.description}</small></span></label>)}</div></section>
      <footer><button onClick={onClose}>取消</button><button className="ws-primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存挂载'}</button></footer>
    </>}</div></div>;
}

export function RuntimeSkillManagement({ identityId, notify }: Props): React.JSX.Element {
  const [skills, setSkills] = useState<RuntimeSkill[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { let live = true; setLoading(true); void runtimeApi.skills().then(result => { if (!live) return; if (result.ok) setSkills(result.data); else notify(result.message); }).catch(() => notify('技能加载失败')).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [identityId]);
  const visible = skills.filter(skill => !query || `${skill.name} ${skill.description} ${skill.tool_codes.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="ws-agent-module"><div className="ws-agent-heading"><div><h1>技能</h1><p>技能包定义及其调用工具。</p></div></div><div className="ws-skill-toolbar"><label className="ws-agent-search"><Search size={15} /><input placeholder="搜索技能名称…" value={query} onChange={event => setQuery(event.target.value)} /></label><Badge tone="blue">技能目录 {skills.length}</Badge></div>{loading ? <p className="ws-empty-line">正在加载技能…</p> : <div className="ws-skill-table"><div className="ws-skill-row ws-skill-header"><span>技能</span><span>编号</span><span>所需工具</span><span>状态</span></div>{visible.map(skill => <div className="ws-skill-row" key={skill.code}><span><b>{skill.name}</b><small>{skill.description}</small></span><span>{skill.code}</span><span className="ws-skill-tools">{skill.tool_codes.join('、')}</span><Badge tone={skill.enabled ? 'green' : 'muted'}>{skill.enabled ? '可用' : '停用'}</Badge></div>)}</div>}</div>;
}

export function RuntimeToolManagement({ identityId, notify }: Props): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [tools, setTools] = useState<RuntimeTool[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void runtimeApi.tools().then(result => {
      if (!live) return;
      if (result.ok) setTools(result.data);
      else notify(result.message);
    }).catch(() => { if (live) notify('工具目录加载失败'); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [identityId]);
  const list = tools.filter(tool => !query || `${tool.name} ${tool.code} ${tool.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="ws-agent-module">
    <div className="ws-agent-heading"><div><h1>工具</h1><p>服务端与本地执行器的底层工具目录。</p></div></div>
    <div className="ws-tool-stats"><article><strong>{tools.length}</strong><span>工具目录</span><small>服务端实际注册</small></article><article><strong>待接入</strong><span>MCP Server</span><small>尚无外部服务注册接口</small></article></div>
    <section className="ws-mcp-card"><div><span className="ws-agent-avatar is-purple"><Link2 size={17} /></span><div><h3>MCP Server</h3><p>外部 MCP 工具尚未注册，不会加入智能体可调用目录。</p></div></div><Badge tone="muted">未接入</Badge></section>
    <div className="ws-tool-controls"><label className="ws-agent-search"><Search size={15} /><input placeholder="搜索工具名称…" value={query} onChange={event => setQuery(event.target.value)} /></label><Badge tone="blue">工具目录 {list.length}</Badge></div>
    {loading ? <p className="ws-empty-line">正在加载工具目录…</p> : <div className="ws-tool-grid">{list.map(tool => {
      return <article key={tool.code}><div className="ws-tool-icon"><Wrench size={17} /></div><div><h3>{tool.name}</h3><small>{tool.code} · {tool.location === 'local' ? '本地设备' : '服务端'}</small></div><Badge tone={tool.location === 'server' || tool.deviceOnline ? 'green' : 'muted'}>{tool.location === 'server' ? '服务端可用' : tool.deviceOnline ? '设备在线' : '设备离线'}</Badge><p>{tool.description}</p></article>;
    })}</div>}
  </div>;
}

export function RuntimeRoomMembers({ room, identityId, notify, onClose }: Props & { room: string; onClose: () => void }): React.JSX.Element {
  const [agents, setAgents] = useState<RuntimeAgent[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  useEffect(() => { let live = true; void Promise.all([runtimeApi.agents(), runtimeApi.members(room)]).then(([a, m]) => { if (!live) return; if (a.ok) setAgents(a.data); if (m.ok) setMembers(m.data.map(item => item.id)); }); return () => { live = false; }; }, [room, identityId]);
  return <div className="ws-modal-backdrop"><div className="ws-modal"><header><h2>群聊智能体角色池</h2><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>{agents.map(agent => <label key={agent.id} className="ws-member-option"><input type="checkbox" checked={members.includes(agent.id)} disabled={agent.name === '统筹智能体' || !agent.enabled} onChange={event => { const add = event.target.checked; void (add ? runtimeApi.addMember(room, agent.id) : runtimeApi.removeMember(room, agent.id)).then(result => { if (result.ok) setMembers(items => add ? [...items, agent.id] : items.filter(item => item !== agent.id)); else notify(result.message); }).catch(() => notify('更新成员失败')); }} /><span><b>{agent.name}</b><small>{agent.role}</small></span></label>)}</div></div>;
}

type SettingsView = 'channels' | 'members' | 'profile' | 'appearance' | 'ops';

/** 原型中的平台设置页面，保留现有服务端和桌面桥接能力边界。 */
export function RuntimeSettingsView({ view, identityId, notify }: Props & { view: SettingsView }): React.JSX.Element {
  if (view === 'channels') return <ChannelSettings notify={notify} />;
  if (view === 'members') return <MemberSettings identityId={identityId} notify={notify} />;
  if (view === 'profile') return <ProfileSettings notify={notify} />;
  if (view === 'appearance') return <AppearanceSettings notify={notify} />;
  return <OperationsSettings notify={notify} />;
}

function ChannelSettings({ notify }: { notify: (text: string) => void }): React.JSX.Element {
  const [channels, setChannels] = useState<Array<{ id: string; name: string; type: string; enabled: boolean; status: string }>>([]);
  useEffect(() => { void (async () => { try { const result = await window.kunqing?.channels.list() as { ok: boolean; data?: typeof channels } | undefined; if (result?.ok && result.data) setChannels(result.data); } catch { notify('渠道列表加载失败'); } })(); }, []);
  const labels: Record<string, string> = { telegram: 'Telegram', lark: '飞书 / Lark', dingtalk: '钉钉', 'wecom-webhook': '企业微信群机器人' };
  return <div className="ws-settings-page"><div className="ws-agent-heading"><div><h1>渠道配置</h1><p>连接 Telegram、飞书、钉钉和企业微信群机器人，让群聊可从本地工作站收发消息。</p></div><button className="ws-primary" disabled={!window.kunqing?.channels} title={!window.kunqing?.channels ? '新版 REST 渠道配置接口尚未接入' : '渠道配置'} onClick={() => notify('渠道配置请在桌面版操作')}><Plus size={15} /> 添加渠道</button></div><div className="ws-channel-stats"><article><strong>{channels.filter(channel => channel.enabled && channel.status === 'connected').length}</strong><span>已连接渠道</span><small>实时连接状态</small></article><article><strong>{channels.length}</strong><span>已配置渠道</span><small>当前设备读取</small></article><article><strong>{channels.filter(channel => channel.enabled && channel.status !== 'connected').length}</strong><span>待连接渠道</span><small>需检查凭据或连接状态</small></article><article><strong>{window.kunqing?.channels ? '可用' : '待接入'}</strong><span>渠道管理服务</span><small>{window.kunqing?.channels ? '桌面桥接' : '新版 REST 接口未开放'}</small></article></div><section className="ws-settings-card"><header><div><h3>已配置渠道</h3><p>启用后渠道在本地常驻监听，消息统一交给群聊 Leader 处理。</p></div><Cable size={18} /></header>{channels.length ? channels.map(channel => <div className="ws-channel-row" key={channel.id}><span className="ws-tool-icon"><Cable size={16} /></span><div><b>{labels[channel.type] ?? channel.name}</b><small>{channel.type} · {channel.status}</small></div><Badge tone={channel.enabled && channel.status === 'connected' ? 'green' : 'muted'}>{channel.enabled && channel.status === 'connected' ? '已连接' : '未连接'}</Badge><button disabled={!window.kunqing?.channels} onClick={() => notify(`渠道配置：${channel.name}`)}><Settings size={14} /> 配置</button></div>) : <div className="ws-empty-line">尚未配置渠道；新版 REST 渠道接口接入后可在此配置。</div>}</section><section className="ws-settings-card"><header><div><h3>最近活动</h3><p>最近 24 小时的渠道收发记录</p></div></header><div className="ws-activity-line"><Check size={15} /> 暂无可用的渠道活动记录</div></section></div>;
}

type OrganizationMember = { identityId: string; displayName: string; nickname: string; email?: string | null; status: string; roles: Array<{ id: string; name: string; isSystem?: boolean }> };
type OrganizationRole = { id: string; name: string; is_system: boolean };

function MemberSettings({ identityId, notify }: Props): React.JSX.Element {
  const [organizationId, setOrganizationId] = useState('');
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [roles, setRoles] = useState<OrganizationRole[]>([]);
  const [inviteCode, setInviteCode] = useState('');
  const [editing, setEditing] = useState<OrganizationMember | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async (): Promise<void> => {
    const identities = await klaApi.request<Array<{ id: string; organizationId?: string | null }>>('/v1/me/identities');
    if (!identities.ok) { notify(identities.message); setLoading(false); return; }
    const orgId = identities.data.find(identity => identity.id === identityId)?.organizationId;
    if (!orgId) { setLoading(false); return; }
    setOrganizationId(orgId);
    const [membersResult, rolesResult, orgResult] = await Promise.all([
      klaApi.request<OrganizationMember[]>(`/v1/organizations/${orgId}/members`),
      klaApi.request<OrganizationRole[]>(`/v1/organizations/${orgId}/roles`),
      klaApi.request<{ inviteCode?: string }>(`/v1/organizations/${orgId}`),
    ]);
    if (membersResult.ok) setMembers(membersResult.data); else notify(membersResult.message);
    if (rolesResult.ok) setRoles(rolesResult.data);
    if (orgResult.ok) setInviteCode(orgResult.data.inviteCode ?? '');
    setLoading(false);
  };
  useEffect(() => { void load().catch(() => { setLoading(false); notify('成员列表加载失败'); }); }, [identityId]);
  const saveRoles = async (): Promise<void> => {
    if (!editing || !organizationId) return;
    const result = await klaApi.request(`/v1/organizations/${organizationId}/members/${editing.identityId}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds: selectedRoles }) });
    if (!result.ok) { notify(result.message); return; }
    setEditing(null); await load(); notify('成员角色已更新');
  };
  return <div className="ws-settings-page"><div className="ws-agent-heading"><div><h1>成员管理</h1><p>管理当前企业身份下的成员、角色与访问权限。</p></div>{inviteCode && <button className="ws-primary" onClick={() => void navigator.clipboard.writeText(inviteCode).then(() => notify('企业邀请码已复制')).catch(() => notify(`邀请码：${inviteCode}`))}><Plus size={15} /> 复制邀请码</button>}</div><section className="ws-settings-card"><header><div><h3>企业成员</h3><p>管理员可为成员设置新的业务角色；系统管理员与成员身份不可修改。</p></div><Users size={18} /></header>{loading ? <div className="ws-empty-line">正在加载成员…</div> : !organizationId ? <div className="ws-empty-line">当前不是企业身份</div> : <div className="ws-member-table"><div className="ws-member-table-head"><span>成员</span><span>角色</span><span>状态</span><span>操作</span></div>{members.map(member => <div className="ws-member-table-row" key={member.identityId}><span><b>{member.nickname || member.displayName}</b><small>{member.email ?? member.displayName}</small></span><span>{member.roles.map(role => role.name).join('、') || '成员'}</span><Badge tone={member.status === 'active' ? 'green' : 'muted'}>{member.status === 'active' ? '正常' : '停用'}</Badge><button onClick={() => { setEditing(member); setSelectedRoles(member.roles.map(role => role.id)); }}>设置角色</button></div>)}</div>}</section>{editing && <div className="ws-modal-backdrop"><div className="ws-modal"><header><h2>设置成员角色</h2><IconButton title="关闭" onClick={() => setEditing(null)}><X size={18} /></IconButton></header><div className="ws-settings-role-options">{roles.map(role => <label key={role.id}><input type="checkbox" checked={selectedRoles.includes(role.id)} disabled={role.is_system} onChange={event => setSelectedRoles(current => event.target.checked ? [...current, role.id] : current.filter(id => id !== role.id))} />{role.name}{role.is_system && <small>系统角色不可修改</small>}</label>)}</div><footer><button onClick={() => setEditing(null)}>取消</button><button className="ws-primary" onClick={() => void saveRoles()}>保存</button></footer></div></div>}</div>;
}

function ProfileSettings({ notify }: { notify: (text: string) => void }): React.JSX.Element {
  const [nickname, setNickname] = useState(() => localStorage.getItem('kla.profile.nickname') ?? '老K');
  const [avatar, setAvatar] = useState(() => localStorage.getItem('kla.profile.avatar') ?? '');
  const chooseAvatar = (file?: File): void => {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2 * 1024 * 1024) { notify('请选择不超过 2MB 的 PNG 或 JPG 图片'); return; }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') setAvatar(reader.result); };
    reader.readAsDataURL(file);
  };
  const save = (): void => {
    if (!nickname.trim()) { notify('昵称不能为空'); return; }
    localStorage.setItem('kla.profile.nickname', nickname.trim());
    if (avatar) localStorage.setItem('kla.profile.avatar', avatar); else localStorage.removeItem('kla.profile.avatar');
    window.dispatchEvent(new Event('kla:profile-changed'));
    notify('本机个人信息已保存');
  };
  return <div className="ws-settings-page ws-settings-narrow"><div className="ws-agent-heading"><div><h1>个人</h1><p>设置你在本机群聊中的昵称与头像，并查看当前账号绑定的身份。</p></div></div><div className="ws-profile-layout"><section className="ws-settings-card ws-profile-avatar"><h3>头像</h3><span className="ws-user-avatar large">{avatar ? <img src={avatar} alt="当前头像" /> : nickname.slice(0, 1)}</span><label className="ws-avatar-upload"><UserCircle size={14} /> 更换头像<input type="file" accept="image/png,image/jpeg" onChange={event => chooseAvatar(event.target.files?.[0])} /></label><button onClick={() => setAvatar('')}>恢复默认</button><small>支持 PNG 与 JPG，建议 512 × 512，单个文件不超过 2MB。</small></section><section className="ws-settings-card"><header><div><h3>昵称</h3><p>昵称与头像保存在本机，只影响本设备上看到的名字。</p></div><Badge tone="blue">本机生效</Badge></header><label className="ws-settings-field">昵称<input value={nickname} maxLength={16} onChange={event => setNickname(event.target.value)} /></label><footer><button className="ws-primary" onClick={save}>保存个人信息</button></footer></section></div></div>;
}

function AppearanceSettings({ notify }: { notify: (text: string) => void }): React.JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => (localStorage.getItem('kla.appearance.theme') as 'light' | 'dark' | 'system') || 'light');
  const [preferences, setPreferences] = useState(() => ({ compact: localStorage.getItem('kla.appearance.compact') === 'true', persistentNav: localStorage.getItem('kla.appearance.persistentNav') !== 'false', reducedMotion: localStorage.getItem('kla.appearance.reducedMotion') === 'true' }));
  const selectTheme = (value: 'light' | 'dark' | 'system'): void => { setTheme(value); document.documentElement.dataset.klaTheme = value; };
  const save = (): void => {
    localStorage.setItem('kla.appearance.theme', theme);
    Object.entries(preferences).forEach(([key, value]) => localStorage.setItem(`kla.appearance.${key}`, String(value)));
    document.documentElement.dataset.klaCompact = preferences.compact ? 'true' : 'false';
    document.documentElement.dataset.klaReducedMotion = preferences.reducedMotion ? 'true' : 'false';
    notify('本机外观设置已保存');
  };
  const rows = [
    { key: 'compact' as const, name: '紧凑密度', detail: '列表与表格行高收窄，一屏可容纳更多条目' },
    { key: 'persistentNav' as const, name: '左侧导航常驻', detail: '窗口变窄时保持导航文字可见' },
    { key: 'reducedMotion' as const, name: '减少动效', detail: '关闭卡片入场与悬浮窗过渡动画' },
  ];
  return <div className="ws-settings-page ws-settings-narrow"><div className="ws-agent-heading"><div><h1>外观</h1><p>选择界面主题与信息密度，设置只作用于当前工作站。</p></div></div><div className="ws-profile-layout"><section className="ws-settings-card"><header><div><h3>主题</h3><p>深色可降低夜间长时间使用的视觉疲劳</p></div><Badge tone="blue">{theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}</Badge></header><div className="ws-segmented">{(['light', 'dark', 'system'] as const).map(value => <button key={value} className={theme === value ? 'active' : ''} onClick={() => selectTheme(value)}>{value === 'light' ? '浅色' : value === 'dark' ? '深色' : '跟随系统'}</button>)}</div><p className="ws-settings-note">切换主题立即预览，保存后本机下次启动继续使用。</p></section><section className="ws-settings-card"><header><div><h3>界面密度</h3><p>列表与表格的行高、留白与导航常驻策略</p></div><Sun size={18} /></header>{rows.map(row => <div className="ws-preference-row" key={row.key}><span><b>{row.name}</b><small>{row.detail}</small></span><button role="switch" aria-label={row.name} aria-checked={preferences[row.key]} className={`ws-agent-switch ${preferences[row.key] ? 'active' : ''}`} onClick={() => setPreferences(current => ({ ...current, [row.key]: !current[row.key] }))}><span /></button></div>)}<button className="ws-primary" onClick={save}>保存外观设置</button></section></div></div>;
}

function OperationsSettings({ notify }: { notify: (text: string) => void }): React.JSX.Element {
  const [mode, setMode] = useState<'saas' | 'private'>('saas');
  const [verified, setVerified] = useState(false);
  const [password, setPassword] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [tokenAmount, setTokenAmount] = useState('1000000');
  const [expiresAt, setExpiresAt] = useState('');
  const verify = (): void => {
    if (Date.now() < lockedUntil) return;
    if (password === '123456') { setVerified(true); setAttempts(0); setPassword(''); return; }
    setPassword('');
    const next = attempts + 1;
    setAttempts(next);
    if (next % 3 === 0) setLockedUntil(Date.now() + 3 * 60_000);
    notify('运维密码不正确');
  };
  if (!verified) return <div className="ws-settings-page ws-settings-narrow ws-ops-gate"><ShieldCheck size={29} /><h1>运维管理</h1><p>该模块涉及产品交付方式与本地授权参数，需先通过运维密码验证。</p><section className="ws-settings-card"><header><div><h3>运维密码验证</h3><p>仅运维人员可用，请勿将密码告知他人</p></div><Badge tone={Date.now() < lockedUntil ? 'orange' : 'muted'}>{Date.now() < lockedUntil ? '已锁定' : '待验证'}</Badge></header><label className="ws-settings-field">运维密码<input type="password" value={password} disabled={Date.now() < lockedUntil} onChange={event => setPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') verify(); }} placeholder="请输入运维密码" /></label>{attempts > 0 && <p>已失败 {attempts} 次；连续失败 3 次将暂时锁定输入。</p>}<button className="ws-primary" disabled={Date.now() < lockedUntil} onClick={verify}>验证并进入</button></section></div>;
  return <div className="ws-settings-page ws-settings-narrow"><div className="ws-agent-heading"><div><h1>运维管理</h1><p>选择产品交付方式并维护本地授权参数。</p></div><button onClick={() => setVerified(false)}><KeyRound size={15} /> 锁定并退出</button></div><div className="ws-profile-layout"><button className={`ws-deploy-card ${mode === 'saas' ? 'active' : ''}`} onClick={() => setMode('saas')}><Gauge size={22} /><b>SaaS 版本</b><span>由平台提供模型额度，按配额统一结算。</span></button><button className={`ws-deploy-card ${mode === 'private' ? 'active' : ''}`} onClick={() => setMode('private')}><ShieldCheck size={22} /><b>私有化部署版本</b><span>模型和数据均在私有环境运行。</span></button></div><section className="ws-settings-card"><header><div><h3>{mode === 'saas' ? 'SaaS 额度配置' : '私有化授权配置'}</h3><p>新版服务端运维配置接口尚未接入；以下参数仅用于查看交互，无法应用。</p></div></header><label className="ws-settings-field">{mode === 'saas' ? 'Token 总量' : '产品激活有效期'}<input type={mode === 'saas' ? 'number' : 'date'} value={mode === 'saas' ? tokenAmount : expiresAt} onChange={event => mode === 'saas' ? setTokenAmount(event.target.value) : setExpiresAt(event.target.value)} /></label><footer><button className="ws-primary" disabled title="服务端运维配置接口尚未接入">确认并应用配置</button></footer></section></div>;
}
