import { useState } from 'react';
import { PageHead, Card, Tag, Btn, StatusTag, Pbar, Section, Alert, Modal } from '../ui';
import { useSanyData } from '../SanyDataContext';
import type { SanyView } from '../SanyPlanningSection';
import type { SanyWorkflowDto } from '../../../api/sany';

type Props = { onNavigate?: (view: SanyView) => void };

const SUBMISSION_TONE: Record<string, 'v' | 'g' | 'r' | 'w' | 'line'> = {
  submitted: 'v',
  returned: 'r',
  accepted: 'g',
  closed: 'g',
};

const CLOSURE_LABEL: Record<string, string> = {
  reminded: '提醒',
  returned: '退回',
  accepted: '通过',
  closed: '收束',
};

const EVENT_LABEL: Record<string, string> = {
  assigned: '任务派发',
  submitted: '成果提交',
  reminded: '批量提醒',
  returned: '退回重做',
  accepted: '通过审核',
  closed: '任务收束',
};

export function AdminTrackPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions, workflow, setWorkflow } = useSanyData();
  const tasks = data.tasks;
  const totalPrefill = tasks.reduce((sum, req) => sum + req.prefill, 0);
  const totalVerified = tasks.reduce((sum, req) => sum + req.verified, 0);
  const totalGaps = tasks.reduce((sum, req) => sum + req.gaps, 0);
  const totalSubmissions = tasks.reduce((sum, req) => sum + req.submissions, 0);
  const closedCount = tasks.filter(task => task.status === '已收束').length;
  const coverage = totalPrefill ? Math.round(totalVerified / totalPrefill * 100) : 0;
  const gapRows = data.fields
    .filter(field => field.scope === 'unit' && field.status === 'missing' && !field.removed)
    .map(field => ({
      unit: tasks.find(task => task.id === field.taskId)?.unit ?? '—',
      field: field.n,
      need: field.gap ?? '相关材料不足',
    }));

  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [closureTaskId, setClosureTaskId] = useState<string | null>(null);
  const [closureAction, setClosureAction] = useState<'reminded' | 'returned' | 'accepted' | 'closed'>('reminded');
  const [closureNote, setClosureNote] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);

  const batchRemind = async () => {
    const targets = tasks.filter(task => task.status !== '已收束' && task.status !== '已通过');
    if (!targets.length) {
      setBatchResult('所有任务均已通过或收束，无需提醒');
      return;
    }
    setBatchRunning(true);
    setBatchResult(null);
    let done = 0;
    let failed = 0;
    for (const task of targets) {
      const result = await actions.closeTask(task.id, { action: 'reminded', note: '截止临近，请尽快提交成果' });
      if (result) done += 1; else failed += 1;
    }
    setBatchRunning(false);
    setBatchResult(failed ? `已向 ${done} 个单元发送催办，${failed} 个失败，请查看错误提示` : `已向 ${done} 个单元发送催办提醒，计入收束历史`);
  };

  const openDetail = async (taskId: string) => {
    setDetailTaskId(taskId);
    setDetailLoading(true);
    try {
      const next = await actions.fetchTaskWorkflow(taskId);
      setWorkflow(next ?? null);
    } catch {
      setWorkflow(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetailTaskId(null);
    setWorkflow(null);
  };

  const openClosure = (taskId: string, action: 'reminded' | 'returned' | 'accepted' | 'closed') => {
    setClosureTaskId(taskId);
    setClosureAction(action);
    setClosureNote('');
  };

  const confirmClosure = async () => {
    if (!closureTaskId) return;
    await actions.closeTask(closureTaskId, { action: closureAction, note: closureNote });
    setClosureTaskId(null);
    if (detailTaskId === closureTaskId) await openDetail(closureTaskId);
  };

  const detail = workflow && detailTaskId === workflow.task.id ? workflow : null;
  const detailTask = detail ? tasks.find(task => task.id === detailTaskId) ?? null : null;
  const latestSubmission = detail?.submissions[detail.submissions.length - 1] ?? null;
  const canReturn = !!latestSubmission && latestSubmission.status !== 'closed' && latestSubmission.status !== 'accepted';
  const canAccept = !!latestSubmission && (latestSubmission.status === 'submitted' || latestSubmission.status === 'returned');
  const canClose = !!latestSubmission && latestSubmission.status === 'accepted';

  return (
    <section className="sany-page">
      <PageHead
        title="任务收束"
        sub="按单元查看材料齐备度、内容生成与校验进度；负责人提交成果后在此核验、退回或收束"
        actions={(
          <>
            <Btn disabled={batchRunning} onClick={() => void batchRemind()}>{batchRunning ? '提醒中…' : '批量提醒'}</Btn>
            <Btn tone="pri" onClick={() => onNavigate?.('review')}>进入汇总审阅</Btn>
          </>
        )}
      />

      {batchResult ? (
        <div className="sany-mb16">
          <Alert tone="g" icon="✓">
            {batchResult}
            <button type="button" className="sany-link" onClick={() => setBatchResult(null)} style={{ marginLeft: 8 }}>关闭</button>
          </Alert>
        </div>
      ) : null}

      <Card className="sany-card--pad sany-mb16">
        <div className="sany-row sany-gap20 sany-mb12">
          <div>
            <div className="sany-small">整体校验覆盖率</div>
            <div className="sany-coverage">{coverage}%</div>
          </div>
          <div className="sany-grow">
            <div className="sany-row sany-gap12 sany-mb4">
              <span className="sany-small">已生成 <b className="sany-mono sany-ink">{totalPrefill}</b> 项</span>
              <span className="sany-small">人工已确认 <b className="sany-mono sany-ok">{totalVerified}</b> 项</span>
              <span className="sany-small">缺材料致 {totalGaps} 项无法填充</span>
            </div>
            <Pbar value={coverage} height={8} />
          </div>
          <div className="sany-vline" />
          <div className="sany-row sany-gap16">
            <div>
              <div className="sany-small">成果提交</div>
              <div className="sany-strong">{totalSubmissions} 次</div>
            </div>
            <div>
              <div className="sany-small">已收束</div>
              <div className="sany-strong sany-ok">{closedCount} / {tasks.length}</div>
            </div>
          </div>
        </div>
      </Card>

      <Section title="按责任单元收束" sub={`${tasks.length} 项任务 · 点击「明细」查看成果提交与收束历史`}>
        <div className="sany-stack">
          {tasks.map(req => {
            const pct = req.prefill ? Math.round(req.verified / req.prefill * 100) : 0;
            return (
              <Card className="sany-card--pad" key={req.id}>
                <div className="sany-row sany-mb12">
                  <span className="sany-mono sany-small">{req.id}</span>
                  <b>{req.unit}</b>
                  <Tag tone="v">{req.type} {req.typeName}</Tag>
                  <StatusTag status={req.status} />
                  <span className="sany-spacer" />
                  <span className="sany-small">负责人 {req.owner} · 截止 {req.deadline.slice(5)}</span>
                </div>
                <div className="sany-grid g4 sany-gap12 sany-mb12">
                  <div className="sany-mini">
                    <div className="sany-mini__l">已上传材料</div>
                    <div className="sany-mini__v">{req.docs} <span className="sany-mini__u">份</span></div>
                  </div>
                  <div className="sany-mini">
                    <div className="sany-mini__l">已生成</div>
                    <div className="sany-mini__v">{req.prefill} <span className="sany-mini__u">项</span></div>
                  </div>
                  <div className="sany-mini ok">
                    <div className="sany-mini__l">已确认</div>
                    <div className="sany-mini__v">{req.verified} <span className="sany-mini__u">项</span></div>
                  </div>
                  <div className={`sany-mini ${req.gaps ? 'warn' : ''}`}>
                    <div className="sany-mini__l">缺材料项</div>
                    <div className="sany-mini__v">{req.gaps} <span className="sany-mini__u">项</span></div>
                  </div>
                </div>
                <div className="sany-row sany-gap12 sany-mb12">
                  <div className="sany-grow"><Pbar value={pct} tone={pct >= 100 ? 'ok' : pct < 40 ? 'warn' : undefined} /></div>
                  <span className="sany-mono sany-small sany-strong">{pct}%</span>
                </div>
                {req.submissions ? (
                  <div className="sany-row sany-gap12 sany-mb12">
                    <span className="sany-small">成果提交 <b className="sany-mono sany-ink">{req.submissions}</b> 次</span>
                    {req.latestSubmission ? (
                      <>
                        <Tag tone={SUBMISSION_TONE[req.latestSubmission.status] ?? 'line'}>最新提交 {req.latestSubmission.status === 'submitted' ? '待审核' : req.latestSubmission.status === 'returned' ? '已退回' : req.latestSubmission.status === 'accepted' ? '已通过' : '已收束'}</Tag>
                        <span className="sany-small sany-muted">第 {req.latestSubmission.no} 次 · {req.latestSubmission.summary}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <div className="sany-row sany-gap8">
                  <Btn size="sm" onClick={() => void openDetail(req.id)}>明细</Btn>
                  {req.status !== '已收束' ? (
                    <>
                      <Btn size="sm" onClick={() => openClosure(req.id, 'reminded')}>提醒</Btn>
                      {canReturnFor(req) ? <Btn size="sm" tone="pri" onClick={() => openClosure(req.id, 'returned')}>退回</Btn> : null}
                      {canAcceptFor(req) ? <Btn size="sm" tone="ok" onClick={() => openClosure(req.id, 'accepted')}>通过</Btn> : null}
                      {canCloseFor(req) ? <Btn size="sm" tone="ok" onClick={() => openClosure(req.id, 'closed')}>收束</Btn> : null}
                    </>
                  ) : null}
                  <span className="sany-spacer" />
                  {req.gaps ? <span className="sany-small sany-warn">缺料 {req.gaps} 项</span> : null}
                </div>
                {req.gaps ? (
                  <div className="sany-mt12">
                    <Alert tone="w" icon="!">该单元有 {req.gaps} 项内容因缺材料无法生成，已自动通知负责人补充。</Alert>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      </Section>

      <Section title="缺料汇总" sub={`${totalGaps} 项，统一查看各单元卡在哪些材料上`}>
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: '22%' }}>单元</th>
                <th style={{ width: '26%' }}>缺失字段</th>
                <th>需要什么材料</th>
                <th style={{ width: 96 }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {gapRows.map(row => (
                <tr key={`${row.unit}-${row.field}`}>
                  <td className="sany-strong">{row.unit}</td>
                  <td>{row.field}</td>
                  <td className="sany-small">{row.need}</td>
                  <td><Tag tone="w">待补充</Tag></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Modal
        open={!!detailTaskId}
        wide
        title={detailTask ? `任务明细 · ${detailTask.unit}` : '任务明细'}
        sub={detailTask ? `${detailTask.code} · ${detailTask.title}` : ''}
        onClose={closeDetail}
        footer={<Btn onClick={closeDetail}>关闭</Btn>}
      >
        {detailLoading ? (
          <div className="sany-center"><div className="sany-empty__t">正在加载任务工作流…</div></div>
        ) : !detail ? (
          <div className="sany-center"><div className="sany-empty__t">未找到工作流数据</div></div>
        ) : (
          <TaskWorkflowDetail
            workflow={detail}
            canReturn={canReturn}
            canAccept={canAccept}
            canClose={canClose}
            onClosure={openClosure}
          />
        )}
      </Modal>

      <Modal
        open={!!closureTaskId}
        title={`${CLOSURE_LABEL[closureAction]}任务`}
        sub={closureAction === 'reminded' ? '向负责人发送催办提醒，不改变任务状态' : closureAction === 'returned' ? '退回后负责人从缺口处理接手，已确认内容不会丢失' : closureAction === 'accepted' ? '通过后任务进入已通过，负责人可继续完善但不再重交' : '收束后任务关闭，不再接受新的成果提交'}
        onClose={() => setClosureTaskId(null)}
        footer={(
          <>
            <Btn onClick={() => setClosureTaskId(null)}>取消</Btn>
            <Btn tone="pri" onClick={() => void confirmClosure()}>确认{CLOSURE_LABEL[closureAction]}</Btn>
          </>
        )}
      >
        <div className="sany-fld" style={{ marginBottom: 12 }}>
          <label>处理意见</label>
          <textarea rows={3} value={closureNote} onChange={event => setClosureNote(event.target.value)}
            placeholder={closureAction === 'returned' ? '例：市场占有率目标仍缺三年测算，请补充后重提' : closureAction === 'accepted' ? '例：目标口径已对齐，内容通过' : closureAction === 'closed' ? '例：成果齐全，正式收束' : '例：截止临近，请尽快提交'} />
        </div>
        <Alert icon="i">操作会写入收束历史并更新任务状态；已归档的提交不会被删除。</Alert>
      </Modal>
    </section>
  );
}

function canReturnFor(task: { submissions: number; latestSubmission: { status: string } | null }): boolean {
  return !!task.latestSubmission && task.latestSubmission.status !== 'closed' && task.latestSubmission.status !== 'accepted';
}

function canAcceptFor(task: { submissions: number; latestSubmission: { status: string } | null }): boolean {
  return !!task.latestSubmission && (task.latestSubmission.status === 'submitted' || task.latestSubmission.status === 'returned');
}

function canCloseFor(task: { submissions: number; latestSubmission: { status: string } | null }): boolean {
  return !!task.latestSubmission && task.latestSubmission.status === 'accepted';
}

function TaskWorkflowDetail({ workflow, canReturn, canAccept, canClose, onClosure }: {
  workflow: SanyWorkflowDto;
  canReturn: boolean;
  canAccept: boolean;
  canClose: boolean;
  onClosure: (taskId: string, action: 'reminded' | 'returned' | 'accepted' | 'closed') => void;
}): React.JSX.Element {
  const task = workflow.task;
  const assignment = workflow.assignment;
  const assignmentLabel: Record<string, string> = {
    assigned: '待开始',
    in_progress: '执行中',
    submitted: '已提交',
    returned: '已退回',
    accepted: '已通过',
    closed: '已收束',
  };
  return (
    <div className="sany-stack">
      <Card className="sany-card--pad sany-card--soft">
        <div className="sany-row sany-gap12 sany-mb8">
          <span className="sany-mono sany-small">{task.code}</span>
          <b className="sany-grow">{task.title}</b>
          <StatusTag status={task.status} />
        </div>
        <div className="sany-row sany-gap12">
          <span className="sany-small">负责人 {task.owner}</span>
          <span className="sany-small">截止 {task.deadline}</span>
          <span className="sany-small">规划周期 {task.requirements.length ? '已下发要求' : '—'}</span>
        </div>
        {assignment ? (
          <div className="sany-row sany-gap12 sany-mt8">
            <Tag tone="v">派发状态 {assignmentLabel[assignment.status] ?? assignment.status}</Tag>
            {assignment.submittedAt ? <span className="sany-small">提交于 {assignment.submittedAt}</span> : null}
            {assignment.acceptedAt ? <span className="sany-small">通过于 {assignment.acceptedAt}</span> : null}
            {assignment.closedAt ? <span className="sany-small">收束于 {assignment.closedAt}</span> : null}
          </div>
        ) : null}
        {assignment?.individualNote ? (
          <div className="sany-mt8"><Alert icon="i">个别要求：{assignment.individualNote}</Alert></div>
        ) : null}
        {task.requirements.length ? (
          <div className="sany-mt8">
            <div className="sany-strong sany-mb4">下发要求</div>
            {task.requirements.map(req => <div className="sany-bullet" key={req}><span>·</span><span>{req}</span></div>)}
          </div>
        ) : null}
      </Card>

      <div className="sany-grid g2 sany-align-start">
        <Section title="成果提交" sub={`${workflow.submissions.length} 次提交记录`} style={{ marginBottom: 0 }}>
          {workflow.submissions.length === 0 ? (
            <Card className="sany-card--pad sany-card--soft">
              <div className="sany-small sany-muted">负责人尚未提交成果。</div>
            </Card>
          ) : (
            <div className="sany-stack">
              {workflow.submissions.map(sub => (
                <Card className="sany-card--pad" key={sub.id}>
                  <div className="sany-row sany-mb8">
                    <Tag tone="v">第 {sub.no} 次</Tag>
                    <Tag tone={SUBMISSION_TONE[sub.status] ?? 'line'}>{sub.status === 'submitted' ? '待审核' : sub.status === 'returned' ? '已退回' : sub.status === 'accepted' ? '已通过' : '已收束'}</Tag>
                    <span className="sany-spacer" />
                    <span className="sany-small">{sub.submittedAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                  <div className="sany-strong sany-mb8">{sub.summary}</div>
                  {sub.deliverables.length ? (
                    <div className="sany-row sany-gap8 sany-mb8">
                      {sub.deliverables.map(item => <Tag tone="line" key={item.name}>{item.name}</Tag>)}
                    </div>
                  ) : null}
                  {sub.fieldSnapshot.length ? (
                    <div className="sany-small sany-muted">
                      提交时字段快照：{sub.fieldSnapshot[0].total} 项 · 已确认 {sub.fieldSnapshot[0].accepted} · 缺料 {sub.fieldSnapshot[0].missing}
                    </div>
                  ) : null}
                  {sub.reviewerNote ? (
                    <div className="sany-mt8"><Alert tone={sub.status === 'returned' ? 'r' : undefined} icon="i">管理员意见：{sub.reviewerNote}</Alert></div>
                  ) : null}
                  {sub.reviewedAt ? <div className="sany-small sany-muted sany-mt4">审核于 {sub.reviewedAt.slice(0, 16).replace('T', ' ')}</div> : null}
                </Card>
              ))}
            </div>
          )}
        </Section>

        <Section title="收束操作" sub="管理员对任务的处置记录" style={{ marginBottom: 0 }}>
          <div className="sany-row sany-gap8 sany-mb12">
            <Btn size="sm" onClick={() => onClosure(task.id, 'reminded')}>提醒</Btn>
            {canReturn ? <Btn size="sm" tone="pri" onClick={() => onClosure(task.id, 'returned')}>退回</Btn> : null}
            {canAccept ? <Btn size="sm" tone="ok" onClick={() => onClosure(task.id, 'accepted')}>通过</Btn> : null}
            {canClose ? <Btn size="sm" tone="ok" onClick={() => onClosure(task.id, 'closed')}>收束</Btn> : null}
            {!canReturn && !canAccept && !canClose ? <span className="sany-small sany-muted">暂无可处理的提交</span> : null}
          </div>
          <div className="sany-tw">
            <table>
              <thead>
                <tr>
                  <th>操作</th>
                  <th>意见</th>
                  <th style={{ width: 96 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {workflow.closures.length === 0 ? (
                  <tr><td colSpan={3} className="sany-small sany-muted">暂无收束操作</td></tr>
                ) : workflow.closures.map(closure => (
                  <tr key={closure.id}>
                    <td><Tag tone={closure.action === 'returned' ? 'r' : closure.action === 'accepted' || closure.action === 'closed' ? 'g' : 'v'}>{CLOSURE_LABEL[closure.action] ?? closure.action}</Tag></td>
                    <td className="sany-small">{closure.note || '—'}</td>
                    <td className="sany-small">{closure.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <Section title="事件流水" sub="任务状态变更全程留痕">
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: 120 }}>事件</th>
                <th style={{ width: 120 }}>状态变化</th>
                <th>操作人 / 说明</th>
                <th style={{ width: 140 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {workflow.events.map(event => (
                <tr key={event.id}>
                  <td><Tag tone="line">{EVENT_LABEL[event.eventType] ?? event.eventType}</Tag></td>
                  <td className="sany-small">{event.fromStatus ?? '—'} → {event.toStatus ?? '—'}</td>
                  <td className="sany-small">{event.actor}{event.detail.submissionNo ? ` · 第 ${event.detail.submissionNo} 次提交` : ''}{event.detail.note ? ` · ${event.detail.note}` : ''}</td>
                  <td className="sany-small">{event.createdAt.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
