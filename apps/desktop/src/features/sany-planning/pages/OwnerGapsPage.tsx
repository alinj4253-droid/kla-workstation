import { useState } from 'react';
import { PageHead, Card, Tag, Btn, Section, Alert, Kpi, KpiGrid, Modal } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { DIAG_FINDINGS, type ModuleKey } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

const MODULE_NAME: Record<ModuleKey, string> = {
  review: '经营回顾',
  market: '市场洞察',
  biz: '业务澄清',
  plan: '三一规划',
};

export function OwnerGapsPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions, ownerTask, ownerTasks, setOwnerTaskId } = useSanyData();
  const [feedback, setFeedback] = useState('');
  const [sent, setSent] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const unitFields = data.fields.filter(field => field.scope === 'unit' && !field.removed && field.taskId === (ownerTask?.id ?? ''));
  const missingFields = unitFields.filter(field => field.status === 'missing');
  const lowFields = unitFields.filter(field => field.status === 'pending' && field.conf > 0 && field.conf < 85);
  const confirmed = unitFields.filter(field => field.status === 'accepted' || field.status === 'edited' || field.status === 'rejected').length;

  const missingRows = missingFields.map(field => ({
    id: field.id,
    n: field.n,
    mod: MODULE_NAME[field.moduleKey],
    need: field.gap ?? '相关材料不足',
    impact: `${MODULE_NAME[field.moduleKey]}模块无法收口`,
  }));
  const lowConfRows = lowFields.map(field => ({
    id: field.id,
    n: field.n,
    mod: MODULE_NAME[field.moduleKey],
    conf: field.conf,
    note: field.src || '依据充分度偏低，建议核对原文',
  }));

  const submitFeedback = () => {
    const content = feedback.trim();
    if (!content) return;
    void actions.addFeedback(content);
    setFeedback('');
    setSent(true);
  };

  return (
    <section className="sany-page">
      {ownerTasks.length > 1 ? (
        <div className="sany-taskbar">
          <span className="sany-taskbar__l">当前任务</span>
          <select className="sany-sel sany-taskbar__grow" value={ownerTask?.id ?? ''} onChange={event => setOwnerTaskId(event.target.value)}>
            {ownerTasks.map(item => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>)}
          </select>
          <span className="sany-taskbar__t">{ownerTask?.unit}</span>
        </div>
      ) : null}
      <PageHead
        title="缺口处理"
        sub="缺什么、为什么缺、影响哪些内容，一条条列出；补不齐的可以反馈给管理员"
        actions={(
          <>
            <Btn onClick={() => onNavigate?.('docs')}>补充材料</Btn>
            <Btn tone="pri" onClick={() => setConfirmOpen(true)}>提交前检查</Btn>
          </>
        )}
      />

      <KpiGrid className="g4">
        <Kpi label="阻断缺口" value={missingFields.length} tone="danger" sub="不补齐不能提交" />
        <Kpi label="提醒项" value={lowFields.length} tone="warn" sub="依据偏弱或口径待核" />
        <Kpi label="低置信字段" value={lowFields.filter(field => field.conf < 75).length} tone="warn" sub="充分度低于 75%" />
        <Kpi label="已确认内容" value={`${confirmed} / ${unitFields.length}`} tone="ok" sub="其余待校验" />
      </KpiGrid>

      <div className="sany-grid g2 sany-align-start">
        <Section title="缺材料清单" sub="系统判断为材料不足，不是你没填" style={{ marginBottom: 0 }}>
          <div className="sany-stack">
            {missingRows.length ? missingRows.map(item => (
              <Card className="sany-card--pad" key={item.id}>
                <div className="sany-row sany-mb8">
                  <Tag tone="r">阻断</Tag>
                  <b className="sany-grow">{item.n}</b>
                  <span className="sany-small">{item.mod}</span>
                </div>
                <div className="sany-small sany-mb4"><b>需要材料</b> {item.need}</div>
                <div className="sany-small sany-mb8"><b>影响</b> {item.impact}</div>
                <div className="sany-row">
                  <Btn size="sm" onClick={() => onNavigate?.('docs')}>去补材料</Btn>
                  <Btn size="sm" onClick={() => onNavigate?.('prefill')}>手工填写</Btn>
                </div>
              </Card>
            )) : (
              <Card className="sany-card--pad sany-center">
                <div className="sany-empty">
                  <div className="sany-empty__t">没有阻断缺口</div>
                  <div className="sany-empty__s">所有字段都有材料依据，可以进入提交前检查</div>
                </div>
              </Card>
            )}
          </div>
        </Section>

        <div>
          <Section title="低依据字段" sub="不是错误，但建议核对原文后再确认" style={{ marginBottom: 0 }}>
            <div className="sany-tw">
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th style={{ width: 70 }}>模块</th>
                    <th style={{ width: 90 }}>依据</th>
                    <th style={{ width: 52 }} />
                  </tr>
                </thead>
                <tbody>
                  {lowConfRows.length ? lowConfRows.map(row => (
                    <tr key={row.id}>
                      <td>
                        <div className="sany-td__main">{row.n}</div>
                        <div className="sany-small">{row.note}</div>
                      </td>
                      <td className="sany-small">{row.mod}</td>
                      <td>
                        <Tag tone={row.conf < 75 ? 'w' : 'g'}>{row.conf}%</Tag>
                      </td>
                      <td>
                        <button type="button" className="sany-link" onClick={() => onNavigate?.('prefill')}>核对</button>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} className="sany-small sany-muted">暂无低依据字段</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Section>

          <div className="sany-mt16">
            <Section title="内容诊断" sub="交付前自检结果" style={{ marginBottom: 0 }}>
              <Card className="sany-card--tight">
                {DIAG_FINDINGS.slice(0, 5).map(item => (
                  <div className="sany-diag" key={`${item.mod}-${item.t}`}>
                    <Tag tone={item.lv === 'block' ? 'r' : 'w'}>{item.lv === 'block' ? '阻断' : '提醒'}</Tag>
                    <div className="sany-grow">
                      <div className="sany-strong">{item.t}</div>
                      <div className="sany-small">{item.d}</div>
                    </div>
                    <span className="sany-small sany-muted">{item.mod}</span>
                  </div>
                ))}
              </Card>
              <div className="sany-mt8 sany-small">
                完整诊断报告共 {DIAG_FINDINGS.length} 项，提交时自动附在提交包里。
                <button type="button" className="sany-link" onClick={() => onNavigate?.('output')}>查看报告</button>
              </div>
            </Section>
          </div>
        </div>
      </div>

      <Section title="反馈给管理员" sub={data.feedback.length ? `已收到 ${data.feedback.length} 条反馈` : '材料确实拿不到、或字段不适用于本单元时，在这里说明'}>
        <Card className="sany-card--pad">
          {sent ? (
            <Alert tone="g" icon="✓">已提交反馈。管理员会在合并时看到你的说明，并将对应字段标注为「未决」。</Alert>
          ) : (
            <>
              <div className="sany-fld">
                <label>说明</label>
                <textarea
                  rows={3}
                  value={feedback}
                  onChange={event => setFeedback(event.target.value)}
                  placeholder="例：对标企业的渠道结构数据属商业机密，无法获取；建议用行业均值替代，并在成果中注明。"
                />
              </div>
              <div className="sany-row">
                <span className="sany-small">反馈会附在提交包里，不替代材料要求</span>
                <span className="sany-spacer" />
                <Btn
                  tone="pri"
                  disabled={!feedback.trim()}
                  onClick={submitFeedback}
                >
                  提交反馈
                </Btn>
              </div>
            </>
          )}
        </Card>
      </Section>

      <Modal
        open={confirmOpen}
        title="提交前检查"
        sub="以下问题会在提交包中标注，管理员可见"
        onClose={() => setConfirmOpen(false)}
        footer={(
          <>
            <Btn onClick={() => setConfirmOpen(false)}>继续处理</Btn>
            <Btn tone="pri" onClick={() => { setConfirmOpen(false); onNavigate?.('output'); }}>提交并生成交付包</Btn>
          </>
        )}
      >
        {missingRows.length
          ? <Alert tone="w" icon="!">仍有 {missingRows.length} 项阻断缺口未处理。提交后管理员会看到这些未决项。</Alert>
          : <Alert tone="g" icon="✓">没有阻断缺口，可以提交。</Alert>}
        <div className="sany-mt12">
          {missingRows.map(item => (
            <div className="sany-bullet" key={item.id}><span>·</span><span>{item.mod}：{item.n}（{item.impact}）</span></div>
          ))}
        </div>
      </Modal>
    </section>
  );
}
