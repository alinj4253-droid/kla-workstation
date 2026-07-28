import { Bot, Check, CirclePlus, Crown, Rocket, Search, Sparkles, X } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type AgentProfile = {
  id: string;
  name: string;
  definitionId: string;
  runtimeMode: 'native-model' | 'external-cli';
  enabled: boolean;
  delegatable: boolean;
  cliConnectionId: string | null;
  cliConnectionName: string | null;
  adapterType: string | null;
};

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  'builtin.orchestrator': '拆解目标、安排协作并综合团队结论。',
  'builtin.knowledge-manager': '处理文档、构建 Wiki 与可追溯知识图谱。',
  'builtin.researcher': '信息检索、资料分析和事实核查。',
};

const BUILTIN_TONES: Record<string, string> = {
  'builtin.orchestrator': 'indigo',
  'builtin.knowledge-manager': 'cyan',
  'builtin.researcher': 'green',
};

function getBadge(runtimeMode: string, delegatable: boolean): string {
  if (runtimeMode === 'external-cli') return 'CLI';
  if (delegatable) return 'LEADER';
  return 'BUILT-IN';
}

function getTone(agent: AgentProfile): string {
  if (agent.runtimeMode === 'external-cli') return 'slate';
  const builtinTone = BUILTIN_TONES[agent.definitionId];
  if (builtinTone) return builtinTone;
  return 'violet';
}

function getDescription(agent: AgentProfile): string {
  if (agent.runtimeMode === 'external-cli') {
    return agent.cliConnectionName
      ? `通过 ${agent.cliConnectionName}（${agent.adapterType ?? '未知'}）接入的外部 CLI 智能体`
      : '外部 CLI 智能体';
  }
  return BUILTIN_DESCRIPTIONS[agent.definitionId] ?? '内置智能体';
}

export function NewChatModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [leaderId, setLeaderId] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProfiles = async (): Promise<void> => {
      try {
        const result = await window.kunqing?.agents.listProfiles() as
          { ok: boolean; data?: AgentProfile[] } | undefined;
        if (result?.ok && result.data) {
          const enabledProfiles = result.data.filter((p) => p.enabled);
          setProfiles(enabledProfiles);
          // 默认选中第一个可委派的 Leader
          const defaultLeader = enabledProfiles.find(
            (p) => p.runtimeMode === 'native-model' && p.delegatable,
          );
          if (defaultLeader) {
            setSelected([defaultLeader.id]);
            setLeaderId(defaultLeader.id);
          }
        }
      } catch {
        // 静默失败
      } finally {
        setLoading(false);
      }
    };
    void fetchProfiles();
  }, []);

  const filteredAgents = useMemo(
    () => profiles.filter(
      (agent) => `${agent.name}${getDescription(agent)}`.toLowerCase().includes(query.toLowerCase()),
    ),
    [profiles, query],
  );
  const nameInvalid = submitted && !name.trim();
  const agentsInvalid = submitted && selected.length === 0;

  const toggleAgent = (id: string): void => {
    setSelected((current) => {
      if (current.includes(id)) {
        const next = current.filter((item) => item !== id);
        if (leaderId === id) setLeaderId(next[0] ?? '');
        return next;
      }
      if (current.length >= 9) return current;
      return [...current, id];
    });
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim() || selected.length === 0) return;
    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = await window.kunqing?.projects.create({
      idempotencyKey,
      content: { schemaVersion: 1, text: name.trim(), mentions: [], stagedUploadIds: [] },
      requestedAgentProfileIds: selected,
    }) as { ok: boolean; data?: { id: string } } | undefined;
    if (!result?.ok || !result.data) return;
    onClose();
    navigate(`/projects/${result.data.id}/chat`, {
      state: { projectName: name.trim(), agentIds: selected, leaderId, description: description.trim() },
    });
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="new-chat-modal" aria-labelledby="new-chat-title" onSubmit={(event) => void submit(event)}>
        <header className="modal-heading">
          <div><h2 id="new-chat-title">创建新对话</h2><p>选择一个或多个智能体来开始协作</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="new-chat-fields">
          <label><span>群聊名称 <em>*</em></span><input className={nameInvalid ? 'input-invalid' : ''} value={name} onChange={(event) => setName(event.target.value)} placeholder="请输入群聊名称..." />{nameInvalid && <small>群聊名称为必填项</small>}</label>
          <label><span>群聊描述</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="简要描述这个群聊的协作目标..." /></label>
        </div>

        <label className="agent-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索智能体（例如：知识分析、法律助手…）" /><kbd>{selected.length}/9</kbd></label>

        <div className="agent-picker-grid">
          <button type="button" className="custom-agent-card"><CirclePlus size={27} /><strong>自定义智能体</strong><span>Create a tailored assistant</span></button>
          {loading && <div className="loading-hint">加载智能体列表中…</div>}
          {!loading && filteredAgents.map((agent) => {
            const isSelected = selected.includes(agent.id);
            const isLeader = leaderId === agent.id;
            const tone = getTone(agent);
            return (
              <article key={agent.id} className={`agent-option-card${isSelected ? ' agent-option-card--selected' : ''}`}>
                {isLeader && <span className="leader-ribbon"><Crown size={10} /> LEADER</span>}
                <button type="button" className="agent-card-select" onClick={() => toggleAgent(agent.id)} aria-label={`${isSelected ? '取消选择' : '选择'}${agent.name}`}>
                  <span className={`agent-option-icon agent-option-icon--${tone}`}><Bot size={18} /></span>
                  <span className="agent-check">{isSelected && <Check size={12} />}</span>
                  <strong>{agent.name}</strong><p>{getDescription(agent)}</p><em>{getBadge(agent.runtimeMode, agent.delegatable)}</em>
                </button>
                {isSelected && agent.delegatable && agent.runtimeMode !== 'external-cli' && (
                  <button type="button" className="set-leader-button" onClick={() => setLeaderId(agent.id)} aria-label={`设为 Leader：${agent.name}`} title="设为 Leader"><Crown size={14} /></button>
                )}
              </article>
            );
          })}
          {!loading && filteredAgents.length === 0 && (
            <div className="empty-hint">没有匹配的智能体</div>
          )}
        </div>

        <footer className="new-chat-footer">
          <div className={agentsInvalid ? 'selection-error' : ''}><Sparkles size={16} /> 已选择 {selected.length} 个智能体{agentsInvalid && <span>，请至少选择一个</span>}</div>
          <div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button"><Rocket size={15} /> 开始协作</button></div>
        </footer>
      </form>
    </div>
  );
}