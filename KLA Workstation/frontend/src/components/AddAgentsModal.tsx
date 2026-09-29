import { Bot, Check, Search, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type AgentProfile = {
  id: string;
  name: string;
  definitionId: string;
  runtimeMode: 'native-model' | 'external-cli';
  enabled: boolean;
  cliConnectionName?: string | null;
  operationPlatformId?: string;
  description?: string;
};

type ExistingAgent = { id: string; agentName: string };

const DESCRIPTIONS: Record<string, string> = {
  'builtin.orchestrator': '理解目标、拆解任务并协调团队。',
  'builtin.local-executor': '闭环完成知识化、调研、材料编写、验收和成果交付。',
  'builtin.knowledge-manager': '处理文档、知识图谱和 Wiki。',
  'builtin.researcher': '检索资料、分析信息并核查事实。',
  'custom.workbuddy': '通过 MCP 调用 WorkBuddy 的外部智能体能力。',
  'custom.kimi': 'Kimi Code 代码编写智能体：分析需求、修改代码并验证结果。',
  'custom.kimi-code': 'Kimi Code 代码编写智能体：分析需求、修改代码并验证结果。',
  'custom.codebuddy': 'CodeBuddy 验收智能体：读取真实成果并核对质量、事实与完整性。',
};

export function AddAgentsModal({
  projectId,
  existingAgents,
  onClose,
  onAdded,
}: {
  projectId: string;
  existingAgents: ExistingAgent[];
  onClose: () => void;
  onAdded: (agents: Array<{ id: string; projectId: string; agentName: string; role: string; runtimeMode: string }>) => void;
}): React.JSX.Element {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const remaining = Math.max(0, 9 - existingAgents.length);

  useEffect(() => {
    void window.kunqing?.agents.listProfiles().then((result) => {
      const response = result as { ok: boolean; data?: AgentProfile[] } | undefined;
      if (response?.ok && response.data) {
        const existingNames = new Set(existingAgents.map((agent) => agent.agentName));
        // WorkBuddy MCP remains stored for compatibility, but is not selectable
        // while its external task-consumer lifecycle is paused.
        setProfiles(response.data.filter((profile) => profile.enabled && profile.definitionId !== 'builtin.gm' && profile.definitionId !== 'custom.workbuddy' && !existingNames.has(profile.name)));
      }
      setLoading(false);
    }).catch(() => {
      setError('无法读取智能体列表');
      setLoading(false);
    });
  }, [existingAgents]);

  const filtered = useMemo(() => profiles.filter((profile) => (
    `${profile.name}${DESCRIPTIONS[profile.definitionId] ?? ''}`.toLocaleLowerCase('zh-CN')
      .includes(query.trim().toLocaleLowerCase('zh-CN'))
  )), [profiles, query]);

  const toggle = (profileId: string): void => {
    setError('');
    setSelected((current) => current.includes(profileId)
      ? current.filter((id) => id !== profileId)
      : current.length < remaining ? [...current, profileId] : current);
  };

  const submit = async (): Promise<void> => {
    if (selected.length === 0) {
      setError('请至少选择一个智能体');
      return;
    }
    setSubmitting(true);
    const result = await window.kunqing?.agents.addProjectInstances({ projectId, profileIds: selected }) as {
      ok: boolean;
      data?: Array<{ id: string; projectId: string; agentName: string; role: string; runtimeMode: string }>;
      error?: { message?: string };
    } | undefined;
    setSubmitting(false);
    if (!result?.ok || !result.data) {
      setError(result?.error?.message ?? '添加智能体失败');
      return;
    }
    onAdded(result.data);
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="add-agents-dialog" role="dialog" aria-modal="true" aria-labelledby="add-agents-title">
        <header>
          <div><h2 id="add-agents-title">添加智能体</h2><p>新成员会在本群聊中初始化独立角色卡和私有记忆区。</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <label className="agent-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索可用智能体" /><kbd>{selected.length}/{remaining}</kbd></label>
        <div className="add-agents-list">
          {loading && <div className="loading-hint">正在读取智能体列表…</div>}
          {!loading && filtered.map((profile) => {
            const checked = selected.includes(profile.id);
            return (
              <button type="button" key={profile.id} className={`add-agent-row${checked ? ' add-agent-row--selected' : ''}`} onClick={() => toggle(profile.id)}>
                <span><Bot size={18} /></span>
                <div><strong>{profile.name}</strong><small>{profile.operationPlatformId || profile.id.startsWith('operation-platform:') ? `操作平台 · ${profile.description || '网页操作与已生效技能执行'}` : DESCRIPTIONS[profile.definitionId] ?? (profile.runtimeMode === 'external-cli' ? `外部 CLI${profile.cliConnectionName ? ` · ${profile.cliConnectionName}` : ''}` : '本地智能体')}</small></div>
                <i>{checked && <Check size={13} />}</i>
              </button>
            );
          })}
          {!loading && filtered.length === 0 && <div className="empty-hint">没有可添加的智能体</div>}
        </div>
        {error && <p className="dialog-error">{error}</p>}
        <footer><span>群聊成员 {existingAgents.length + selected.length}/9</span><div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={submitting || remaining === 0} onClick={() => void submit()}><UserPlus size={15} />{submitting ? '添加中…' : '添加到群聊'}</button></div></footer>
      </div>
    </div>
  );
}
