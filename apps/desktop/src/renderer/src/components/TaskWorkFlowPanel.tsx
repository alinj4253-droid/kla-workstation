import {
  ArrowDown, BarChart3, BookOpenText, Calculator, CheckCircle2, ChevronDown,
  CircleDashed, Database, FileCheck2, FileText, Layers3, Loader2, PackageCheck,
  Search, ShieldCheck, UserRound, Workflow,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BusinessProcess, BusinessProcessActionType, BusinessProcessStep } from '@kunqing/native-agent-core';
import type { RunActivity } from './VirtualMessageList';

type MessageItem = { id: string; contentJson: string; createdAt: string };

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function taskText(message: MessageItem | undefined): string {
  if (!message) return '未命名任务';
  try {
    const parsed = JSON.parse(message.contentJson) as { text?: unknown };
    return typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim() : '未命名任务';
  } catch {
    return message.contentJson.trim() || '未命名任务';
  }
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const ACTION_META: Record<BusinessProcessActionType, { label: string; Icon: typeof Search }> = {
  research: { label: '调研', Icon: Search },
  acquire: { label: '获取', Icon: Database },
  calculate: { label: '计算', Icon: Calculator },
  analyze: { label: '分析', Icon: BarChart3 },
  synthesize: { label: '汇总', Icon: Layers3 },
  validate: { label: '校验', Icon: ShieldCheck },
  deliver: { label: '交付', Icon: PackageCheck },
  other: { label: '处理', Icon: FileCheck2 },
};

function FlowStep({ step }: { step: BusinessProcessStep }): React.JSX.Element {
  const meta = ACTION_META[step.actionType] ?? ACTION_META.other;
  const Icon = meta.Icon;
  return (
    <div className="business-flow-step">
      <span className={`business-flow-step__icon business-flow-step__icon--${step.actionType}`}><Icon size={13} /></span>
      <div className="business-flow-step__body">
        <div className="business-flow-step__title"><strong>{step.title}</strong><em>{meta.label}</em></div>
        {step.description && <p>{step.description}</p>}
        {(step.owner || step.inputs?.length || step.outputs?.length) && (
          <dl className="business-flow-step__meta">
            {step.owner && <div><dt>负责</dt><dd>{step.owner}</dd></div>}
            {!!step.inputs?.length && <div><dt>输入</dt><dd>{step.inputs.join('、')}</dd></div>}
            {!!step.outputs?.length && <div><dt>输出</dt><dd>{step.outputs.join('、')}</dd></div>}
          </dl>
        )}
      </div>
    </div>
  );
}

function BusinessProcessCanvas({ process }: { process: BusinessProcess }): React.JSX.Element {
  if (!process.applicable) {
    return (
      <div className="business-flow-not-applicable">
        <CircleDashed size={22} />
        <strong>本次任务无需业务流程建模</strong>
        <p>{process.reason ?? '知识管理智能体判断本次内容不具备可复用的业务流程。'}</p>
        {process.knowledgeDocumentPath && <span><FileText size={12} />{process.knowledgeDocumentPath}</span>}
      </div>
    );
  }

  return (
    <div className="business-flow-model">
      <header className="business-flow-model__header">
        <span><Workflow size={16} /></span>
        <div><strong>{process.title}</strong>{process.summary && <p>{process.summary}</p>}</div>
      </header>
      <div className="business-flow-stages">
        {process.stages.map((stage, stageIndex) => (
          <div className="business-flow-stage-wrap" key={stage.id}>
            {stageIndex > 0 && <div className="business-flow-stage-connector"><ArrowDown size={14} /></div>}
            <article className="business-flow-stage">
              <header>
                <b>{String(stageIndex + 1).padStart(2, '0')}</b>
                <div><strong>{stage.title}</strong>{stage.objective && <p>{stage.objective}</p>}</div>
                {stage.owner && <em>{stage.owner}</em>}
              </header>
              <div className="business-flow-stage__steps">
                {stage.steps.map((step) => <FlowStep key={step.id} step={step} />)}
              </div>
            </article>
          </div>
        ))}
      </div>
      {process.knowledgeDocumentPath && (
        <footer className="business-flow-knowledge-file"><BookOpenText size={13} /><span>知识文档</span><code>{process.knowledgeDocumentPath}</code></footer>
      )}
    </div>
  );
}

function FlowChain({
  runs,
  message,
  forceExpanded,
}: {
  runs: RunActivity[];
  message?: MessageItem;
  forceExpanded: boolean;
}): React.JSX.Element {
  const active = runs.some((run) => !TERMINAL_STATUSES.has(run.status));
  const failed = runs.some((run) => run.status === 'failed');
  const process = runs
    .map((run) => run.businessProcess)
    .filter((item): item is BusinessProcess => Boolean(item))
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];
  const [expanded, setExpanded] = useState(forceExpanded);
  useEffect(() => setExpanded(forceExpanded), [forceExpanded]);
  const task = taskText(message);
  const subtitle = active && !process
    ? '任务完成后由知识管理智能体梳理业务流程'
    : process?.applicable
      ? `${process.stages.length} 个业务阶段 · ${process.generatedByAgentName}整理`
      : process
        ? '本次任务不适用业务流程梳理'
        : '尚未形成业务流程';

  return (
    <section className={`task-flow-chain${!active ? ' task-flow-chain--terminal' : ''}${failed ? ' task-flow-chain--failed' : ''}`} aria-label={`任务业务流程：${task}`}>
      <button type="button" className="task-flow-chain__summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="task-flow-chain__state">
          {failed ? <CircleDashed size={16} /> : active ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
        </span>
        <span className="task-flow-chain__title"><strong>{task}</strong><small>{subtitle}</small></span>
        <ChevronDown size={15} className={expanded ? 'task-flow-chain__chevron--open' : ''} />
      </button>
      {expanded && (
        <div className="task-flow-canvas task-flow-canvas--business">
          <article className="task-flow-node task-flow-node--user">
            <header className="task-flow-node__header">
              <span className="task-flow-node__icon"><UserRound size={16} /></span>
              <div><strong>业务需求</strong><small>任务目标与交付要求</small></div>
              <em>{formatTime(message?.createdAt)}</em>
            </header>
            <p className="task-flow-request-text">{task}</p>
          </article>
          <div className="task-flow-route-label"><Workflow size={13} /><span>知识管理智能体梳理的业务流程</span></div>
          {process
            ? <BusinessProcessCanvas process={process} />
            : <div className="business-flow-pending"><Loader2 size={18} className={active ? 'spin' : ''} /><strong>{active ? '业务流程将在任务完成后生成' : '尚未生成业务流程'}</strong><span>流程内容只来自知识管理智能体的任务成果归集，不使用运行轨迹代替。</span></div>}
        </div>
      )}
    </section>
  );
}

export function TaskWorkFlowPanel({
  runs,
  messages,
}: {
  runs: RunActivity[];
  messages: MessageItem[];
}): React.JSX.Element {
  const chains = useMemo(() => {
    const grouped = new Map<string, RunActivity[]>();
    for (const run of runs) {
      const key = run.triggerMessageId || `run:${run.runId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), run]);
    }
    return [...grouped.entries()].map(([triggerMessageId, groupedRuns]) => ({
      triggerMessageId,
      runs: groupedRuns,
      latestAt: groupedRuns.reduce((latest, run) => run.updatedAt > latest ? run.updatedAt : latest, ''),
      active: groupedRuns.some((run) => !TERMINAL_STATUSES.has(run.status)),
    })).sort((left, right) => right.latestAt.localeCompare(left.latestAt));
  }, [runs]);
  const messageMap = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const hasActiveChain = chains.some((chain) => chain.active);

  if (chains.length === 0) {
    return <div className="task-tree-empty task-tree-empty--panel"><CircleDashed size={24} /><strong>暂无业务流程</strong><span>任务完成后，知识管理智能体会在适用时生成业务流程。</span></div>;
  }

  return (
    <div className="task-flow-list">
      {chains.map((chain, index) => (
        <FlowChain
          key={chain.triggerMessageId}
          runs={chain.runs}
          {...(messageMap.get(chain.triggerMessageId) ? { message: messageMap.get(chain.triggerMessageId)! } : {})}
          forceExpanded={hasActiveChain ? chain.active : index === 0}
        />
      ))}
    </div>
  );
}
