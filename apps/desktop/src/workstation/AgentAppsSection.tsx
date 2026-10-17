import { ArrowRight, Building2, Search } from 'lucide-react';
import type { RuntimeAgent } from '../api/runtime';

// 首页「我的智能体」模块的排序：三一规划置顶；群聊秘书是内部协调角色，不作为应用
const AGENT_APP_ORDER = ['建潘-三一规划智能体', '代码分析助手', 'PPT助手', '统筹智能体', '路线规划助手', '经营分析助手', '家居 AI 机会诊断', '本地执行智能体'];
const HIDDEN_AGENTS = new Set(['群聊秘书']);

/** 供首页「我的智能体」模块复用：过滤内部角色后按应用顺序排列。 */
export function sortAgentApps(agents: RuntimeAgent[]): RuntimeAgent[] {
  return [...agents]
    .filter(agent => !HIDDEN_AGENTS.has(agent.name))
    .sort((left, right) => {
      const leftIndex = AGENT_APP_ORDER.indexOf(left.name);
      const rightIndex = AGENT_APP_ORDER.indexOf(right.name);
      const leftRank = leftIndex >= 0 ? leftIndex : AGENT_APP_ORDER.length;
      const rightRank = rightIndex >= 0 ? rightIndex : AGENT_APP_ORDER.length;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.name.localeCompare(right.name, 'zh-Hans-CN');
    });
}

// 应用中心当前唯一的业务应用：集团三一规划（打开后进入独立应用页），其余未添加应用暂不展示
export const SANY_APP = {
  id: 'sany-planning',
  name: '集团三一规划',
  department: '集团战略BG',
  description: '集团三年战略规划：由人交接资料，智能体梳理资料与方法论，最终产出战略规划 PPT。',
  tags: ['战略规划', '资料梳理', 'PPT 产出'],
} as const;

/** 应用中心主内容：一个已添加应用（集团三一规划），点击打开进入独立应用页。 */
export function AgentAppsSection({ notify, onOpenApp }: {
  notify: (message: string) => void;
  onOpenApp: () => void;
}): React.JSX.Element {
  return (
    <section className="apps-main" aria-labelledby="agent-apps-title">
      <header className="ws-agent-heading">
        <div>
          <h1 id="agent-apps-title">应用中心</h1>
          <p>集团内可直接使用的业务应用：选一个应用，按它约定的步骤提交资料，由智能体梳理并产出交付物。当前已添加 1 个。</p>
        </div>
      </header>

      <div className="apps-toolbar">
        <label className="apps-search">
          <Search size={15} />
          <input placeholder="搜索应用名称 / 能力 / 归属部门" aria-label="搜索应用" onFocus={() => notify('当前仅 1 个应用，搜索暂不可用')} />
        </label>
        <span className="apps-count-note">共 1 个应用 · 已添加的应用会出现在左侧「已添加的应用」</span>
      </div>

      <div className="apps-grid apps-grid--single">
        <article className="apps-app-card">
          <header className="apps-app-card__head">
            <span className="apps-app-icon"><Building2 size={18} /></span>
            <div className="apps-app-card__title">
              <h3>{SANY_APP.name}</h3>
              <small>{SANY_APP.department}</small>
            </div>
            <span className="apps-badge apps-badge--added">已添加</span>
          </header>
          <p className="apps-app-card__desc">{SANY_APP.description}</p>
          <div className="apps-app-card__tags">
            {SANY_APP.tags.map(tag => <span key={tag}>{tag}</span>)}
          </div>
          <footer className="apps-app-card__foot">
            <span className="apps-app-card__added-note">已纳入我的工作台</span>
            <button type="button" className="apps-primary-button" onClick={onOpenApp}>打开应用 <ArrowRight size={14} /></button>
          </footer>
        </article>
      </div>
    </section>
  );
}
