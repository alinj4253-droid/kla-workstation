import { PageHead, Card, Tag, Btn, StatusTag, Pbar, Section, Alert } from '../ui';
import { useSanyData } from '../SanyDataContext';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function AdminTrackPage({ onNavigate }: Props): React.JSX.Element {
  const { data } = useSanyData();
  const tasks = data.tasks;
  const totalPrefill = tasks.reduce((sum, req) => sum + req.prefill, 0);
  const totalVerified = tasks.reduce((sum, req) => sum + req.verified, 0);
  const totalGaps = tasks.reduce((sum, req) => sum + req.gaps, 0);
  const coverage = totalPrefill ? Math.round(totalVerified / totalPrefill * 100) : 0;
  const gapRows = data.fields
    .filter(field => field.scope === 'unit' && field.status === 'missing' && !field.removed)
    .map(field => ({
      unit: tasks.find(task => task.id === field.taskId)?.unit ?? '—',
      field: field.n,
      need: field.gap ?? '相关材料不足',
    }));

  return (
    <section className="sany-page">
      <PageHead
        title="任务收束"
        sub="按单元查看材料齐备度、内容生成与校验进度，缺什么一目了然"
        actions={(
          <>
            <Btn>批量提醒</Btn>
            <Btn tone="pri" onClick={() => onNavigate?.('review')}>进入汇总审阅</Btn>
          </>
        )}
      />

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
        </div>
      </Card>

      <Section title="按责任单元收束">
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
                <div className="sany-row sany-gap12">
                  <div className="sany-grow"><Pbar value={pct} tone={pct >= 100 ? 'ok' : pct < 40 ? 'warn' : undefined} /></div>
                  <span className="sany-mono sany-small sany-strong">{pct}%</span>
                  <Btn size="sm" onClick={() => onNavigate?.('review')}>明细</Btn>
                  <Btn size="sm">提醒</Btn>
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
    </section>
  );
}
