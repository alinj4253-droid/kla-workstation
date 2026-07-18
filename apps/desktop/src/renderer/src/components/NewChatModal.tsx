import { Bot, Check, CirclePlus, Crown, Rocket, Search, Sparkles, X } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type AgentOption = {
  id: string;
  name: string;
  description: string;
  badge: string;
  tone: string;
};

const agentOptions: AgentOption[] = [
  { id: 'orchestrator', name: '统筹管理智能体', description: '拆解目标、安排协作并综合团队结论。', badge: 'BUILT-IN', tone: 'indigo' },
  { id: 'knowledge', name: '知识管理智能体', description: '处理文档、构建 Wiki 与可追溯知识图谱。', badge: 'BUILT-IN', tone: 'cyan' },
  { id: 'finance', name: '企业本地化专家', description: '支持本地业务资料归纳、核验与分析。', badge: 'PRO', tone: 'green' },
  { id: 'devops', name: 'DevOps 流程专家', description: '监控研发状态，协助处理 CI/CD 异常。', badge: 'TECH', tone: 'violet' },
  { id: 'creative', name: '创意洞察大脑', description: '发现跨领域线索并提出创新方向。', badge: 'IDEA', tone: 'orange' },
  { id: 'codex', name: 'Codex CLI', description: '调用本地 Codex CLI 进行代码协作。', badge: 'CLI', tone: 'slate' },
];

export function NewChatModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(['orchestrator']);
  const [leaderId, setLeaderId] = useState('orchestrator');
  const [submitted, setSubmitted] = useState(false);

  const filteredAgents = useMemo(
    () => agentOptions.filter((agent) => `${agent.name}${agent.description}`.toLowerCase().includes(query.toLowerCase())),
    [query],
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
    const projectId = `group-${Date.now()}`;
    await window.kunqing?.workspace.ensureProject({ projectId, name: name.trim() });
    onClose();
    navigate(`/projects/${projectId}/chat`, {
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
          {filteredAgents.map((agent) => {
            const isSelected = selected.includes(agent.id);
            const isLeader = leaderId === agent.id;
            return (
              <article key={agent.id} className={`agent-option-card${isSelected ? ' agent-option-card--selected' : ''}`}>
                {isLeader && <span className="leader-ribbon"><Crown size={10} /> LEADER</span>}
                <button type="button" className="agent-card-select" onClick={() => toggleAgent(agent.id)} aria-label={`${isSelected ? '取消选择' : '选择'}${agent.name}`}>
                  <span className={`agent-option-icon agent-option-icon--${agent.tone}`}><Bot size={18} /></span>
                  <span className="agent-check">{isSelected && <Check size={12} />}</span>
                  <strong>{agent.name}</strong><p>{agent.description}</p><em>{agent.badge}</em>
                </button>
                {isSelected && <button type="button" className="set-leader-button" onClick={() => setLeaderId(agent.id)} aria-label={`设为 Leader：${agent.name}`} title="设为 Leader"><Crown size={14} /></button>}
              </article>
            );
          })}
        </div>

        <footer className="new-chat-footer">
          <div className={agentsInvalid ? 'selection-error' : ''}><Sparkles size={16} /> 已选择 {selected.length} 个智能体{agentsInvalid && <span>，请至少选择一个</span>}</div>
          <div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button"><Rocket size={15} /> 开始协作</button></div>
        </footer>
      </form>
    </div>
  );
}
