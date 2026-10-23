import { useMemo, useState } from 'react';
import type { ModuleKey, SanyModule } from './mock';
import type { SanyFieldDto } from '../../api/sany';
import { useSanyData } from './SanyDataContext';
import { Btn, Card, PageHead, Pbar, Section, Tag } from './ui';

type Props = {
  scope: 'owner' | 'company';
  title: string;
  subtitle: string;
  modules: SanyModule[];
  fields: SanyFieldDto[];
  taskId?: string | null;
  docCount: (key: ModuleKey) => number;
  onGoUpload: () => void;
  onFinish?: () => void;
  finishLabel?: string;
};

const STATUS_TAG: Record<string, { tone: 'v' | 'g' | 'b' | 'r' | 'w'; text: string }> = {
  pending: { tone: 'v', text: '待确认' },
  accepted: { tone: 'g', text: '已采纳' },
  edited: { tone: 'b', text: '已填写' },
  rejected: { tone: 'r', text: '已驳回' },
  missing: { tone: 'w', text: '缺材料' },
};

const TIPS: Record<'owner' | 'company', Record<ModuleKey, string>> = {
  owner: {
    review: '经营回顾的数据来自损益表，可信度高。但「内部瓶颈」属诊断性判断，材料中没有直接依据，建议由你结合实际撰写。',
    market: '市场规模与增速来自行业报告，注意统计口径是否覆盖你的目标区域。「对标差距」缺指标数据，已列入缺口。',
    biz: '客户与价值主张来自调研纪要，样本为 12 家经销商，代表性有限。',
    plan: '三年目标为按历史增速推算，务必确认是否与集团下达的指标一致。',
  },
  company: {
    review: '集团合并报表口径可靠，但分部数据需注意内部交易抵消。跨业务协同价值缺测算材料，已列为缺口。',
    market: '行业报告的数据范围可能与本集团可及市场不一致，请核对是否只保留相关细分。',
    biz: '业务组合定位取自战略纲要，但集团管控与协同机制缺制度依据，需你补充。',
    plan: '集团三年目标由各单元申报加总，是否接受需集团层面决策，不能直接采信。资源投入超预算 0.7 亿元，必须裁定。',
  },
};

