import {
  AlertTriangle,
  Bot,
  CheckCheck,
  Download,
  FileText,
  FolderOpen,
  Link2,
  Mic,
  MoreVertical,
  Paperclip,
  Plus,
  Send,
  SlidersHorizontal,
  Smile,
  Sparkles,
  X,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AgentAvatar } from '../components/AgentAvatar';

type ProjectListItem = {
  id: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'REVIEWING';
  name: string;
  preview: string;
  time: string;
};

type ChatMessage = {
  id: string;
  sender: string;
  role: 'financial' | 'manager' | 'user' | 'system';
  time: string;
  content: string;
};

const projects: ProjectListItem[] = [
  { id: 'annual-finance', status: 'ACTIVE', name: '年度财务报销审核', preview: 'Financial Agent: 正在校验发票真实性...', time: '14:20' },
  { id: 'supplier-bid', status: 'ARCHIVED', name: 'Q3 供应商招投标', preview: 'Bidding Agent: 招标文件已生成，请查阅', time: 'Yesterday' },
  { id: 'charter-review', status: 'REVIEWING', name: '项目章程审批流程', preview: 'Approval Agent: 主管已确认签字', time: 'Mon' },
];

const initialMessages: ChatMessage[] = [
  {
    id: 'm1',
    sender: 'Financial Agent',
    role: 'financial',
    time: '14:16',
    content: '我已经核对了最近 5 笔报销申请，发现编号 #29401 存在重复申报嫌疑。',
  },
  {
    id: 'm2',
    sender: 'Manager Agent',
    role: 'manager',
    time: '14:18',
    content: '收到。我正在调用历史归档接口，请协助标记该笔交易，并生成差异报告供主审官复核。',
  },
  {
    id: 'm3',
    sender: '项目负责人 (You)',
    role: 'user',
    time: '14:20',
    content: '同意标记。Financial Agent 请将标记后的列表导出为 PDF 发送至财务部审批节点。',
  },
];

