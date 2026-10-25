import { PageHead, Card, Tag, Btn, Section, Pbar, StatusTag, Alert } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { OWNER_DECKS } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function OwnerHomePage({ onNavigate }: Props): React.JSX.Element {
  const { data, ownerTask, ownerTasks, setOwnerTaskId } = useSanyData();
  const req = ownerTask;
  const fields = data.fields.filter(field => field.scope === 'unit' && !field.removed && field.taskId === (ownerTask?.id ?? ''));
  const confirmed = fields.filter(field => field.status === 'accepted' || field.status === 'edited' || field.status === 'rejected').length;
  const pending = fields.filter(field => field.status === 'pending').length;
  const lowConf = fields.filter(field => field.status === 'pending' && field.conf > 0 && field.conf < 85);
  const total = fields.length;
  const pct = total ? Math.round(confirmed / total * 100) : 0;
  const docs = data.documents.filter(document => document.scope === 'unit' && document.taskId === (ownerTask?.id ?? null)).length;
  const daysLeft = data.project.deadline
    ? Math.max(0, Math.ceil((new Date(data.project.deadline).getTime() - Date.now()) / 86400000))
    : null;
  const latest = data.outputs[0]?.versions[data.outputs[0]?.versions.length - 1];

  if (!req) {
    return (
      <section className="sany-page">
        <PageHead title="工作台" sub="尚未收到规划任务" />
        <Card className="sany-card--pad sany-center">
          <div className="sany-empty">
            <div className="sany-empty__t">暂无任务</div>
            <div className="sany-empty__s">管理员派发任务后，这里会出现你的规划任务与截止时间</div>
          </div>
        </Card>
      </section>
    );
  }

  const milestones = [
    { n: '材料上传', d: `${docs} 份`, state: docs ? 'done' : 'cur' },
    { n: '内容生成', d: `${total} / ${total} 项`, state: total ? 'done' : '' },
    { n: '内容校验', d: `${confirmed} / ${total} 确认`, state: 'cur' },
    { n: '交付包', d: latest ? `V${latest.v} ${latest.status}` : '待生成', state: '' },
    { n: '管理员审阅', d: latest?.status === '已归档' ? '已归档' : '待提交', state: '' },
  ];

  const board = [
    {
      title: '待上传', tone: 'warn', items: [
        { t: '内部诊断材料', s: '用于补齐「内部瓶颈与突破机会」', meta: '缺口 · 阻断', to: 'docs' as SanyView },
        { t: '对标企业指标数据', s: '用于「对标对象与差距」', meta: '缺口 · 阻断', to: 'docs' as SanyView },
      ],
    },
    {
      title: '分析中', tone: 'violet', items: [
        { t: `${docs} 份材料已解析`, s: '解析结果已进入四模块初稿，可继续补充材料', meta: '自动解析', to: 'docs' as SanyView },
      ],
    },
    {
      title: '待校验', tone: 'brand', items: [
        { t: `${pending} 项生成内容待确认`, s: '按经营回顾 / 市场洞察 / 业务澄清 / 三一规划分模块校验', meta: '按模块校验', to: 'prefill' as SanyView },
        { t: `${lowConf.length} 项依据充分度偏低`, s: lowConf.slice(0, 2).map(field => `${field.n} ${field.conf}%`).join('、') || '暂无低置信项', meta: '建议核对原文', to: 'prefill' as SanyView },
      ],
    },
    {
      title: '已提交', tone: 'ok', items: [
        { t: latest ? `提交包 V${latest.v}` : '尚未提交', s: latest ? `${latest.at} · ${latest.status}` : '完成校验后生成提交包', meta: latest ? '正文 + 诊断 + 材料' : '待提交', to: 'output' as SanyView },
        { t: '规划正文', s: latest ? `${latest.file} · ${latest.status}` : '待生成', meta: latest ? latest.size : '—', to: 'output' as SanyView },
      ],
    },
  ];

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
        title="工作台"
        sub={`${req.title} · 截止 ${req.deadline}${daysLeft === null ? '' : `（还有 ${daysLeft} 天）`}`}
        actions={(
          <>
            <Btn onClick={() => onNavigate?.('docs')}>上传材料</Btn>
            <Btn tone="pri" onClick={() => onNavigate?.('prefill')}>继续校验</Btn>
          </>
        )}
      />

      <Card className="sany-card--pad sany-mb16">
        <div className="sany-miles">
          {milestones.map((item, index) => (
            <div className={`sany-mile ${item.state}`} key={item.n}>
              <span className="sany-mile__d">{item.state === 'done' ? '✓' : index + 1}</span>
              <div>
                <div className="sany-mile__t">{item.n}</div>
                <div className="sany-mile__s">{item.d}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="sany-hr" />
        <div className="sany-row sany-gap12">
          <div className="sany-grow">
            <div className="sany-row sany-mb4">
              <span className="sany-small">内容确认进度</span>
              <span className="sany-spacer" />
              <span className="sany-small sany-mono"><b className="sany-ink">{confirmed}</b> / {total} 项</span>
            </div>
            <Pbar value={pct} tone={pct < 50 ? 'warn' : undefined} />
          </div>
          <div className="sany-vline" />
          <div className="sany-row sany-gap16">
            <div>
              <div className="sany-small">材料</div>
              <div className="sany-strong">{docs} 份</div>
            </div>
            <div>
              <div className="sany-small">缺口</div>
              <div className="sany-strong sany-warn">{req.gaps} 项</div>
            </div>
            <div>
              <div className="sany-small">状态</div>
              <div><StatusTag status={req.status} /></div>
            </div>
          </div>
        </div>
      </Card>

      <Section title="我的看板" sub="从材料到提交的每一步都在这里，卡片可直接点开处理">
        <div className="sany-board">
          {board.map(column => (
            <div className="sany-board__col" key={column.title}>
              <div className="sany-board__h">
                <span className={`sany-dot ${column.tone}`} />
                <b>{column.title}</b>
                <span className="sany-small">{column.items.length}</span>
              </div>
              {column.items.map(item => (
                <Card className="sany-board__card" key={item.t} onClick={() => onNavigate?.(item.to)}>
                  <div className="sany-strong sany-mb4">{item.t}</div>
                  <div className="sany-small sany-mb8">{item.s}</div>
                  <Tag tone="line">{item.meta}</Tag>
                </Card>
              ))}
              <button
                type="button"
                className="sany-board__add"
                onClick={() => onNavigate?.(column.title === '待上传' ? 'docs' : column.title === '待校验' ? 'prefill' : 'output')}
              >
                ＋ 查看全部
              </button>
            </div>
          ))}
        </div>
      </Section>

      <div className="sany-grid g2 sany-align-start">
        <Section title="我的任务" style={{ marginBottom: 0 }}>
          <Card className="sany-card--pad">
            <div className="sany-row sany-mb8">
              <Tag tone="v">{req.type} {req.typeName}</Tag>
              <span className="sany-spacer" />
              <span className="sany-small">派发：{req.assignedAt}</span>
            </div>
            <div className="sany-strong sany-mb8">{req.title}</div>
            <div className="sany-small sany-mb8"><b>规划意图</b> {req.intent}</div>
            <div className="sany-small sany-mb8"><b>下发要求</b> {req.requirements.join('；')}</div>
            {(() => {
              const note = data.assignments.find(assignment => assignment.taskId === req.id)?.individualNote;
              return note ? <div className="sany-small sany-mb8"><b>个别要求（仅你可见）</b> {note}</div> : null;
            })()}
            <div className="sany-hr" />
            <div className="sany-row">
              <span className="sany-small">截止 {req.deadline}{daysLeft === null ? '' : ` · 还剩 ${daysLeft} 天`}</span>
              <span className="sany-spacer" />
              <Btn size="sm" onClick={() => onNavigate?.('docs')}>查看任务书</Btn>
            </div>
          </Card>
        </Section>

        <Section title="交付物" sub={`${OWNER_DECKS.length} 页汇报 PPT · 正文 · 诊断 · 提交包`} style={{ marginBottom: 0 }}>
          <Card className="sany-card--pad">
            <div className="sany-row sany-mb8">
              <b className="sany-grow">单元汇报 PPT</b>
              <span className="sany-small">{latest ? `V${latest.v} ${latest.status}` : '待生成'}</span>
            </div>
            <Pbar value={pct} tone="vio" />
            <div className="sany-small sany-mt8">
              {req.gaps ? `${req.gaps} 项缺口待补齐，补齐后重新生成。` : '缺口已处理完毕，可生成并提交成果。'}
            </div>
            <div className="sany-hr" />
            <Btn block onClick={() => onNavigate?.('output')}>查看产出物与版本链</Btn>
          </Card>
          <div className="sany-mt12">
            <Alert icon="i">材料、校验记录、产出物版本会一并留存；管理员看到的是你提交的那一版，不是草稿。</Alert>
          </div>
        </Section>
      </div>
    </section>
  );
}
