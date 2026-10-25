import { useState } from 'react';
import { PageHead, Card, Tag, Btn, Section, Alert, Kpi, KpiGrid, StatusTag } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { buildMergeSummary } from '../merge';
import type { IssueLevel } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function AdminReviewPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions } = useSanyData();
  const [tab, setTab] = useState<'all' | IssueLevel>('all');
  const [dec1, setDec1] = useState(data.project.decisions.dec1 ?? 'b');
  const [dec2, setDec2] = useState(data.project.decisions.dec2 ?? 'a');
  const [conclusion, setConclusion] = useState(data.project.conclusion);

  const summary = buildMergeSummary({
    fields: data.fields,
    tasks: data.tasks,
    companyDocs: data.documents.filter(document => document.scope === 'company').length,
  });

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
        sub="公司层内容 + 各单元提交 → 校验口径、裁定冲突 → 形成可汇报的公司级产出"
        actions={(
          <>
            <Btn>全部问题（{issues.length}）</Btn>
            <Btn tone="pri" disabled={blocking > 0} onClick={() => onNavigate?.('output')}>生成公司级成果</Btn>
          </>
        )}
      />

      <KpiGrid className="g4">
        <Kpi
          label="公司层内容"
          value={summary.companyVerified}
          extra={` / ${summary.companyTotal}`}
          tone={summary.companyReady ? undefined : 'warn'}
          sub={summary.companyReady ? '集团口径已确认项' : '尚未上传集团材料'}
        />
        <Kpi label="单元已收束" value={summary.unitClosed} extra={` / ${summary.unitTotal}`} sub="通过校验并提交" />
        <Kpi label="合并覆盖" value={`${summary.coverage}%`} tone="ok" sub="公司层 + 单元合计" />
        <Kpi label="待裁定" value={issues.length} tone="danger" sub={`阻断 ${blocking} 项`} />
      </KpiGrid>

      {!summary.companyReady ? (
        <div className="sany-mb16">
          <Alert tone="w" icon="!">
            <b>公司层内容尚未准备</b> 汇总合并需要两部分：你负责的集团层面内容，加上各单元提交。请先完成<b>公司层填报</b>。
            <button type="button" className="sany-link" onClick={() => onNavigate?.('company')}>去填报 →</button>
          </Alert>
        </div>
      ) : null}

      <Section title="合并来源" sub="公司级产出 = 集团自身内容 + 各业务单元与职能部门提交">
        <div className="sany-stack">
          {summary.sources.map(source => (
            <Card className="sany-card--pad" key={source.key} style={source.scope === 'company' ? { borderLeft: '2px solid var(--ink3)', background: 'var(--panel2)' } : undefined}>
              <div className="sany-row sany-mb8">
                <Tag tone={source.scope === 'company' ? 'v' : 'b'}>{source.scope === 'company' ? '公司层' : '单元'}</Tag>
                <b>{source.name}</b>
                {source.scope === 'unit' ? <Tag tone="line">{source.typeLabel}</Tag> : null}
                <span className="sany-spacer" />
                {source.scope === 'company'
                  ? <Tag tone={source.status === '可合并' ? 'g' : source.status === '未开始' ? 'w' : 'b'}>{source.status}</Tag>
                  : <StatusTag status={source.status} />}
              </div>
              <div className="sany-small sany-muted sany-mb8">{source.note}</div>
              <div className="sany-row sany-gap16">
                {source.scope === 'company' ? null : <span className="sany-small">{source.owner}</span>}
                <span className="sany-small">材料 {source.docs} 份</span>
                <span className="sany-small">已生成 <b className="sany-mono">{source.prefill}</b></span>
                <span className="sany-small">已确认 <b className="sany-mono sany-ok">{source.verified}</b></span>
                {source.gaps ? <Tag tone="w">缺 {source.gaps}</Tag> : null}
                <span className="sany-spacer" />
                {source.scope === 'company'
                  ? <Btn size="sm" onClick={() => onNavigate?.('company')}>{summary.companyReady ? '去校验' : '去填报'}</Btn>
                  : <Btn size="sm" onClick={() => onNavigate?.('track')}>明细</Btn>}
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="合并后的公司级视图" sub="系统按集团口径归并，标出加总与校验结果">
        <div className="sany-tw">
          <table>
            <thead>
              <tr>
                <th style={{ width: '22%' }}>维度</th>
                <th style={{ width: '15%' }}>公司层</th>
                <th style={{ width: '15%' }}>单元加总</th>
                <th style={{ width: '16%' }}>差异</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {summary.compare.map(row => (
                <tr key={row.name}>
                  <td className="sany-strong">{row.name}</td>
                  <td className="sany-mono sany-small">{row.companyValue}</td>
                  <td className="sany-mono sany-small">{row.unitSum}</td>
                  <td><Tag tone={row.diffTone}>{row.diffLabel}</Tag></td>
                  <td className="sany-small">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sany-mt12">
          <Alert icon="i">合并不是简单加总：<b>目标要对齐集团预算框、举措要向上归并、指标要去重收敛、口径要先统一</b>。差异未关闭前只能生成带标记的草稿。</Alert>
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
            <div className="sany-small sany-mb8">单元申报加总与集团财务预算框的差异，是本次规划最核心的取舍。</div>
            {[
              ['a', '采用集团财务框，回落各单元目标'],
              ['b', '采用单元加总，上报董事会调整预算'],
              ['c', '分档设定：保底与挑战并存'],
            ].map(([value, label]) => (
              <label className="sany-radio" key={value}>
                <input type="radio" name="dec1" checked={dec1 === value} onChange={() => setDec1(value)} />
                <span>{label}</span>
              </label>
            ))}
            <div className="sany-hr" />
            <div className="sany-strong sany-mb4">D-02 培育型业务考核方式</div>
            <div className="sany-small sany-mb8">培育型业务仍处投入期，用收入考核可能误导投入节奏。</div>
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
                placeholder="例：双引擎格局成立，但培育业务需在 2027 年前验证单位经济模型；集团目标按财务框执行，单元目标回落方案另行下发。"
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
                ['已完成', '合并来源与对照视图'],
                ['已完成', '口径差异自动标出'],
                [blocking ? '待完成' : '已完成', `${blocking} 项阻断冲突裁定`],
                [summary.unitClosed === summary.unitTotal ? '已完成' : '待完成', `确认已收束单元清单（${summary.unitClosed}/${summary.unitTotal}）`],
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
