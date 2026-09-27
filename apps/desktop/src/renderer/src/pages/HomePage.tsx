import { AlertTriangle, ArrowRight, BarChart3, Braces, Check, ChevronRight, FileSearch, Palette, Paperclip, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgentAvatar } from '../components/AgentAvatar';

type MentionRef = { target: { scope: 'profile'; id: string }; label: string; start: number; end: number };

const MENTION_RE = /@([\u4e00-\u9fff\w]+)/g;

function extractMentions(text: string, agentOptions: Array<{ id: string; name: string }>): MentionRef[] {
  const mentions: MentionRef[] = [];
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const matchedName = match[1]!;
    const agent = agentOptions.find((a) => a.name === matchedName);
    if (agent) {
      mentions.push({ target: { scope: 'profile', id: agent.id }, label: agent.name, start: match.index, end: match.index + matchedName.length + 1 });
    }
  }
  return mentions;
}

type ProjectTemplate = {
  id: string;
  badge?: 'HOT' | 'BETA';
  title: string;
  description: string;
  agents: Array<{ label: string; tone: 'indigo' | 'cyan' | 'green' | 'violet' | 'orange' }>;
  count: number;
  icon: React.JSX.Element;
  templateId: string;
  agentProfileIds: string[];
  firstPrompt: string;
};

const templates: ProjectTemplate[] = [
  {
    id: 'annual-finance', badge: 'HOT', title: '财务审计协同',
    description: '财务、法务与合规智能体协同，自动化处理年度审计与风险评估。',
    agents: [{ label: '财', tone: 'cyan' }, { label: '法', tone: 'violet' }, { label: '合', tone: 'green' }],
    count: 3, icon: <Check size={16} />,
    templateId: 'finance-audit', agentProfileIds: ['orchestrator', 'finance'],
    firstPrompt: '请协助整理本年度财务审计材料，包括发票核验、合规性检查和风险报告生成。',
  },
  {
    id: 'market-research', badge: 'BETA', title: '市场调研小组',
    description: '数据采集与分析智能体配合，实时生成竞品动态与行业趋势报告。',
    agents: [{ label: '研', tone: 'indigo' }, { label: '数', tone: 'violet' }],
    count: 2, icon: <BarChart3 size={16} />,
    templateId: 'market-research', agentProfileIds: ['orchestrator'],
    firstPrompt: '请对当前市场趋势进行分析，重点关注竞品动态和行业变化。',
  },
  {
    id: 'product-build', title: '智能研发协作',
    description: '架构设计、代码编写与测试智能体无缝衔接，加速产品交付周期。',
    agents: [{ label: '架', tone: 'orange' }, { label: '码', tone: 'green' }, { label: '测', tone: 'indigo' }],
    count: 3, icon: <Braces size={16} />,
    templateId: 'dev-collab', agentProfileIds: ['orchestrator', 'codex'],
    firstPrompt: '请协助进行需求分析、架构设计和代码实现，确保交付质量和进度。',
  },
  {
    id: 'creative-studio', title: '创意营销工坊',
    description: '视觉设计与文案策划智能体共同打造多渠道品牌传播方案。',
    agents: [{ label: '创', tone: 'green' }, { label: '文', tone: 'cyan' }],
    count: 2, icon: <Palette size={16} />,
    templateId: 'creative', agentProfileIds: ['orchestrator', 'creative'],
    firstPrompt: '请策划一个多渠道品牌传播方案，包含创意方向和内容策略。',
  },
];

