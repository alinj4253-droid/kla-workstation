import { Activity, Bot, CheckCircle2, Cpu, Loader2, Pencil, Plus, TestTube2, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type UnifiedModel = {
  id: string;
  name: string;
  modelId: string;
  type: string;
  baseUrl: string | null;
  status: string;
  hasApiKey: number | boolean;
  isOfficial?: number | boolean;
  verifiedCapabilitiesJson?: string | null;
};

const MODEL_TYPES = [
  ['deepseek', 'DeepSeek'], ['glm', 'GLM'], ['kimi', 'Kimi'], ['qwen', 'Qwen'],
  ['openai', 'GPT / OpenAI'], ['anthropic', 'Claude / Anthropic'], ['openai-compatible', 'OpenAI 兼容'],
] as const;

const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: 'https://zhenze-huhehaote.cmecloud.cn/v1',
  glm: 'https://moma.cmecloud.cn/v1',
  kimi: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

const AGENT_REQUIREMENTS = [
  ['统筹管理智能体', '流式输出、工具调用、结构化输出'],
  ['知识管理智能体', '流式输出、长上下文、结构化输出、向量能力'],
  ['资料调研智能体', '流式输出、网页工具调用、结构化输出'],
  ['材料编写智能体', '流式输出、长文本生成、工具调用'],
  ['验收智能体', '流式输出、长上下文、工具调用、结构化输出'],
];

export function ModelManagementSettings(): React.JSX.Element {
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<UnifiedModel | null | 'new'>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await window.kunqing?.models.listUnified() as { ok?: boolean; data?: UnifiedModel[] } | undefined;
    setModels(result?.ok ? result.data ?? [] : []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const test = async (model: UnifiedModel): Promise<void> => {
    setTesting(model.id);
    const result = await window.kunqing?.models.testUnified({ id: model.id }) as { ok?: boolean; data?: { success?: boolean; latencyMs?: number; error?: string } } | undefined;
    setTestResults((current) => ({
      ...current,
      [model.id]: result?.data?.success ? `连接成功 · ${result.data.latencyMs ?? 0} ms` : result?.data?.error || '连接失败',
    }));
    setTesting(null);
    await load();
  };

  const remove = async (model: UnifiedModel): Promise<void> => {
    if (!window.confirm(`确认删除模型“${model.name}”？已挂载该模型的智能体将恢复为默认槽位。`)) return;
    await window.kunqing?.models.deleteUnified({ id: model.id });
    await load();
  };

  return (
    <div className="settings-page settings-page--unified-models">
      <header className="settings-heading">
        <div><h2>模型管理</h2><p>在一个配置项中维护模型名称、标识、接口地址和密钥。</p></div>
        <button type="button" className="primary-button" onClick={() => setEditing('new')}><Plus size={15} /> 添加模型</button>
      </header>

      {loading ? <div className="settings-loading"><Loader2 size={18} className="spin" /> 加载模型...</div> : (
        <div className="unified-model-grid">
          {models.length === 0 && <div className="settings-empty-state"><Cpu size={32} /><strong>还没有模型</strong><span>添加后即可在智能体管理中挂载。</span></div>}
          {models.map((model) => (
            <article className="unified-model-card" key={model.id}>
              <header><span><Cpu size={19} /></span><div><strong>{model.name}</strong><code>{model.modelId}</code></div>{model.isOfficial ? <em className="model-official-badge">官方渠道</em> : null}<em className={`model-status model-status--${model.status}`}>{model.status === 'available' ? '可用' : model.status === 'error' ? '异常' : '未测试'}</em></header>
              <dl><dt>类型</dt><dd>{MODEL_TYPES.find(([id]) => id === model.type)?.[1] ?? model.type}</dd><dt>Base URL</dt><dd title={model.baseUrl ?? ''}>{model.baseUrl || '默认地址'}</dd><dt>API Key</dt><dd>{model.hasApiKey ? '已安全保存' : '未配置'}</dd></dl>
              {testResults[model.id] && <p className="model-test-result"><Activity size={13} />{testResults[model.id]}</p>}
              <footer>
                <button type="button" className="secondary-button secondary-button--small" disabled={testing === model.id} onClick={() => void test(model)}>{testing === model.id ? <Loader2 size={13} className="spin" /> : <TestTube2 size={13} />}测试连接</button>
                <button type="button" className="secondary-button secondary-button--small" onClick={() => setEditing(model)}><Pencil size={13} />编辑</button>
                <button type="button" className="secondary-button secondary-button--small danger-text" disabled={Boolean(model.isOfficial)} title={model.isOfficial ? '官方内置模型不可删除' : undefined} onClick={() => void remove(model)}><Trash2 size={13} />删除</button>
              </footer>
            </article>
          ))}
        </div>
      )}

      <section className="model-agent-requirements">
        <header><Bot size={17} /><div><strong>智能体模型能力要求</strong><span>挂载模型时请确保能力覆盖对应智能体的工作方式。</span></div></header>
        <div>{AGENT_REQUIREMENTS.map(([name, requirement]) => <p key={name}><CheckCircle2 size={14} /><strong>{name}</strong><span>{requirement}</span></p>)}</div>
      </section>

      {editing && <ModelEditor model={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function ModelEditor({ model, onClose, onSaved }: { model: UnifiedModel | null; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [name, setName] = useState(model?.name ?? '');
  const [modelId, setModelId] = useState(model?.modelId ?? '');
  const [type, setType] = useState(model?.type ?? 'deepseek');
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? DEFAULT_BASE_URLS.deepseek!);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || !modelId.trim() || !type) { setError('请完整填写模型名称、模型 ID 和类型'); return; }
    setSaving(true);
    const result = await window.kunqing?.models.saveUnified({
      ...(model ? { id: model.id } : {}), name: name.trim(), modelId: modelId.trim(), type, baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }) as { ok?: boolean; error?: { message?: string } } | undefined;
    setSaving(false);
    if (result?.ok) onSaved(); else setError(result?.error?.message || '保存失败');
  };

  return <div className="modal-backdrop modal-backdrop--nested" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="agent-dialog unified-model-dialog" onSubmit={(event) => void save(event)}>
      <header><div><h3>{model ? '编辑模型' : '添加模型'}</h3><p>密钥只会加密保存在当前 K_Studio。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
      <div className="unified-form-grid">
        <label><span>模型名称 *</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 DeepSeek V4 Flash" /></label>
        <label><span>模型 ID *</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="例如 deepseek-v4-flash" /></label>
        <label><span>类型 *</span><select value={type} onChange={(event) => { const next = event.target.value; setType(next); if (!model) setBaseUrl(DEFAULT_BASE_URLS[next] ?? ''); }}>{MODEL_TYPES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label><span>Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://.../v1" /></label>
        <label className="unified-form-grid__wide"><span>API Key {model?.hasApiKey ? '（留空则保留原密钥）' : ''}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={model?.hasApiKey ? '已配置' : '请输入 API Key'} /></label>
      </div>
      {error && <p className="dialog-error">{error}</p>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? '保存中...' : '保存模型'}</button></footer>
    </form>
  </div>;
}
