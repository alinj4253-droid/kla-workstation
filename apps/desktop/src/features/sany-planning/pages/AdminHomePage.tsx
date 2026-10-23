import { PageHead, Kpi, KpiGrid, Section, Card, Tag, StatusTag, Pbar, Btn, Alert } from '../ui';
import { useSanyData } from '../SanyDataContext';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function AdminHomePage({ onNavigate }: Props): React.JSX.Element {
  const { data } = useSanyData();
  const project = data.project;
  const owners = data.members.filter(member => member.role === 'owner');
  const submitted = data.tasks.filter(task => task.status === '已提交' || task.status === '校验中').length;
  const totalPrefill = data.tasks.reduce((sum, task) => sum + task.prefill, 0);
  const totalVerified = data.tasks.reduce((sum, task) => sum + task.verified, 0);
  const totalGaps = data.tasks.reduce((sum, task) => sum + task.gaps, 0);
  const companyDocs = data.documents.filter(document => document.scope === 'company').length;
  const daysLeft = project.deadline
    ? Math.max(0, Math.ceil((new Date(project.deadline).getTime() - Date.now()) / 86400000))
    : null;
  const joinedAt = data.members[0]?.joined ?? '—';

  return (
    <section className="sany-page">
      <PageHead
        title="工作台"
        sub={`${project.orgName} · ${project.planningPeriod} 战略规划${daysLeft === null ? '' : ` · 距截止 ${daysLeft} 天`}`}
        actions={(
          <>
            <Btn onClick={() => onNavigate?.('org')}>邀请负责人</Btn>
            <Btn tone="pri" onClick={() => onNavigate?.('assign')}>＋ 派发任务</Btn>
          </>
        )}
      />

      <KpiGrid className="g4">
        <Kpi label="已加入负责人" value={owners.length} sub={`覆盖 ${owners.length} 个责任单元`} />
        <Kpi label="已生成内容" value={totalPrefill} sub={`已人工确认 ${totalVerified} 项`} />
        <Kpi label="待补材料" value={totalGaps} tone="warn" sub={`影响 ${totalGaps} 个字段无法填充`} />
        <Kpi label="已收束" value={submitted} extra={`/${data.tasks.length}`} tone="ok" sub="校验完成并提交" />
      </KpiGrid>

      <Section
        title="任务收束概览"
        action={<button type="button" className="sany-link" onClick={() => onNavigate?.('track')}>查看全部 →</button>}
      >
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: '28%' }}>任务 / 责任单元</th>
                <th style={{ width: 82 }}>类型</th>
                <th style={{ width: 86 }}>负责人</th>
                <th style={{ width: 80 }}>材料</th>
                <th style={{ width: 150 }}>已生成 → 已确认</th>
                <th style={{ width: 80 }}>缺口</th>
                <th style={{ width: 100 }}>状态</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {data.tasks.map(req => (
                <tr key={req.id}>
                  <td>
                    <div className="sany-td__main">{req.unit}</div>
                    <div className="sany-small sany-td__sub">{req.id} · 截止 {req.deadline.slice(5)}</div>
                  </td>
                  <td><Tag tone="v">{req.type}</Tag></td>
                  <td className="sany-small">{req.owner}</td>
                  <td className="sany-small sany-mono">{req.docs} 份</td>
                  <td>
                    <div className="sany-row">
                      <span className="sany-mono sany-small sany-ink">{req.prefill}</span>
                      <span className="sany-small">→</span>
                      <span className="sany-mono sany-small sany-ok">{req.verified}</span>
                      <div className="sany-grow"><Pbar value={req.prefill ? req.verified / req.prefill * 100 : 0} tone="vio" /></div>
                    </div>
                  </td>
                  <td>{req.gaps ? <Tag tone="w">{req.gaps}</Tag> : <span className="sany-small">—</span>}</td>
                  <td><StatusTag status={req.status} /></td>
                  <td>
                    <button type="button" className="sany-link" onClick={() => onNavigate?.('track')}>详情</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="sany-grid g2">
        <Section title="需要我处理" style={{ marginBottom: 0 }}>
          <Card className="sany-card--pad">
            <div className="sany-todo">
              <Tag tone="v" dot>公司层</Tag>
              <div className="sany-grow">
                <div className="sany-todo__t">公司层内容已生成 20 项</div>
                <div className="sany-todo__s">已确认 2 项，待确认 15 项</div>
              </div>
              <Btn size="sm" onClick={() => onNavigate?.('company')}>继续填报</Btn>
              <Btn size="sm" tone="pri" onClick={() => onNavigate?.('verify')}>去校验</Btn>
            </div>
            <div className="sany-todo">
              <Tag tone="w" dot>催办</Tag>
              <div className="sany-grow">
                <div className="sany-todo__t">研发中台、供应链中心尚未上传材料</div>
                <div className="sany-todo__s">距截止 28 天，建议本周内提醒</div>
              </div>
              <Btn size="sm" onClick={() => onNavigate?.('track')}>提醒</Btn>
            </div>
            <div className="sany-todo">
              <Tag tone="b" dot>待合并</Tag>
              <div className="sany-grow">
                <div className="sany-todo__t">2 个单元已提交，可开始合并校验</div>
                <div className="sany-todo__s">需比对集团口径与单元加总，2 项阻断待裁定</div>
              </div>
              <Btn size="sm" tone="pri" onClick={() => onNavigate?.('review')}>合并</Btn>
            </div>
            <div className="sany-todo sany-todo--last">
              <Tag tone="v" dot>提示</Tag>
              <div className="sany-grow">
                <div className="sany-todo__t">单元申报目标合计超集团预算框 0.7 亿元</div>
                <div className="sany-todo__s">需集团层面裁定，或回落各单元目标</div>
              </div>
              <Btn size="sm" onClick={() => onNavigate?.('review')}>标记</Btn>
            </div>
          </Card>
        </Section>

        <Section title="协同链路" style={{ marginBottom: 0 }}>
          <Card className="sany-card--pad">
            <div className="sany-flow">
              <div className="sany-fl done">
                <span className="sany-fl__d">✓</span>
                <div className="sany-fl__b">
                  <div className="sany-fl__t">创建组织并引入成员</div>
                  <div className="sany-fl__s">{joinedAt} · 组织架构同步</div>
                </div>
              </div>
              <div className="sany-fl done">
                <span className="sany-fl__d">✓</span>
                <div className="sany-fl__b">
                  <div className="sany-fl__t">{owners.length} 位负责人已加入</div>
                  <div className="sany-fl__s">已建立派发与管理权限</div>
                </div>
              </div>
              <div className="sany-fl done sany-fl--click" onClick={() => onNavigate?.('company')}>
                <span className="sany-fl__d">✓</span>
                <div className="sany-fl__b">
                  <div className="sany-fl__t">派发任务 + 自己准备公司层内容</div>
                  <div className="sany-fl__s">{data.tasks.length} 个单元收到任务，集团材料 {companyDocs} 份</div>
                </div>
              </div>
              <div className="sany-fl cur sany-fl--click" onClick={() => onNavigate?.('verify')}>
                <span className="sany-fl__d">4</span>
                <div className="sany-fl__b">
                  <div className="sany-fl__t">双方各自校验（单元 + 公司层）</div>
                  <div className="sany-fl__s">单元 {totalVerified} 项已确认 · 公司层 2 项已确认 · <b>去校验 →</b></div>
                </div>
              </div>
              <div className="sany-fl">
                <span className="sany-fl__d">5</span>
                <div className="sany-fl__b">
                  <div className="sany-fl__t">合并汇总 · 生成公司级成果</div>
                  <div className="sany-fl__s">口径对齐、冲突裁定后形成汇报产出</div>
                </div>
              </div>
            </div>
          </Card>
          <div className="sany-mt12">
            <Alert tone="w" icon="!">
              <b>公司层与单元同时推进</b> 公司层内容由管理员自己准备，与单元提交在汇总时交叉校验，口径不一致会自动标出。
            </Alert>
          </div>
        </Section>
      </div>
    </section>
  );
}
