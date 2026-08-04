import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, CircleDashed, GitBranch, Loader2, UserRound, XCircle } from 'lucide-react';
import { AgentAvatar, getAgentTone } from './AgentAvatar';
import { AgentWorkTree, type RunActivity } from './VirtualMessageList';

type MessageItem = {
  id: string;
  senderType: string;
  contentJson: string;
  createdAt: string;
};

type ProjectAgent = { id: string; agentName: string };

interface TaskWorkTreePanelProps {
  runs: RunActivity[];
  messages: MessageItem[];
  projectAgents: ProjectAgent[];
  onCancelRun: (runId: string) => void;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function messageText(message: MessageItem | undefined): string {
  if (!message) return '未关联到当前消息列表的任务';
  try {
    const parsed = JSON.parse(message.contentJson) as { text?: unknown };
    return typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text.trim() : '未命名任务';
  } catch {
    return message.contentJson.trim() || '未命名任务';
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function WorkRunBranch({
  run,
  allRuns,
  projectAgents,
  onCancelRun,
  depth,
  forceExpanded,
}: {
  run: RunActivity;
  allRuns: RunActivity[];
  projectAgents: ProjectAgent[];
  onCancelRun: (runId: string) => void;
  depth: number;
  forceExpanded: boolean;
}): React.JSX.Element {
  const children = allRuns
    .filter((candidate) => candidate.parentRunId === run.runId)
    .sort((left, right) => (left.createdAt ?? left.updatedAt).localeCompare(right.createdAt ?? right.updatedAt));
  const agentName = projectAgents.find((agent) => agent.id === run.agentId)?.agentName ?? run.agentName ?? '智能体';
  const requesterName = projectAgents.find((agent) => agent.id === run.requestedById)?.agentName;
  const relationLabel = requesterName ? `${requesterName}委派` : run.requestedByType === 'user' ? '用户发起' : '协作执行';
  const latestChildAt = children.reduce((latest, child) => {
    const value = Date.parse(child.updatedAt);
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, 0);
  const shouldSplitRoot = depth === 0 && children.length > 0;
  const finalTraces = shouldSplitRoot
    ? run.traces.filter((trace) => Date.parse(trace.at) > latestChildAt || /收集完成|验收|汇总|提交|交付|最终/.test(trace.title))
    : [];
  const finalTraceIds = new Set(finalTraces.map((trace) => trace.id));
  const planningRun = finalTraces.length > 0 ? { ...run, traces: run.traces.filter((trace) => !finalTraceIds.has(trace.id)) } : run;

  return (
    <div className="task-run-branch" data-depth={Math.min(depth, 4)}>
      <div className="task-run-branch__agent">
        <AgentAvatar
          label={agentName}
          tone={getAgentTone(run.agentId ?? run.runId, projectAgents.map((agent) => agent.id))}
          size="sm"
        />
        <span>{requesterName ? `${requesterName} 委派` : run.requestedByType === 'user' ? '用户发起' : '协作执行'}</span>
      </div>
      <div className="task-run-branch__content">
        <div className="task-run-branch__heading"><strong>{agentName}</strong><span>{relationLabel}</span></div>
        <AgentWorkTree
          run={planningRun}
          projectAgents={projectAgents}
          onCancel={onCancelRun}
          formatTime={formatTime}
          autoCollapse={false}
          forceExpanded={forceExpanded}
          phaseLabel={depth === 0 ? '任务理解、拆解与调度' : '独立工作包执行'}
        />
        {children.length > 0 && (
          <div className="task-run-branch__children">
            {children.map((child) => (
              <WorkRunBranch
                key={child.runId}
                run={child}
                allRuns={allRuns}
                projectAgents={projectAgents}
                onCancelRun={onCancelRun}
                depth={depth + 1}
                forceExpanded={forceExpanded}
              />
            ))}
          </div>
        )}
        {finalTraces.length > 0 && (
          <div className="task-run-continuation">
            <div className="task-run-branch__heading"><strong>{agentName}</strong><span>最终汇总</span></div>
            <AgentWorkTree
              run={{ ...run, traces: finalTraces }}
              projectAgents={projectAgents}
              onCancel={onCancelRun}
              formatTime={formatTime}
              autoCollapse={false}
              forceExpanded={forceExpanded}
              phaseLabel="验收、汇总与交付"
              hideChecklist
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TaskChain({
  runs,
  message,
  projectAgents,
  onCancelRun,
  forceExpanded,
}: {
  runs: RunActivity[];
  message?: MessageItem;
  projectAgents: ProjectAgent[];
  onCancelRun: (runId: string) => void;
  forceExpanded: boolean;
}): React.JSX.Element {
  const terminal = runs.every((run) => TERMINAL_STATUSES.has(run.status));
  const failed = runs.some((run) => run.status === 'failed');
  const [expanded, setExpanded] = useState(forceExpanded || !terminal);
  useEffect(() => {
    if (forceExpanded || !terminal) setExpanded(true);
  }, [terminal, forceExpanded]);

  const roots = runs
    .filter((run) => !run.parentRunId || !runs.some((candidate) => candidate.runId === run.parentRunId))
    .sort((left, right) => (left.createdAt ?? left.updatedAt).localeCompare(right.createdAt ?? right.updatedAt));
  const runningCount = runs.filter((run) => !TERMINAL_STATUSES.has(run.status)).length;
  const task = messageText(message);

  return (
    <section className={`task-chain${terminal ? ' task-chain--terminal' : ''}${failed ? ' task-chain--failed' : ''}`} aria-label={`任务工作树：${task}`}>
      <button type="button" className="task-chain__summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="task-chain__state">
          {failed ? <XCircle size={16} /> : terminal ? <CheckCircle2 size={16} /> : <Loader2 size={16} className="spin" />}
        </span>
        <span className="task-chain__title">
          <strong>{task}</strong>
          <small>{terminal ? `${runs.length} 个执行节点${failed ? '已结束，部分未完成' : '已完成'}` : `${runningCount} 个节点执行中 · 共 ${runs.length} 个`}</small>
        </span>
        <ChevronDown size={15} className={expanded ? 'task-chain__chevron--open' : ''} />
      </button>

      {expanded && (
        <div className="task-chain__body">
          <div className="task-request-node">
            <span><UserRound size={15} /></span>
            <div>
              <strong>项目负责人发出需求</strong>
              <p>{task}</p>
              <time>{formatTime(message?.createdAt ?? runs[0]?.createdAt ?? runs[0]?.updatedAt ?? new Date().toISOString())}</time>
            </div>
          </div>
          <div className="task-chain__connector"><GitBranch size={14} /><span>任务拆解与协作执行</span></div>
          {roots.length > 0 ? roots.map((run) => (
            <WorkRunBranch
              key={run.runId}
              run={run}
              allRuns={runs}
              projectAgents={projectAgents}
              onCancelRun={onCancelRun}
              depth={0}
              forceExpanded={forceExpanded}
            />
          )) : (
            <div className="task-tree-empty"><CircleDashed size={16} /><span>等待执行节点</span></div>
          )}
        </div>
      )}
    </section>
  );
}

export function TaskWorkTreePanel({ runs, messages, projectAgents, onCancelRun }: TaskWorkTreePanelProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const chains = useMemo(() => {
    const grouped = new Map<string, RunActivity[]>();
    for (const run of runs) {
      const key = run.triggerMessageId || `run:${run.runId}`;
      const group = grouped.get(key) ?? [];
      group.push(run);
      grouped.set(key, group);
    }
    return [...grouped.entries()]
      .map(([triggerMessageId, groupedRuns]) => ({
        triggerMessageId,
        runs: groupedRuns,
        latestAt: groupedRuns.reduce((latest, run) => run.updatedAt > latest ? run.updatedAt : latest, ''),
      }))
      .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
  }, [runs]);
  const messageMap = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  if (chains.length === 0) {
    return (
      <div className="task-tree-empty task-tree-empty--panel">
        <CircleDashed size={24} />
        <strong>暂无任务执行记录</strong>
        <span>发送任务后，完整协作过程会显示在这里。</span>
      </div>
    );
  }

  return (
    <div ref={listRef} className="task-worktree-list">
      {chains.map((chain, index) => (
        <TaskChain
          key={chain.triggerMessageId}
          runs={chain.runs}
          {...(messageMap.get(chain.triggerMessageId)
            ? { message: messageMap.get(chain.triggerMessageId)! }
            : {})}
          projectAgents={projectAgents}
          onCancelRun={onCancelRun}
          forceExpanded={index === 0 || chain.runs.some((run) => !TERMINAL_STATUSES.has(run.status))}
        />
      ))}
    </div>
  );
}
