import { useState } from 'react';
import { PageHead, Card, Tag, Btn, Section, Alert, Modal } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { OWNER_DECKS } from '../mock';

const KIND_LABEL: Record<string, string> = { doc: 'DOC', ppt: 'PPT', diag: 'PDF', package: 'ZIP' };
const STATUS_TONE: Record<string, 'g' | 'v' | 'r'> = { 已归档: 'g', 待审核: 'v', 已退回: 'r', 已通过: 'g' };

export function OwnerOutputPage(): React.JSX.Element {
  const { data, actions, ownerTask, ownerTasks, setOwnerTaskId } = useSanyData();
  const [outputKey, setOutputKey] = useState<'doc' | 'ppt' | 'diag' | 'package'>('package');
  const [versionNo, setVersionNo] = useState(0);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const task = ownerTask;
  const taskList = ownerTasks;

  const outputs = data.outputs;
  const output = outputs.find(item => item.key === outputKey) ?? outputs[0];
  const version = output?.versions.find(item => item.v === versionNo) ?? output?.versions[output.versions.length - 1];
  const isPpt = output?.key === 'ppt';
  const unitFields = data.fields.filter(field => field.scope === 'unit' && !field.removed && field.taskId === (task?.id ?? null));
  const confirmed = unitFields.filter(field => field.status === 'accepted' || field.status === 'edited');
  const missing = unitFields.filter(field => field.status === 'missing').length;
  const lowConf = unitFields.filter(field => field.status === 'pending' && field.conf > 0 && field.conf < 85).length;
  const unitDocs = data.documents.filter(document => document.scope === 'unit');

  const submitVersion = async () => {
    if (!output || !version || !task) return;
    setSubmitting(true);
    try {
    const newVersion = await actions.addVersion(output.key, {
      summary: '按最新一次校验结果重新提交',
      changes: '同步最近一次校验中的采纳与修改内容',
      size: version.size,
      file: version.file,
      status: '待审核',
    });
    if (!newVersion) return;
    const deliverables = [
        { name: `${output.name} V${newVersion.v}`, kind: output.key },
        ...outputs
          .filter(item => item.key !== output.key && item.versions.length)
          .map(item => {
            const latest = item.versions[item.versions.length - 1];
            return { name: `${item.name} V${latest.v}`, kind: item.key };
          }),
      ];
      await actions.submitTask(task.id, {
        summary: `${output.name} V${newVersion.v} + 诊断 + ${unitDocs.length} 份材料`,
        deliverables,
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (!output || !version || !task) {
    return (
      <section className="sany-page">
        <PageHead title="我的成果" sub="正文、汇报 PPT、诊断报告与提交包分开管理" />
        <Card className="sany-card--pad sany-center">
          <div className="sany-empty">
            <div className="sany-empty__t">还没有成果版本</div>
            <div className="sany-empty__s">完成内容校验并提交后，这里会出现可回溯的版本链</div>
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section className="sany-page">
      <PageHead
        title="我的成果"
        sub="正文、汇报 PPT、诊断报告与提交包分开管理；每次提交都留版本，可回溯到对应材料与校验记录"
        actions={(
          <>
            <Btn onClick={() => setSubmitOpen(true)}>提交给管理员</Btn>
            <Btn tone="pri" onClick={() => setSubmitOpen(true)}>生成新版本</Btn>
          </>
        )}
      />

      <div className="sany-taskbar">
        <span className="sany-taskbar__l">当前任务</span>
        <select className="sany-sel sany-taskbar__grow" value={task?.id ?? ''} onChange={event => setOwnerTaskId(event.target.value)}>
          {taskList.map(item => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>)}
        </select>
        <span className="sany-taskbar__t">{task?.unit}</span>
      </div>

      {submitted ? (
        <div className="sany-mb16">
          <Alert tone="g" icon="✓">提交包已提交给管理员，管理员将在任务收束中看到；旧版本仍保留在版本链中。</Alert>
        </div>
      ) : null}

      <div className="sany-split sany-split--out">
        <aside>
          <div className="sany-outlist">
            {outputs.map(item => {
              const latest = item.versions[item.versions.length - 1];
              if (!latest) return null;
              return (
                <button
                  type="button"
                  key={item.key}
                  className={`sany-outitem ${outputKey === item.key ? 'on' : ''}`}
                  onClick={() => { setOutputKey(item.key); setVersionNo(latest.v); }}
                >
                  <span className="sany-outitem__ic">{KIND_LABEL[item.key]}</span>
                  <div className="sany-grow">
                    <div className="sany-outitem__n">{item.name}</div>
                    <div className="sany-small">V{latest.v} · {latest.at.slice(5, 16)}</div>
                  </div>
                  <Tag tone={STATUS_TONE[latest.status]}>{latest.status}</Tag>
                </button>
              );
            })}
          </div>
          <Card className="sany-card--pad sany-card--soft sany-mt12">
            <div className="sany-small">{output.note}</div>
          </Card>
        </aside>

        <div>
          <Card className="sany-card--pad">
            <div className="sany-row sany-mb8">
              <b className="sany-grow">{output.name}</b>
              <Tag tone="line">{output.description}</Tag>
            </div>
            <div className="sany-versions">
              {output.versions.map(item => (
                <button
                  type="button"
                  key={item.v}
                  className={`sany-version ${version.v === item.v ? 'on' : ''}`}
                  onClick={() => setVersionNo(item.v)}
                >
                  <div className="sany-row">
                    <b>V{item.v}</b>
                    <span className="sany-spacer" />
                    <Tag tone={STATUS_TONE[item.status]}>{item.status}</Tag>
                  </div>
                  <div className="sany-small sany-mt4">{item.at}</div>
                  <div className="sany-small">{item.by} · {item.size}</div>
                </button>
              ))}
            </div>

            <div className="sany-hr" />

            <div className="sany-row sany-mb4">
              <b>V{version.v} 版本摘要</b>
              <span className="sany-spacer" />
              {version.status === '待审核' ? <span className="sany-small sany-muted">已提交，等待管理员审核</span> : null}
            </div>
            <div className="sany-small sany-mb8">{version.summary}</div>
            <div className="sany-small sany-mb12"><b>本版变更</b> {version.changes}</div>

            {version.audit ? (
              <div className="sany-mb12">
                <Alert tone="r" icon="!">{version.audit}</Alert>
              </div>
            ) : null}

            <div className="sany-row">
              <Btn size="sm" onClick={() => setSubmitOpen(true)}>下载</Btn>
              <Btn size="sm" onClick={() => setSubmitOpen(true)}>复制分享链接</Btn>
              <span className="sany-spacer" />
              {version.status === '已退回' || version.status === '已归档' ? (
                <Btn size="sm" tone="pri" onClick={() => setSubmitOpen(true)}>基于本版新建版本</Btn>
              ) : (
                <Btn size="sm" tone="pri" disabled>当前提交版</Btn>
              )}
            </div>
          </Card>

          {isPpt ? (
            <Section title="PPT 页面结构" sub="智能体按内容组织，页序不代表重要性；每页可下钻到来源">
              <div className="sany-grid g2 sany-gap12">
                {OWNER_DECKS.map((page, index) => (
                  <Card className="sany-deck" key={page.n}>
                    <div className="sany-row sany-mb4">
                      <span className="sany-deck__n">{String(index + 1).padStart(2, '0')}</span>
                      <b className="sany-grow">{page.n}</b>
                      <Tag tone={page.missing.length ? 'w' : 'g'}>{page.missing.length ? `${page.missing.length} 项待补` : '已填满'}</Tag>
                    </div>
                    <div className="sany-small">{page.d}</div>
                    <div className="sany-small sany-mt4">{page.filled} 项内容{page.missing.length ? ` · 缺 ${page.missing.join('、')}` : ''}</div>
                  </Card>
                ))}
              </div>
            </Section>
          ) : (
            <Section title="本版内容构成" sub="每项内容均可回溯到材料或校验记录">
              <Card className="sany-card--pad">
                <div className="sany-grid g3 sany-gap12">
                  <div className="sany-mini">
                    <div className="sany-mini__l">已确认字段</div>
                    <div className="sany-mini__v">{confirmed.length} <span className="sany-mini__u">项</span></div>
                  </div>
                  <div className="sany-mini">
                    <div className="sany-mini__l">引用材料</div>
                    <div className="sany-mini__v">{unitDocs.length} <span className="sany-mini__u">份</span></div>
                  </div>
                  <div className="sany-mini">
                    <div className="sany-mini__l">正文结论</div>
                    <div className="sany-mini__v">{unitDocs.reduce((sum, document) => sum + document.claims, 0)} <span className="sany-mini__u">条</span></div>
                  </div>
                </div>
                <div className="sany-hr" />
                <div className="sany-small">
                  正文按四模块章节成文，每个结论后标注来源材料页码或「人工填写」记录。
                </div>
              </Card>
            </Section>
          )}

          <div className="sany-grid g2 sany-mt16">
            <Card className="sany-card--pad">
              <div className="sany-strong sany-mb4">版本规则</div>
              <div className="sany-small">
                提交的版本不会被覆盖，管理员看到的是提交那一刻的内容；修改后需生成新版本并重新提交。退回的版本保留原文，可基于它重做。
              </div>
            </Card>
            <Card className="sany-card--pad">
              <div className="sany-strong sany-mb4">交付边界</div>
              <div className="sany-small">
                汇报 PPT 不进入提交包，只用于本单元与下级汇报；提交包 = 正文 + 诊断报告 + 原始材料。管理员审阅的是提交包。
              </div>
            </Card>
          </div>
        </div>
      </div>

      <Modal
        open={submitOpen}
        title="提交给管理员"
        sub={`任务：${task.code} · ${task.title}`}
        onClose={() => setSubmitOpen(false)}
        footer={(
          <>
            <Btn onClick={() => setSubmitOpen(false)}>取消</Btn>
            <Btn tone="pri" disabled={submitting} onClick={() => { setSubmitOpen(false); void submitVersion(); }}>
              {submitting ? '提交中…' : '确认提交'}
            </Btn>
          </>
        )}
      >
        {missing || lowConf
          ? <Alert tone="w" icon="!">提交包中仍有 {missing} 项阻断缺口与 {lowConf} 项低依据字段，将一并标注给管理员。建议先补齐材料或写明原因。</Alert>
          : <Alert tone="g" icon="✓">没有阻断缺口与低依据字段，可以提交。</Alert>}
        <Card className="sany-card--pad sany-card--soft sany-mt12">
          <div className="sany-row sany-mb4">
            <span className="sany-small">交付内容</span>
            <span className="sany-spacer" />
            <b>{output.name} V{version.v + 1} + 诊断 + {unitDocs.length} 份材料</b>
          </div>
          <div className="sany-row sany-mb4"><span className="sany-small">版本号</span><span className="sany-spacer" /><b>V{version.v + 1}</b></div>
          <div className="sany-row"><span className="sany-small">接收人</span><span className="sany-spacer" /><b>{data.members.find(member => member.role === 'admin')?.name ?? '管理员'}</b></div>
        </Card>
      </Modal>
    </section>
  );
}
