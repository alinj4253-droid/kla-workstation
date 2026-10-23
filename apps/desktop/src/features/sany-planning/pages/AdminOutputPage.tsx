import { useState } from 'react';
import { PageHead, Card, Tag, Btn, Section, Alert, Pbar, Modal } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { COMPANY_RESULT_PAGES } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

const CHECKS = [
  { k: 'all', t: '所有应提交单元已完成校验或已明确标注缺报' },
  { k: 'conflict', t: '阻断级冲突已裁定并写入结论' },
  { k: 'audit', t: '所有正文结论可回溯到原始材料或人工填写记录' },
  { k: 'basis', t: '每页内容均有依据，无凭空生成内容' },
  { k: 'structure', t: '结构完整：四模块均有结论，缺项已标未决' },
  { k: 'confirm', t: '汇报口径已确认（面向董事会 / 集团经营会）' },
];

export function AdminOutputPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions } = useSanyData();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const generated = data.project.outputGenerated;
  const checks = data.project.deliveryChecks;
  const released = data.project.outputReleased;
  const checkedCount = CHECKS.filter(item => checks[item.k]).length;
  const canRelease = generated && checkedCount === CHECKS.length;
  const submitted = data.tasks.filter(task => task.status === '已提交' || task.status === '校验中').length;
  const missingUnits = data.tasks.filter(task => task.status !== '已提交' && task.status !== '校验中' && task.status !== '已通过');
  const blocking = data.issues.filter(issue => issue.level === '阻断' && issue.status !== '已解决').length;
  const merged = data.fields.filter(field => field.scope === 'unit' && !field.removed && (field.status === 'accepted' || field.status === 'edited')).length;

  const toggleCheck = (key: string, checked: boolean) => {
    void actions.patchProject({ deliveryChecks: { ...checks, [key]: checked } });
  };

  return (
    <section className="sany-page">
      <PageHead
        title="公司级成果"
        sub="把合并确认的内容组织成集团可用的成果件；生成 ≠ 放行，放行需满足六项条件"
        actions={generated
          ? <Btn onClick={() => void actions.patchProject({ outputGenerated: false, outputReleased: false })}>重新生成</Btn>
          : <Btn tone="pri" onClick={() => void actions.patchProject({ outputGenerated: true })}>生成公司级成果</Btn>}
      />

      {!generated ? (
        <Card className="sany-card--pad sany-card--soft">
          <div className="sany-gen">
            <div className="sany-gen__ic">成</div>
            <div className="sany-gen__t">尚未生成公司级成果</div>
            <div className="sany-gen__s">合并视图中有 {merged} 项已确认内容、{blocking} 项阻断冲突未裁定，可先生成底稿，冲突会以「未决」标注。</div>
            <div className="sany-row sany-gap12">
              <Btn tone="pri" onClick={() => void actions.patchProject({ outputGenerated: true })}>生成底稿</Btn>
              <Btn onClick={() => onNavigate?.('review')}>回到合并</Btn>
            </div>
            <div className="sany-gen__grid">
              {['规划正文', '汇报 PPT', '内容诊断报告', '提交/归档包'].map(item => (
                <div className="sany-gen__cell" key={item}>
                  <span className="sany-dot" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      ) : (
        <>
          <Alert tone="w" icon="!">
            本次成果基于 {submitted} 个已提交单元 + 公司层内容
            {missingUnits.length ? `，${missingUnits.map(task => task.unit).join('、')}标注为` : ''}
            {missingUnits.length ? <b>缺报</b> : null}，未做估算。
            {blocking ? `有 ${blocking} 项阻断冲突未决，放行前需裁定。` : ''}
          </Alert>

          <div className="sany-grid g2 sany-align-start sany-mt16">
            <Section title="成果页结构" sub={`${COMPANY_RESULT_PAGES.length} 页 · 每页可下钻到数据来源`} style={{ marginBottom: 0 }}>
              <Card className="sany-card--tight">
                {COMPANY_RESULT_PAGES.map((page, index) => (
                  <div className="sany-outpage" key={page.n}>
                    <span className="sany-outpage__n">{String(index + 1).padStart(2, '0')}</span>
                    <div className="sany-grow">
                      <div className="sany-strong">{page.n}</div>
                      <div className="sany-small">{page.d}</div>
                    </div>
                    <span className="sany-small sany-mono">{page.filled} 项</span>
                    {page.missing.length
                      ? page.missing.map(item => <Tag tone="w" key={item}>{item}</Tag>)
                      : <Tag tone="g">已填满</Tag>}
                  </div>
                ))}
              </Card>
            </Section>

            <div>
              <Section title="交付校验" sub={`${checkedCount} / ${CHECKS.length} 项通过，全部通过才能放行`} style={{ marginBottom: 0 }}>
                <Card className="sany-card--pad">
                  <Pbar value={checkedCount / CHECKS.length * 100} tone={checkedCount === CHECKS.length ? 'ok' : 'warn'} />
                  <div className="sany-mt12">
                    {CHECKS.map(item => (
                      <label className="sany-checkline" key={item.k}>
                        <input
                          type="checkbox"
                          checked={!!checks[item.k]}
                          onChange={event => toggleCheck(item.k, event.target.checked)}
                        />
                        <span>{item.t}</span>
                      </label>
                    ))}
                  </div>
                  <div className="sany-hr" />
                  <div className="sany-small sany-mb8">当前阻断项：{blocking} 项</div>
                  <Btn block tone={released ? 'ok' : 'pri'} disabled={!canRelease || released} onClick={() => setConfirmOpen(true)}>
                    {released ? '已放行 · 查看归档包' : '放行并生成归档包'}
                  </Btn>
                  {!canRelease ? <div className="sany-small sany-mt8">放行前需勾选全部条件，并完成阻断冲突裁定</div> : null}
                </Card>
              </Section>

              <div className="sany-mt16">
                <Card className="sany-card--pad">
                  <div className="sany-strong sany-mb8">成果文件</div>
                  {['集团三一战略规划_正文_V1.pdf', '集团三一战略规划_汇报_V1.pptx', '集团三一战略规划_提交包_V1.zip'].map(file => (
                    <div className="sany-fitem" key={file}>
                      <span className="sany-fico">{file.endsWith('pdf') ? 'PDF' : file.endsWith('pptx') ? 'PPT' : 'ZIP'}</span>
                      <div className="sany-grow">
                        <div className="sany-fname">{file}</div>
                        <div className="sany-fmeta">刚刚生成 · 内部使用</div>
                      </div>
                      <button type="button" className="sany-link">下载</button>
                    </div>
                  ))}
                </Card>
              </div>
            </div>
          </div>

          <Section title="从合并到成果的留痕">
            <div className="sany-flow horizontal">
              {[
                ['合并视图', `${merged} 项去重`],
                ['冲突裁定', `${data.issues.length - blocking}/${data.issues.length} 已处理`],
                ['成果生成', `${COMPANY_RESULT_PAGES.length} 页`],
                ['交付校验', `${checkedCount}/${CHECKS.length}`],
                ['放行归档', released ? '已完成' : '待放行'],
              ].map(([title, sub], index) => (
                <div className={`sany-fl ${index < 3 ? 'done' : index === 3 ? 'cur' : ''}`} key={title}>
                  <span className="sany-fl__d">{index < 3 ? '✓' : index + 1}</span>
                  <div className="sany-fl__b">
                    <div className="sany-fl__t">{title}</div>
                    <div className="sany-fl__s">{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}

      <Modal
        open={confirmOpen}
        title="确认放行"
        sub="放行后成果归档，仅可追加新版本"
        onClose={() => setConfirmOpen(false)}
        footer={(
          <>
            <Btn onClick={() => setConfirmOpen(false)}>返回检查</Btn>
            <Btn tone="pri" onClick={() => { void actions.patchProject({ outputReleased: true }); setConfirmOpen(false); }}>确认放行</Btn>
          </>
        )}
      >
        <Alert tone="g" icon="✓">六项条件均已勾选。放行后成果包将归档，管理员与负责人均可在成果页查看历史版本。</Alert>
        <div className="sany-mt12">
          <div className="sany-small sany-mb4">
            仓库单位：{submitted} 个单元已提交{missingUnits.length ? `，${missingUnits.length} 个单元缺报` : ''}
          </div>
          <div className="sany-small">未决事项：目标口径与培育业务考核方式</div>
        </div>
      </Modal>
    </section>
  );
}
