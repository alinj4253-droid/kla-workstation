import { useState } from 'react';
import { PageHead, Card, Tag, Btn, Section, Alert, Kpi, KpiGrid } from '../ui';
import { useSanyData } from '../SanyDataContext';
import type { IssueLevel } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

const MODULE_ROWS = [
  { n: '经营回顾', company: '已确认 2 项 · 集团口径', home: '已确认 2 项 · 基线 186,000', plat: '已确认 2 项 · 基线 64,000', conflict: '基线口径差异 3.7%（ISS-02）' },
  { n: '市场洞察', company: '已确认 2 项 · 可及市场 1,240 亿', home: '已确认 1 项 · 增速 11.8%', plat: '已确认 1 项 · 增速 21.3%', conflict: '两个增速口径不同（细分市场）' },
  { n: '业务澄清', company: '已确认 1 项 · 组合定位', home: '已确认 3 项 · 客群与价值', plat: '已确认 2 项 · 平台能力', conflict: '—' },
  { n: '三一规划', company: '已确认 2 项 · 集团目标 356,000', home: '已确认 1 项 · 2029 目标 292,000', plat: '已确认 1 项 · 2029 目标 64,000', conflict: '目标加总偏差 14,000 万元（ISS-01）' },
];

export function AdminReviewPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions } = useSanyData();
  const [tab, setTab] = useState<'all' | IssueLevel>('all');
  const [dec1, setDec1] = useState(data.project.decisions.dec1 ?? 'b');
  const [dec2, setDec2] = useState(data.project.decisions.dec2 ?? 'a');
  const [conclusion, setConclusion] = useState(data.project.conclusion);

  const issues = data.issues.map(issue => ({
    id: issue.id,
    lv: issue.level as IssueLevel,
    t: issue.title,
    d: issue.detail,
    o: issue.owner,
    st: issue.status,
  }));
  const filtered = issues.filter(issue => tab === 'all' || issue.lv === tab);
  const countBy = (level: IssueLevel) => issues.filter(issue => issue.lv === level).length;
  const blocking = countBy('阻断');
  const pending = issues.filter(issue => issue.st === '待裁定').length;
  const submittedUnits = data.tasks.filter(task => task.status === '已提交' || task.status === '校验中' || task.status === '已通过').length;
  const merged = data.fields.filter(field => field.scope === 'unit' && !field.removed && (field.status === 'accepted' || field.status === 'edited')).length;

  const saveAndGenerate = () => {
    void actions.patchProject({
      decisions: { ...data.project.decisions, dec1, dec2 },
      conclusion,
      outputGenerated: true,
    });
    onNavigate?.('output');
  };

  return (
    <section className="sany-page">
      <PageHead
        title="汇总合并"
        sub="公司层内容与单元提交合并为一份集团规划：先对齐口径，再裁定冲突，最后确认结论"
        actions={<Btn tone="pri" disabled={blocking > 0} onClick={() => onNavigate?.('output')}>生成公司级成果</Btn>}
      />

      <KpiGrid className="g4">
        <Kpi label="合并来源" value={submittedUnits} extra=" 个单元 + 公司层" sub={`已提交 ${submittedUnits} / 应提交 ${data.tasks.length + 1}`} />
        <Kpi label="阻断冲突" value={blocking} tone="danger" sub="未裁定前不能放行" />
        <Kpi label="待决策事项" value={pending} tone="warn" sub="需管理员逐项裁定" />
        <Kpi label="合并内容" value={merged} extra=" 项" tone="ok" sub="已确认、去重后进入集团正文" />
      </KpiGrid>

      <Section title="合并来源" sub="哪些内容进入合并，哪些单元还没交">
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: '22%' }}>来源</th>
                <th style={{ width: '16%' }}>范围</th>
                <th style={{ width: 120 }}>已确认内容</th>
                <th style={{ width: 120 }}>材料</th>
                <th style={{ width: 120 }}>状态</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="sany-strong">集团（公司层）</td>
                <td className="sany-small">集团口径</td>
                <td className="sany-mono">2 / 20 项</td>
                <td className="sany-mono">6 份</td>
                <td><Tag tone="g" dot>可合并</Tag></td>
                <td className="sany-small">校验尚未完成，仅已确认内容参与合并</td>
              </tr>
              <tr>
                <td className="sany-strong">智能家居业务单元</td>
                <td className="sany-small">成长型业务</td>
                <td className="sany-mono">3 / 21 项</td>
                <td className="sany-mono">4 份</td>
                <td><Tag tone="g" dot>已提交</Tag></td>
                <td className="sany-small">提交包 V2 待审核，正文 V2 已归档</td>
              </tr>
              <tr>
                <td className="sany-strong">物联平台业务单元</td>
                <td className="sany-small">培育型业务</td>
                <td className="sany-mono">2 / 18 项</td>
                <td className="sany-mono">2 份</td>
                <td><Tag tone="w" dot>未提交</Tag></td>
                <td className="sany-small">材料解析中，暂不进入合并</td>
              </tr>
              <tr>
                <td className="sany-strong">研发中台 / 供应链中心</td>
                <td className="sany-small">职能</td>
                <td className="sany-mono">0 项</td>
                <td className="sany-mono">0 份</td>
                <td><Tag tone="r" dot>缺报</Tag></td>
                <td className="sany-small">未上传材料，汇总时标注缺报，不估算</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="合并视图" sub="四模块按来源并排对照，冲突处标出，由你裁定">
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: 96 }}>模块</th>
                <th style={{ width: '21%' }}>集团（公司层）</th>
                <th style={{ width: '21%' }}>智能家居</th>
                <th style={{ width: '21%' }}>物联平台</th>
                <th>交叉校验</th>
              </tr>
            </thead>
            <tbody>
              {MODULE_ROWS.map(row => (
                <tr key={row.n}>
                  <td className="sany-strong">{row.n}</td>
                  <td className="sany-small">{row.company}</td>
                  <td className="sany-small">{row.home}</td>
                  <td className="sany-small">{row.plat}</td>
                  <td>
                    {row.conflict === '—'
                      ? <span className="sany-small sany-muted">一致</span>
                      : <span className="sany-conflict"><Tag tone="r">冲突</Tag><span className="sany-small">{row.conflict}</span></span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="冲突与缺口" sub={`${issues.length} 项，阻断项必须处理完才能放行`}>
        <div className="sany-tabs">
          {([['all', `全部 ${issues.length}`], ['阻断', `阻断 ${countBy('阻断')}`], ['重要', `重要 ${countBy('重要')}`], ['一般', `一般 ${countBy('一般')}`]] as const).map(([key, label]) => (
            <button type="button" key={key} className={`sany-tab ${tab === key ? 'on' : ''}`} onClick={() => setTab(key as 'all' | IssueLevel)}>
              {label}
            </button>
          ))}
        </div>
        <div className="sany-issues">
          {filtered.map(issue => (
            <div className={`sany-issue lv-${issue.lv}`} key={issue.id}>
              <div className="sany-issue__h">
                <Tag tone={issue.lv === '阻断' ? 'r' : issue.lv === '重要' ? 'w' : 'line'}>{issue.lv}</Tag>
                <b className="sany-grow">{issue.t}</b>
                <span className="sany-small">{issue.id}</span>
                <Tag tone={issue.st === '待裁定' ? 'r' : 'w'}>{issue.st}</Tag>
              </div>
              <div className="sany-small sany-issue__d">{issue.d}</div>
              <div className="sany-row sany-small sany-issue__f">
                <span>责任人：{issue.o}</span>
                <span className="sany-spacer" />
                <button type="button" className="sany-link">指派处理</button>
                <button type="button" className="sany-link" onClick={() => void actions.patchIssue(issue.id, '已解决')}>标记已解决</button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <div className="sany-grid g2 sany-align-start">
        <Section title="需要裁定的问题" sub="裁完才能生成公司级成果" style={{ marginBottom: 0 }}>
          <Card className="sany-card--pad">
            <div className="sany-strong sany-mb4">D-01 合并目标口径</div>
            <div className="sany-small sany-mb8">单元申报加总 356,000 万元，集团财务框 342,000 万元。</div>
            {[
              ['a', '采用集团财务框 342,000 万元，回落各单元目标'],
              ['b', '采用单元加总 356,000 万元，上报董事会调整预算'],
              ['c', '先不定，在成果里标注未决并附两种口径'],
            ].map(([value, label]) => (
              <label className="sany-radio" key={value}>
                <input type="radio" name="dec1" checked={dec1 === value} onChange={() => setDec1(value)} />
                <span>{label}</span>
              </label>
            ))}
            <div className="sany-hr" />
            <div className="sany-strong sany-mb4">D-02 培育型业务考核方式</div>
            <div className="sany-small sany-mb8">物联平台仍处投入期，用收入考核可能误导投入节奏。</div>
            {[
              ['a', '改用里程碑 + 客户数考核，收入只作参考'],
              ['b', '维持统一收入考核，避免口径复杂'],
            ].map(([value, label]) => (
              <label className="sany-radio" key={value}>
                <input type="radio" name="dec2" checked={dec2 === value} onChange={() => setDec2(value)} />
                <span>{label}</span>
              </label>
            ))}
          </Card>
        </Section>

        <Section title="合并结论" sub="写清本次合并的判断与未决事项" style={{ marginBottom: 0 }}>
          <Card className="sany-card--pad">
            <div className="sany-fld">
              <label>管理员结论</label>
              <textarea
                rows={5}
                value={conclusion}
                onChange={event => setConclusion(event.target.value)}
                placeholder="例：双引擎格局成立，但物联平台需在 2027 年前验证单位经济模型；集团目标按财务框执行，单元目标回落方案另行下发。"
              />
            </div>
            {blocking ? <Alert tone="w" icon="!">仍有 {blocking} 项阻断冲突未裁定，生成成果后这些冲突会以「未决」标注在成果里，不能直接放行。</Alert> : <Alert icon="✓">阻断冲突已全部处理，可以生成成果。</Alert>}
            <div className="sany-row sany-mt12">
              <Btn onClick={() => onNavigate?.('track')}>回到收束</Btn>
              <span className="sany-spacer" />
              <Btn tone="pri" onClick={saveAndGenerate}>保存并生成成果</Btn>
            </div>
          </Card>
          <div className="sany-mt12">
            <Card className="sany-card--pad sany-card--soft">
              <div className="sany-strong sany-mb8">放行前还差什么</div>
              {[
                ['已完成', '四模块合并视图'],
                ['已完成', '口径差异自动标出'],
                [blocking ? '待完成' : '已完成', `${blocking} 项阻断冲突裁定`],
                ['待完成', '确认已收束单元清单'],
              ].map(([state, label]) => (
                <div className="sany-checkrow" key={label}>
                  <span className={state === '已完成' ? 'sany-ok' : 'sany-muted'}>{state === '已完成' ? '✓' : '○'}</span>
                  <span>{label}</span>
                </div>
              ))}
            </Card>
          </div>
        </Section>
      </div>
    </section>
  );
}
