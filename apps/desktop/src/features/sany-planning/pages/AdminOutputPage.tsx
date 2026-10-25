import { useState } from 'react';
import { PageHead, Card, Tag, Btn, Section, Alert, Pbar, Modal } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { buildCompanyOutputPlan } from '../output';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

const DELIVERY_CHECKS = [
  { k: 'audit', t: '所有正文结论可回溯到原始材料或人工填写记录' },
  { k: 'basis', t: '每页内容均有依据，无凭空生成内容' },
  { k: 'structure', t: '结构完整：四模块均有结论，缺项已标未决' },
  { k: 'confirm', t: '汇报口径已确认（面向董事会 / 集团经营会）' },
];

export function AdminOutputPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions } = useSanyData();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [forms, setForms] = useState<string[]>(['ppt', 'doc']);

  const generated = data.project.outputGenerated;
  const checks = data.project.deliveryChecks;
  const released = data.project.outputReleased;

  const plan = buildCompanyOutputPlan({
    fields: data.fields,
    tasks: data.tasks,
    issues: data.issues,
    projectName: data.project.name,
  });

  const checkedCount = DELIVERY_CHECKS.filter(item => checks[item.k]).length;
  const canRelease = generated && checkedCount === DELIVERY_CHECKS.length && plan.allSatisfied;
  const generateLabel = plan.draftOnly ? '生成公司级成果（草稿）' : '生成公司级成果';

  const toggleCheck = (key: string, checked: boolean) => {
    void actions.patchProject({ deliveryChecks: { ...checks, [key]: checked } });
  };

  const doGenerate = () => {
    void actions.patchProject({ outputGenerated: true, outputReleased: false });
    setGenerateOpen(false);
  };

  return (
    <section className="sany-page">
      <PageHead
        title="公司级成果"
        sub="把合并确认的内容组织成集团可用的成果件；生成 ≠ 放行，放行需满足六项前置条件"
        actions={generated
          ? <Btn onClick={() => void actions.patchProject({ outputGenerated: false, outputReleased: false })}>重新生成</Btn>
          : <Btn tone="pri" onClick={() => setGenerateOpen(true)}>{generateLabel}</Btn>}
      />

      <Section title="生成前置条件" sub="六项逐项检查，未满足标橙并注明待处理；未全部满足时只能生成草稿">
        <Card className="sany-card--pad">
          <div className="sany-stack">
            {plan.checks.map(check => (
              <div className="sany-checkrow" key={check.key}>
                <span className={check.satisfied ? 'sany-ok' : 'sany-warn'}>{check.satisfied ? '✓' : '!'}</span>
                <span className="sany-grow">{check.label}</span>
                <span className={`sany-small ${check.satisfied ? 'sany-muted' : 'sany-warn'}`}>{check.pendingNote}</span>
                <Tag tone={check.satisfied ? 'g' : 'w'}>{check.satisfied ? '满足' : '待处理'}</Tag>
              </div>
            ))}
          </div>
          <div className="sany-hr" />
          <div className="sany-row">
            <div className="sany-grow">
              <Pbar value={plan.checks.filter(check => check.satisfied).length / plan.checks.length * 100}
                tone={plan.allSatisfied ? 'ok' : 'warn'} />
            </div>
            <span className="sany-small sany-mono">{plan.checks.filter(check => check.satisfied).length} / {plan.checks.length}</span>
            {generated ? null : <Btn size="sm" tone="pri" onClick={() => setGenerateOpen(true)}>{generateLabel}</Btn>}
          </div>
          {plan.draftOnly ? (
            <div className="sany-mt12">
              <Alert tone="w" icon="!">前置条件未全部满足，本次生成的是<b>草稿</b>：未决项与缺报单元会在成果中显式标注，不能直接放行。</Alert>
            </div>
          ) : null}
        </Card>
      </Section>

      {!generated ? (
        <Section title="生成配置" sub="成果形式可多选；页面结构由智能体按合并内容组织，平台原样呈现">
          <Card className="sany-card--pad sany-center">
            <div className="sany-gen">
              <div className="sany-gen__ic">成</div>
              <div className="sany-gen__t">尚未生成公司级成果</div>
              <div className="sany-gen__s">
                合并视图中有 {plan.pages.reduce((sum, page) => sum + page.filled, 0)} 项已确认内容
                {plan.blocking ? `、${plan.blocking} 项阻断冲突未裁定` : ''}
                {plan.missingUnits.length ? `、${plan.missingUnits.length} 个单元未收束` : ''}。
              </div>
              <div className="sany-row sany-gap12">
                <Btn tone="pri" onClick={() => setGenerateOpen(true)}>{generateLabel}</Btn>
                <Btn onClick={() => onNavigate?.('review')}>回到合并</Btn>
              </div>
            </div>
          </Card>
        </Section>
      ) : (
        <>
          <Alert tone={plan.draftOnly ? 'w' : 'g'} icon={plan.draftOnly ? '!' : '✓'}>
            本次成果基于 {plan.submittedUnits} 个已收束单元 + 公司层内容
            {plan.missingUnits.length ? `，${plan.missingUnits.join('、')}标注为` : ''}
            {plan.missingUnits.length ? <b>缺报</b> : null}，未做估算。
            {plan.blocking ? `有 ${plan.blocking} 项阻断冲突未决，放行前需裁定。` : '前置条件全部满足，可申请放行。'}
          </Alert>

          <div className="sany-grid g2 sany-align-start sany-mt16">
            <Section title="成果页结构" sub={`${plan.pages.length} 页 · 每页可下钻到数据来源`} style={{ marginBottom: 0 }}>
              <Card className="sany-card--tight">
                {plan.pages.map((page, index) => (
                  <div className="sany-outpage" key={page.key}>
                    <span className="sany-outpage__n">{String(index + 1).padStart(2, '0')}</span>
                    <div className="sany-grow">
                      <div className="sany-strong">{page.title}</div>
                      <div className="sany-small">{page.description}</div>
                    </div>
                    <span className="sany-small sany-mono">{page.filled} 项</span>
                    {page.missing.length
                      ? <Tag tone="w">缺 {page.missing.length}</Tag>
                      : <Tag tone="g">已填满</Tag>}
                  </div>
                ))}
              </Card>
            </Section>

            <div>
              <Section title="交付校验" sub={`${checkedCount} / ${DELIVERY_CHECKS.length} 项通过，全部通过才能放行`} style={{ marginBottom: 0 }}>
                <Card className="sany-card--pad">
                  <Pbar value={checkedCount / DELIVERY_CHECKS.length * 100} tone={checkedCount === DELIVERY_CHECKS.length ? 'ok' : 'warn'} />
                  <div className="sany-mt12">
                    {DELIVERY_CHECKS.map(item => (
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
                  <div className="sany-small sany-mb8">当前阻断项：{plan.blocking} 项 · 前置条件 {plan.checks.filter(check => check.satisfied).length}/{plan.checks.length}</div>
                  <Btn block tone={released ? 'ok' : 'pri'} disabled={!canRelease || released} onClick={() => setConfirmOpen(true)}>
                    {released ? '已放行 · 查看归档包' : '放行并生成归档包'}
                  </Btn>
                  {!canRelease && !released ? <div className="sany-small sany-mt8">放行前需六项前置条件全部满足，并勾选全部交付校验</div> : null}
                </Card>
              </Section>

              <div className="sany-mt16">
                <Card className="sany-card--pad">
                  <div className="sany-strong sany-mb8">成果文件</div>
                  {[
                    [forms.includes('doc') ? `${plan.fileBase}_正文_V1.pdf` : null, 'PDF'],
                    [forms.includes('ppt') ? `${plan.fileBase}_汇报_V1.pptx` : null, 'PPT'],
                    [`${plan.fileBase}_提交包_V1.zip`, 'ZIP'],
                  ].filter(([file]) => file).map(([file, kind]) => (
                    <div className="sany-fitem" key={String(file)}>
                      <span className="sany-fico">{String(kind)}</span>
                      <div className="sany-grow">
                        <div className="sany-fname">{String(file)}</div>
                        <div className="sany-fmeta">{plan.draftOnly ? '草稿 · 未放行' : released ? '已放行 · 归档' : '待放行'}</div>
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
                ['合并视图', `${plan.pages.reduce((sum, page) => sum + page.filled, 0)} 项确认`],
                ['冲突裁定', `${data.issues.length - plan.blocking}/${data.issues.length} 已处理`],
                ['成果生成', plan.draftOnly ? '草稿' : '正式版'],
                ['交付校验', `${checkedCount}/${DELIVERY_CHECKS.length}`],
                ['放行归档', released ? '已完成' : '待放行'],
              ].map(([title, sub], index) => {
                const doneIndex = released ? 5 : plan.draftOnly ? 2 : 3;
                return (
                  <div className={`sany-fl ${index < doneIndex ? 'done' : index === doneIndex ? 'cur' : ''}`} key={title}>
                    <span className="sany-fl__d">{index < doneIndex ? '✓' : index + 1}</span>
                    <div className="sany-fl__b">
                      <div className="sany-fl__t">{title}</div>
                      <div className="sany-fl__s">{sub}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        </>
      )}

      <Modal
        open={generateOpen}
        title={generateLabel}
        sub={plan.draftOnly ? '前置条件未全部满足，将生成带未决标记的草稿' : '前置条件已全部满足，将生成正式版'}
        onClose={() => setGenerateOpen(false)}
        footer={(
          <>
            <Btn onClick={() => setGenerateOpen(false)}>取消</Btn>
            <Btn tone="pri" disabled={!forms.length} onClick={doGenerate}>确认生成</Btn>
          </>
        )}
      >
        <div className="sany-fld">
          <label>成果形式（可多选）</label>
          {[
            ['ppt', '公司级规划 PPT'],
            ['doc', '结构化汇总稿'],
            ['board', '董事会决策材料'],
          ].map(([key, label]) => (
            <label className="sany-chkbx sany-chkbx--tight" key={key}>
              <input
                type="checkbox"
                checked={forms.includes(key)}
                onChange={() => setForms(prev => (prev.includes(key) ? prev.filter(item => item !== key) : [...prev, key]))}
              />
              <span className="sany-grow">{label}</span>
            </label>
          ))}
        </div>
        <Alert icon="i">页面结构由智能体按合并内容组织；生成前不显示任何结构预览，生成后按返回结果渲染并可逐页下钻。</Alert>
      </Modal>

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
        <Alert tone="g" icon="✓">六项前置条件与交付校验均已满足。放行后成果包将归档，管理员与负责人均可在成果页查看历史版本。</Alert>
        <div className="sany-mt12">
          <div className="sany-small sany-mb4">
            仓库单位：{plan.submittedUnits} 个单元已收束{plan.missingUnits.length ? `，${plan.missingUnits.length} 个单元缺报` : ''}
          </div>
          <div className="sany-small">成果页：{plan.pages.length} 页 · 确认内容 {plan.pages.reduce((sum, page) => sum + page.filled, 0)} 项</div>
        </div>
      </Modal>
    </section>
  );
}
