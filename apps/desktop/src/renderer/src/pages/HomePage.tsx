import { ArrowRight, BarChart3, Braces, Check, ChevronRight, FileSearch, Palette, Paperclip, Send, Sparkles } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgentAvatar } from '../components/AgentAvatar';

type ProjectTemplate = {
  id: string;
  badge?: 'HOT' | 'BETA';
  title: string;
  description: string;
  agents: Array<{ label: string; tone: 'indigo' | 'cyan' | 'green' | 'violet' | 'orange' }>;
  count: number;
  icon: React.JSX.Element;
};

const templates: ProjectTemplate[] = [
  {
    id: 'annual-finance',
    badge: 'HOT',
    title: '财务审计协同',
    description: '财务、法务与合规智能体协同，自动化处理年度审计与风险评估。',
    agents: [{ label: '财', tone: 'cyan' }, { label: '法', tone: 'violet' }, { label: '合', tone: 'green' }],
    count: 3,
    icon: <Check size={16} />,
  },
  {
    id: 'market-research',
    badge: 'BETA',
    title: '市场调研小组',
    description: '数据采集与分析智能体配合，实时生成竞品动态与行业趋势报告。',
    agents: [{ label: '研', tone: 'indigo' }, { label: '数', tone: 'violet' }],
    count: 2,
    icon: <BarChart3 size={16} />,
  },
  {
    id: 'product-build',
    title: '智能研发协作',
    description: '架构设计、代码编写与测试智能体无缝衔接，加速产品交付周期。',
    agents: [{ label: '架', tone: 'orange' }, { label: '码', tone: 'green' }, { label: '测', tone: 'indigo' }],
    count: 3,
    icon: <Braces size={16} />,
  },
  {
    id: 'creative-studio',
    title: '创意营销工坊',
    description: '视觉设计与文案策划智能体共同打造多渠道品牌传播方案。',
    agents: [{ label: '创', tone: 'green' }, { label: '文', tone: 'cyan' }],
    count: 2,
    icon: <Palette size={16} />,
  },
];

export function HomePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');

  const openChat = (projectId = 'annual-finance'): void => {
    navigate(`/projects/${projectId}/chat`);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!prompt.trim()) return;
    openChat();
  };

  return (
    <section className="home-page">
      <span className="ambient-blob ambient-blob--left" />
      <span className="ambient-blob ambient-blob--right" />
      <div className="home-inner">
        <div className="home-hero">
          <h2>鲲擎智汇，由你开启</h2>
          <p>调度全球顶尖 AI 智能体，构建属于你的协同进化生态系统。</p>
        </div>

        <form className="home-composer" onSubmit={submit}>
          <div className="home-composer__editor">
            <Sparkles className="composer-spark" size={27} />
            <textarea
              aria-label="创建新协作"
              placeholder="How can I help you today? 我想分析上周的销售报告并生成摘要..."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
          <div className="home-composer__toolbar">
            <button className="composer-tool" type="button" aria-label="添加附件"><Paperclip size={18} /></button>
            <span className="composer-hint">支持文件、图片和 @智能体</span>
            <button className="send-button" type="submit" disabled={!prompt.trim()}>
              <span>发送</span>
              <Send size={15} />
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
              <button className="template-card" type="button" key={template.id} onClick={() => openChat(template.id)}>
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