export function HomePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [stagedUploadIds, setStagedUploadIds] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; name: string }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const generateIdempotencyKey = (): string =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const loadAgents = useCallback(async () => {
    const profRes = await ((window.kunqing?.agents.listProfiles() as Promise<{ ok: boolean; data: Array<{ id: string; name: string; runtimeMode: string }> }> | undefined) ?? Promise.resolve({ ok: true, data: [] }));
    const options: Array<{ id: string; name: string }> = (profRes?.data ?? [])
      .filter((p) => p.id !== 'builtin-gm-profile')
      .map((p) => ({ id: p.id, name: p.name }));
    setAgentOptions(options);
  }, []);

  useEffect(() => {
    window.kunqing?.drafts.get({ scope: 'home', scopeId: 'home' }).then((result) => {
      if (result && typeof result === 'object' && 'ok' in result && result.ok) {
        const data = (result as Record<string, unknown>).data as { contentJson: string | null };
        if (data?.contentJson) {
          try {
            const parsed = JSON.parse(data.contentJson) as { text?: string };
            if (parsed.text) setPrompt(parsed.text);
          } catch { /* ignore */ }
        }
      }
    }).finally(() => setInitialLoading(false));
    void loadAgents();
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, []);

  const saveDraft = useCallback((text: string) => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      window.kunqing?.drafts.update({ scope: 'home', scopeId: 'home', contentJson: JSON.stringify({ text }) });
    }, 500);
  }, []);

  const handlePromptChange = (value: string): void => {
    setPrompt(value);
    saveDraft(value);
    const lastAtIndex = value.lastIndexOf('@', value.length - 1);
    if (lastAtIndex >= 0 && (lastAtIndex === 0 || value[lastAtIndex - 1] === ' ')) {
      const afterAt = value.slice(lastAtIndex + 1);
      if (!afterAt.includes(' ')) {
        setShowMentions(true);
        setMentionQuery(afterAt);
        return;
      }
    }
    setShowMentions(false);
  };

  const insertMention = (agentName: string): void => {
    const lastAtIndex = prompt.lastIndexOf('@');
    if (lastAtIndex >= 0) {
      const before = prompt.slice(0, lastAtIndex);
      const afterAt = prompt.slice(lastAtIndex + 1);
      const restIndex = afterAt.indexOf(' ');
      const rest = restIndex >= 0 ? afterAt.slice(restIndex) : '';
      setPrompt(`${before}@${agentName}${rest} `);
    }
    setShowMentions(false);
    textareaRef.current?.focus();
  };

  const createProject = async (overrides?: { prompt?: string; templateId?: string; agentProfileIds?: string[] }): Promise<void> => {
    const text = overrides?.prompt ?? prompt;
    if (!text.trim() || submitting) return;
    setSubmitting(true);

    const idempotencyKey = generateIdempotencyKey();
    const mentions = extractMentions(text, agentOptions);
    const content = { schemaVersion: 1 as const, text, mentions, stagedUploadIds };
    const mentionedProfileIds = mentions
      .filter((m) => m.target.scope === 'profile')
      .map((m) => m.target.id)
      .filter((id) => id !== 'builtin-gm-profile');
    let gmPlan: { groupName: string; requestedAgentProfileIds: string[] } | null = null;
    if (!overrides?.agentProfileIds && window.kunqing?.projects.planHomeRequest) {
      const planResult = await window.kunqing.projects.planHomeRequest({ text }) as {
        ok?: boolean;
        data?: { groupName: string; requestedAgentProfileIds: string[] };
      } | undefined;
      if (planResult?.ok && planResult.data) gmPlan = planResult.data;
    }
    const profileIds = [...new Set([
      ...(gmPlan?.requestedAgentProfileIds ?? overrides?.agentProfileIds ?? ['builtin-orchestrator-profile']),
      ...mentionedProfileIds,
    ])].slice(0, 9);
    const result = await window.kunqing?.projects.create({
      idempotencyKey,
      content,
      templateId: overrides?.templateId ?? '',
      requestedAgentProfileIds: profileIds,
      ...(gmPlan?.groupName ? { customName: gmPlan.groupName } : {}),
      autoStart: true,
    });

    setSubmitting(false);

    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      const data = (result as Record<string, unknown>).data as { id: string };
      setPrompt('');
      setCreateError(null);
      window.kunqing?.drafts.update({ scope: 'home', scopeId: 'home', contentJson: JSON.stringify({ text: '' }) });
      navigate(`/projects/${data.id}/chat`);
    } else if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
      const err = (result as Record<string, unknown>).error as { message?: string } ?? {};
      setCreateError(err.message ?? '创建失败，请稍后重试');
    } else {
      setCreateError('创建失败，请检查连接后重试');
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void createProject();
  };

  const handleAttach = async (): Promise<void> => {
    if (attaching) return;
    setAttaching(true);
    const result = await window.kunqing?.drafts.chooseAttachments({ scope: 'home', scopeId: 'home' });
    setAttaching(false);
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      const data = (result as Record<string, unknown>).data as Array<{ id: string }>;
      if (data && Array.isArray(data)) {
        setStagedUploadIds((prev) => [...prev, ...data.map((f) => f.id)]);
      }
    }
  };

  const openTemplate = (projectTemplate: ProjectTemplate): void => {
    void createProject({
      prompt: projectTemplate.firstPrompt,
      templateId: projectTemplate.templateId,
      agentProfileIds: projectTemplate.agentProfileIds,
    });
  };

  const filteredAgents = agentOptions.filter((a) =>
    a.name.toLowerCase().includes(mentionQuery.toLowerCase()),
  );

  if (initialLoading) {
    return <section className="home-page"><div className="home-loading">加载中...</div></section>;
  }

  return (
    <section className="home-page">
      <span className="ambient-blob ambient-blob--left" />
      <span className="ambient-blob ambient-blob--right" />
      <div className="home-inner">
        <div className="home-hero">
          <h2>鲲擎智汇，由你开启</h2>
          <p>调度全球顶尖 AI 智能体，构建属于你的协同进化生态系统。</p>
        </div>

        {createError && (
          <div className="home-error">
            <AlertTriangle size={16} />
            <span>{createError}</span>
            <button type="button" className="icon-button" onClick={() => setCreateError(null)}><X size={16} /></button>
          </div>
        )}
        <form className="home-composer" onSubmit={submit}>
          <div className="home-composer__editor" style={{ position: 'relative' }}>
            <Sparkles className="composer-spark" size={27} />
            <textarea
              ref={textareaRef}
              aria-label="创建新协作"
              placeholder="输入您的问题或需求，按 Enter 发送..."
              value={prompt}
              onChange={(event) => handlePromptChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void createProject(); } }}
              disabled={submitting}
            />
            {showMentions && filteredAgents.length > 0 && (
              <div className="mention-popup">
                {filteredAgents.map((agent) => (
                  <button type="button" key={agent.id} className="mention-option" onMouseDown={() => insertMention(agent.name)}>
                    {agent.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="home-composer__toolbar">
            <button className="composer-tool" type="button" aria-label="添加附件" disabled={submitting || attaching} onClick={() => void handleAttach()}>
              <Paperclip size={18} />
            </button>
            {stagedUploadIds.length > 0 && <span className="composer-attachment-count">{stagedUploadIds.length}个附件</span>}
            <span className="composer-hint">支持文件、图片和 @智能体</span>
            <button className="send-button" type="submit" disabled={(!prompt.trim() && stagedUploadIds.length === 0) || submitting}>
              {submitting ? <span>创建中...</span> : <><span>发送</span><Send size={15} /></>}
            </button>
          </div>
        </form>

        <section className="template-section" aria-labelledby="template-title">
          <div className="section-heading">
            <h3 id="template-title">推荐多智能体项目</h3>
            <button type="button">查看全部 <ArrowRight size={15} /></button>
          </div>
          <div className="template-grid">
            {templates.map((template) => (
              <button className="template-card" type="button" key={template.id} onClick={() => openTemplate(template)}>
                <div className="template-card__top">
                  <div className="avatar-stack">
                    {template.agents.map((agent, index) => (
                      <AgentAvatar key={`${template.id}-${agent.label}`} label={agent.label} tone={agent.tone} overlap={index > 0} />
                    ))}
                  </div>
                  {template.badge && <span className={`template-badge template-badge--${template.badge.toLowerCase()}`}>{template.badge}</span>}
                </div>
                <span className="template-card__icon">{template.icon}</span>
                <h4>{template.title}</h4>
                <p>{template.description}</p>
                <div className="template-card__meta">
                  <span><FileSearch size={14} /> {template.count} 个智能体协作</span>
                  <ChevronRight size={16} />
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