export function ChatPage(): React.JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as { projectName?: string } | null;
  const initialProject = params.projectId ?? 'annual-finance';
  const [selectedProject, setSelectedProject] = useState(initialProject);
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [previewOpen, setPreviewOpen] = useState(true);

  useEffect(() => {
    setSelectedProject(params.projectId ?? 'annual-finance');
  }, [params.projectId]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === selectedProject) ?? { ...projects[0]!, id: params.projectId ?? projects[0]!.id, name: routeState?.projectName ?? '新建协作群聊' },
    [params.projectId, routeState?.projectName, selectedProject],
  );

  const sendMessage = (event: FormEvent): void => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;

    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, sender: '项目负责人 (You)', role: 'user', time: '刚刚', content },
    ]);
    setDraft('');
  };

  return (
    <div className={`chat-workspace${previewOpen ? '' : ' chat-workspace--preview-closed'}`}>
      <aside className="project-panel" aria-label="协作项目">
        <div className="project-panel__header">
          <h2>协作项目</h2>
          <button type="button" className="icon-button" aria-label="筛选项目"><SlidersHorizontal size={17} /></button>
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={`project-list-item${project.id === selectedProject ? ' project-list-item--active' : ''}`}
              onClick={() => setSelectedProject(project.id)}
            >
              <div className="project-list-item__meta">
                <span className={`status-pill status-pill--${project.status.toLowerCase()}`}>{project.status}</span>
                <time>{project.time}</time>
              </div>
              <strong>{project.name}</strong>
              <p>{project.preview}</p>
              {project.id === 'annual-finance' && (
                <div className="project-agents">
                  <AgentAvatar label="FA" tone="indigo" size="sm" />
                  <AgentAvatar label="MA" tone="cyan" size="sm" overlap />
                </div>
              )}
            </button>
          ))}
        </div>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-header">
          <div className="conversation-title">
            <div className="avatar-stack avatar-stack--header">
              <AgentAvatar label="FA" tone="indigo" size="sm" />
              <AgentAvatar label="MA" tone="cyan" size="sm" overlap />
              <AgentAvatar label="KM" tone="violet" size="sm" overlap />
            </div>
            <div>
              <h2>{activeProject.name}小组</h2>
              <p><span className="online-dot" /> 3 个智能体正在运行</p>
            </div>
          </div>
          <div className="conversation-actions">
            <button type="button" className="icon-button" aria-label="打开工作区" onClick={() => navigate(`/projects/${params.projectId ?? selectedProject}/workspace`)}><FolderOpen size={18} /></button>
            <button type="button" className="icon-button" aria-label="更多操作"><MoreVertical size={18} /></button>
          </div>
        </header>

        <div className="message-stream">
          <div className="date-divider"><span>Today, 14:15</span></div>
          {messages.map((message) => (
            <article key={message.id} className={`message-row message-row--${message.role}`}>
              {message.role !== 'user' && (
                <div className={`message-agent-icon message-agent-icon--${message.role}`}>
                  {message.role === 'financial' ? <FileText size={18} /> : <Bot size={18} />}
                </div>
              )}
              <div className="message-body">
                <div className="message-sender">
                  <strong>{message.sender}</strong>
                  <time>{message.time}</time>
                </div>
                <div className="message-bubble">
                  <p>{message.content}</p>
                  {message.role === 'financial' && (
                    <div className="risk-callout">
                      <AlertTriangle size={18} />
                      <div><strong>风险提示</strong><span>该笔报销金额：$1,240.00 与 10月12日记录重合。</span></div>
                    </div>
                  )}
                  {message.role !== 'user' && <span className="read-state"><CheckCheck size={13} /> 已读</span>}
                </div>
              </div>
            </article>
          ))}

          <button className="artifact-chip" type="button" onClick={() => setPreviewOpen(true)}>
            <Link2 size={16} />
            <span>Financial Agent 已生成 PDF 报告并上传至工作区</span>
            <em>查看文件</em>
          </button>
        </div>

        <form className="chat-composer-wrap" onSubmit={sendMessage}>
          <div className="chat-composer">
            <button type="button" className="composer-tool" aria-label="更多输入方式"><Plus size={18} /></button>
            <textarea
              aria-label="发送消息给智能体小组"
              placeholder="发送消息给智能体小组..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="button" className="composer-tool" aria-label="添加附件"><Paperclip size={17} /></button>
            <button type="button" className="composer-tool" aria-label="语音输入"><Mic size={17} /></button>
            <button type="button" className="composer-tool" aria-label="表情"><Smile size={17} /></button>
            <button className="chat-send" type="submit" disabled={!draft.trim()} aria-label="发送消息"><Send size={17} /></button>
          </div>
          <p><Sparkles size={12} /> AI 正在监控工作流合规性</p>
        </form>
      </section>

      {previewOpen && (
        <aside className="artifact-preview" aria-label="成果文件预览">
          <header className="preview-header">
            <div><FileText size={18} /><strong>年度财务报销汇总.html</strong></div>
            <div>
              <button type="button" className="icon-button" aria-label="下载文件"><Download size={17} /></button>
              <button type="button" className="icon-button" aria-label="关闭预览" onClick={() => setPreviewOpen(false)}><X size={18} /></button>
            </div>
          </header>
          <div className="preview-scroll">
            <article className="report-paper">
              <div className="report-title-row">
                <div>
                  <h2>2023年度财务报销汇总报告</h2>
                  <p>生成日期: 2023年10月24日 | 编号: FIN-2023-0942</p>
                </div>
                <span><CheckCheck size={13} /> 已核验</span>
              </div>
              <div className="report-stats">
                <div><small>提交部门</small><strong>财务管理部</strong></div>
                <div><small>审核状态</small><strong className="report-status">待终审</strong></div>
              </div>
              <h3>费用明细清单</h3>
              <table>
                <thead><tr><th>项目名称</th><th>类别</th><th>金额</th><th>状态</th></tr></thead>
                <tbody>
                  <tr><td>Q3 差旅补贴</td><td>差旅费</td><td>$450.00</td><td><span className="table-ok">正常</span></td></tr>
                  <tr><td>办公用品采购</td><td>行政费</td><td>$215.50</td><td><span className="table-ok">正常</span></td></tr>
                  <tr className="table-risk"><td>异常项 #29401</td><td>重复申报</td><td>$1,240.00</td><td>需复核</td></tr>
                </tbody>
              </table>
              <section className="ai-insight">
                <h3><Sparkles size={17} /> AI 智能洞察</h3>
                <ul>
                  <li>Financial Agent 识别出编号 #29401 的发票与 10月12日历史记录存在 100% 金额重合。</li>
                  <li>Manager Agent 已自动调取归档，确认该笔交易为重复录入风险。</li>
                  <li>建议在终审前剔除异常项，或要求申请人提供补充说明。</li>
                </ul>
              </section>
            </article>
          </div>
        </aside>
      )}
    </div>
  );
}