export function PrefillBoard({ scope, title, subtitle, modules, fields, taskId, docCount, onGoUpload, onFinish, finishLabel }: Props): React.JSX.Element {
  const { actions } = useSanyData();
  const byModule = useMemo(() => {
    const grouped: Record<ModuleKey, SanyFieldDto[]> = { review: [], market: [], biz: [], plan: [] };
    fields.forEach(field => { grouped[field.moduleKey].push(field); });
    return grouped;
  }, [fields]);

  const active = modules.filter(module => docCount(module.k) > 0);
  const [activeKey, setActiveKey] = useState<ModuleKey>(active[0]?.k ?? modules[0].k);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customValue, setCustomValue] = useState('');

  const current = active.some(module => module.k === activeKey) ? activeKey : active[0]?.k;
  const list = current ? byModule[current] : [];
  const visible = list.filter(field => !field.removed);
  const removed = list.filter(field => field.removed);
  const totalPending = (Object.keys(byModule) as ModuleKey[])
    .filter(key => docCount(key) > 0)
    .flatMap(key => byModule[key])
    .filter(field => !field.removed && field.status === 'pending').length;

  const stat = useMemo(() => {
    const count = (status: string) => visible.filter(field => field.status === status).length;
    const done = count('accepted') + count('edited') + count('rejected');
    return {
      done,
      total: visible.length,
      pending: count('pending'),
      accepted: count('accepted'),
      edited: count('edited'),
      rejected: count('rejected'),
      missing: count('missing'),
      custom: visible.filter(field => field.custom).length,
      pct: visible.length ? Math.round(done / visible.length * 100) : 0,
    };
  }, [visible]);

  if (!active.length) {
    return (
      <section className="sany-page">
        <PageHead title={title} sub="还没有可校验的内容" />
        <Card className="sany-card--pad sany-center">
          <div className="sany-empty">
            <div className="sany-empty__i">↑</div>
            <div className="sany-empty__t">先上传材料</div>
            <div className="sany-empty__s">哪个模块传了材料，这里才会出现哪个模块的生成内容</div>
            <Btn tone="pri" onClick={onGoUpload}>去上传</Btn>
          </div>
        </Card>
      </section>
    );
  }

  const setStatus = (field: SanyFieldDto, status: SanyFieldDto['status']) => {
    void actions.patchField(field.id, { status });
  };

  const startEdit = (field: SanyFieldDto) => {
    setEditing(field.id);
    setDraft(field.human ?? field.ai);
  };

  const saveEdit = (field: SanyFieldDto) => {
    void actions.patchField(field.id, { human: draft, status: 'edited' });
    setEditing(null);
  };

  const markRemoved = (field: SanyFieldDto) => {
    void actions.patchField(field.id, { removed: true, removedReason: field.custom ? '已删除' : '本单元不适用' });
  };

  const restore = (field: SanyFieldDto) => {
    void actions.patchField(field.id, { removed: false, removedReason: null });
  };

  const acceptHigh = () => {
    if (!current) return;
    list
      .filter(field => !field.removed && field.status === 'pending' && field.conf >= 85)
      .forEach(field => void actions.patchField(field.id, { status: 'accepted' }));
  };

  const addCustom = () => {
    if (!current || !customName.trim()) return;
    const value = customValue.trim();
    void actions.addField({
      scope: scope === 'owner' ? 'unit' : 'company',
      moduleKey: current,
      taskId: scope === 'owner' ? taskId ?? null : null,
      label: customName.trim(),
      type: 'text',
      ai: value,
      human: value || null,
    });
    setCustomName('');
    setCustomValue('');
    setAdding(false);
  };

  const skipped = modules.filter(module => docCount(module.k) === 0);

  return (
    <section className="sany-page">
      <PageHead
        title={title}
        sub={subtitle}
        actions={(
          <>
            <Tag tone={totalPending ? 'v' : 'g'}>{totalPending ? `${totalPending} 项待确认` : '全部已确认'}</Tag>
            {totalPending ? <Btn onClick={acceptHigh}>一键采纳高置信项</Btn> : null}
          </>
        )}
      />

      <div className="sany-steps">
        {active.map((module, index) => {
          const moduleFields = byModule[module.k].filter(field => !field.removed);
          const pending = moduleFields.filter(field => field.status === 'pending').length;
          const missing = moduleFields.filter(field => field.status === 'missing').length;
          const done = pending === 0 && missing === 0;
          return (
            <button
              type="button"
              key={module.k}
              className={`sany-st ${current === module.k ? 'on' : ''} ${done ? 'done' : ''}`}
              onClick={() => { setActiveKey(module.k); setEditing(null); }}
            >
              <span className="sany-st__n">{done ? '✓' : index + 1}</span>
              <span className="sany-st__t">{module.n}</span>
              <span className="sany-st__c">{docCount(module.k)} 份</span>
            </button>
          );
        })}
      </div>

      {skipped.length ? (
        <div className="sany-hintline">
          未上传材料、暂无内容的模块：{skipped.map(module => module.n).join('、')}
          <button type="button" className="sany-link" onClick={onGoUpload}>去上传</button>
        </div>
      ) : null}

      <Card className="sany-card--pad sany-modhead">
        <div className="sany-row">
          <b>{modules.find(module => module.k === current)?.n}</b>
          <Tag tone="line">{modules.find(module => module.k === current)?.d}</Tag>
          {stat.custom ? <Tag tone="c">含 {stat.custom} 项自定义</Tag> : null}
          {removed.length ? <Tag>{removed.length} 项已标不适用</Tag> : null}
          <span className="sany-spacer" />
          <span className="sany-small">{stat.done}/{stat.total} 已确认</span>
        </div>
        <Pbar value={stat.pct} />
      </Card>

      <div className="sany-split">
        <div>
          {visible.map(field => {
            const isEditing = editing === field.id;
            const tone = STATUS_TAG[field.status];
            return (
              <div key={field.id} className={`sany-field st-${field.status} ${field.removed ? 'removed' : ''}`}>
                <div className="sany-field__h">
                  <div className="sany-field__n">
                    {field.n}
                    {field.custom ? <Tag tone="c">自定义</Tag> : null}
                  </div>
                  {field.status === 'pending' && !field.custom && field.conf > 0 && field.conf < 78 ? (
                    <span className="sany-conf" title="依据偏弱，建议核对原文">
                      <span className="sany-conf__bar"><i style={{ width: `${field.conf}%` }} /></span>
                      <span>待核</span>
                    </span>
                  ) : null}
                  <Tag tone={tone.tone}>{tone.text}</Tag>
                </div>
                <div className="sany-field__b">
                  {isEditing ? (
                    <div className="sany-edit">
                      <textarea
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                        rows={field.type === 'text' ? 6 : 2}
                      />
                      <div className="sany-row">
                        <Btn size="sm" tone="pri" onClick={() => saveEdit(field)}>保存</Btn>
                        <Btn size="sm" onClick={() => setEditing(null)}>取消</Btn>
                        <span className="sany-small">修改会记录在溯源链中</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className={`sany-field__v ${field.status === 'missing' ? 'missing' : ''}`}>
                        {field.status === 'edited' && field.human ? field.human : field.ai || '（待填写）'}
                      </div>
                      {field.status === 'edited' && field.human && field.ai && field.ai !== field.human ? (
                        <div className="sany-field__src sany-field__src--edit">
                          <b>你修改了此项</b>
                          <span>原建议：{field.ai.slice(0, 30)}…</span>
                        </div>
                      ) : null}
                      {field.status === 'missing' ? (
                        <div className="sany-field__src">
                          <span className="sany-field__gap">缺少材料：</span>
                          <span>{field.gap ?? '相关材料不足'}</span>
                        </div>
                      ) : field.src ? (
                        <div className="sany-field__src">
                          <span>来源</span>
                          <span className="sany-field__sl">{field.src}</span>
                        </div>
                      ) : (
                        <div className="sany-field__src">
                          <span>{field.custom ? '你新增的字段' : '无直接原文依据，为系统推断'}</span>
                        </div>
                      )}
                    </>
                  )}
                  {!isEditing ? (
                    <div className="sany-field__act">
                      {field.status !== 'accepted' && field.ai ? (
                        <Btn size="sm" tone={field.status === 'pending' ? 'pri' : undefined} onClick={() => setStatus(field, 'accepted')}>采纳</Btn>
                      ) : null}
                      <Btn size="sm" onClick={() => startEdit(field)}>{field.ai ? '修改' : '填写'}</Btn>
                      {field.status !== 'rejected' ? (
                        <Btn size="sm" onClick={() => setStatus(field, 'rejected')}>驳回</Btn>
                      ) : null}
                      <Btn size="sm" tone="ghost" onClick={() => markRemoved(field)}>
                        {field.custom ? '删除' : '不适用'}
                      </Btn>
                      {field.status !== 'pending' ? (
                        <Btn size="sm" tone="ghost" onClick={() => setStatus(field, 'pending')}>撤销</Btn>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {removed.length ? (
            <Card className="sany-card--pad sany-removed">
              <div className="sany-row">
                <b>已标记不适用</b>
                <span className="sany-spacer" />
                <span className="sany-small">{removed.length} 项，不计入完成度</span>
              </div>
              {removed.map(field => (
                <div className="sany-removed__row" key={field.id}>
                  <span className="sany-removed__n">{field.n}</span>
                  <span className="sany-small">{field.removedReason ?? ''}</span>
                  <button type="button" className="sany-link" onClick={() => restore(field)}>恢复</button>
                </div>
              ))}
            </Card>
          ) : null}

          {adding ? (
            <Card className="sany-card--pad sany-addform">
              <div className="sany-fld">
                <label>字段名称</label>
                <input value={customName} onChange={event => setCustomName(event.target.value)} placeholder="例：海外渠道收入占比" />
              </div>
              <div className="sany-fld">
                <label>内容</label>
                <textarea rows={3} value={customValue} onChange={event => setCustomValue(event.target.value)} placeholder="填写本单元实际内容" />
              </div>
              <div className="sany-row">
                <Btn size="sm" tone="pri" onClick={addCustom}>添加</Btn>
                <Btn size="sm" onClick={() => setAdding(false)}>取消</Btn>
              </div>
            </Card>
          ) : null}

          <div className="sany-row sany-footrow">
            <Btn onClick={() => setAdding(true)}>＋ 新增自定义项</Btn>
            <span className="sany-small">本模块预设 {visible.filter(field => !field.custom).length} 项，可按本单元实际增删</span>
            <span className="sany-spacer" />
            {active.findIndex(module => module.k === current) > 0 ? (
              <Btn onClick={() => {
                const idx = active.findIndex(module => module.k === current);
                setActiveKey(active[idx - 1].k);
              }}>上一模块</Btn>
            ) : null}
            {active.findIndex(module => module.k === current) < active.length - 1 ? (
              <Btn tone="pri" onClick={() => {
                const idx = active.findIndex(module => module.k === current);
                setActiveKey(active[idx + 1].k);
              }}>下一模块</Btn>
            ) : onFinish ? (
              <Btn tone="pri" onClick={onFinish}>{finishLabel ?? '下一步'}</Btn>
            ) : null}
          </div>
        </div>

        <aside className="sany-side">
          <Card className="sany-card--pad">
            <div className="sany-side__t">本模块概览</div>
            {[
              ['待确认', stat.pending, 'ink3'],
              ['已采纳', stat.accepted, 'ok'],
              ['已填写/修改', stat.edited, 'brand'],
              ['已驳回', stat.rejected, 'danger'],
              ['缺材料', stat.missing, 'warn'],
              ['自定义项', stat.custom, 'cyan'],
            ].map(([label, count, tone]) => (
              <div className="sany-side__row" key={label as string}>
                <span className={`sany-dot ${tone as string}`} />
                <span>{label}</span>
                <b>{count}</b>
              </div>
            ))}
          </Card>
          <Card className="sany-card--pad sany-card--soft">
            <div className="sany-side__t">系统提示</div>
            <div className="sany-side__note">{current ? TIPS[scope][current] : ''}</div>
          </Card>
          <Section title="定制化说明">
            <div className="sany-small">
              四个模块是分析框架，不是固定表格。职能部门可以根据自己的管理口径新增字段，
              对确实不涉及的内容标记为不适用——汇总时不会被当成缺报。
            </div>
          </Section>
        </aside>
      </div>
    </section>
  );
}
