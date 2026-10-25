import { useState } from 'react';
import { PageHead, Card, Tag, Btn, StatusTag, Modal, Alert } from '../ui';
import { ASSIGN_REQ_DEFAULT, PLAN_INTENT_TEXT } from '../mock';
import { useSanyData } from '../SanyDataContext';

type ReqItem = { t: string; on: boolean; custom?: boolean };

export function AdminAssignPage(): React.JSX.Element {
  const { data, actions } = useSanyData();
  const owners = data.members.filter(member => member.role === 'owner');
  const tasks = data.tasks;
  const availableOwners = owners.filter(member => !tasks.some(task => task.owner === member.name));
  const [selected, setSelected] = useState<string[]>(() => availableOwners.map(member => member.id));
  const [title, setTitle] = useState('2027—2029 公司级三一战略规划');
  const [intent, setIntent] = useState(PLAN_INTENT_TEXT);
  const [period, setPeriod] = useState('2027—2029');
  const [deadline, setDeadline] = useState('2026-11-15');
  const [reqs, setReqs] = useState<ReqItem[]>(ASSIGN_REQ_DEFAULT.map(item => ({ ...item })));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [reqText, setReqText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const toggleOwner = (memberId: string) => {
    setSelected(prev => (prev.includes(memberId) ? prev.filter(id => id !== memberId) : [...prev, memberId]));
  };

  const doAssign = () => {
    const targets = owners.filter(member => selected.includes(member.id));
    if (!targets.length) return false;
    void actions.createTask({
      title,
      intent,
      deadline,
      planningPeriod: period,
      owners: targets.map(member => ({ name: member.name, unit: member.unit, note: notes[member.name] ?? '' })),
      requirements: reqs.filter(item => item.on).map(item => item.t),
    });
    return true;
  };

  const toggleReq = (index: number) => {
    setReqs(prev => prev.map((item, i) => (i === index ? { ...item, on: !item.on } : item)));
  };

  const addReq = () => {
    if (!reqText.trim()) return;
    setReqs(prev => [...prev, { t: reqText.trim(), on: true, custom: true }]);
    setReqText('');
    setAddOpen(false);
  };

  const delReq = (index: number) => {
    if (reqs.length <= 1) return;
    setReqs(prev => prev.filter((_, i) => i !== index));
  };

  const openNote = (name: string) => {
    setNoteTarget(name);
    setNoteText(notes[name] ?? '');
  };

  const saveNote = () => {
    if (!noteTarget) return;
    setNotes(prev => {
      const next = { ...prev };
      if (noteText.trim()) next[noteTarget] = noteText.trim();
      else delete next[noteTarget];
      return next;
    });
    setNoteTarget(null);
  };

  const onReqs = reqs.filter(item => item.on);
  const noteEntries = Object.entries(notes).filter(([, value]) => value);

  return (
    <section className="sany-page">
      <PageHead
        title="派发任务"
        sub="选择负责人与其责任单元，说明规划意图后下发；负责人上传材料即自动开始分析"
      />

      <div className="sany-grid g2 sany-align-start">
        <div>
          <div className="sany-sec__h"><div className="sany-sec__t">新建派发</div></div>
          <Card className="sany-card--pad">
            <div className="sany-fld">
              <label>任务名称<span className="sany-req">*</span></label>
              <input value={title} onChange={event => setTitle(event.target.value)} placeholder="例：智能家居业务单元 2027—2029 规划" />
            </div>
            <div className="sany-fld">
              <label>规划意图<span className="sany-req">*</span></label>
              <textarea rows={3} value={intent} onChange={event => setIntent(event.target.value)} />
              <div className="sany-fld__hint">这段文字会随任务下发，并作为解析材料时的方向指引</div>
            </div>
            <div className="sany-frow">
              <div className="sany-fld">
                <label>规划周期</label>
                <input value={period} onChange={event => setPeriod(event.target.value)} />
              </div>
              <div className="sany-fld">
                <label>提交截止</label>
                <input type="date" value={deadline} onChange={event => setDeadline(event.target.value)} />
              </div>
            </div>
            <div className="sany-fld">
              <label>选择负责人与责任单元<span className="sany-req">*</span></label>
              {owners.map(member => {
                const assigned = tasks.some(task => task.owner === member.name);
                return (
                  <div className={`sany-chkbx ${assigned ? 'disabled' : ''}`} key={member.id}>
                    <input
                      type="checkbox"
                      checked={assigned || selected.includes(member.id)}
                      disabled={assigned}
                      onChange={() => toggleOwner(member.id)}
                    />
                    <div className="sany-grow">
                      <div className="sany-row sany-gap8">
                        <span className="sany-strong">{member.name}</span>
                        <Tag tone="line">{member.unit}</Tag>
                        {assigned ? <Tag tone="g">已派发</Tag> : null}
                      </div>
                      <div className="sany-small">{member.title}</div>
                      {notes[member.name] ? <div className="sany-small sany-mt4">个别要求：{notes[member.name]}</div> : null}
                    </div>
                    <button type="button" className="sany-link" onClick={() => openNote(member.name)}>
                      {notes[member.name] ? '改个别要求' : '＋个别要求'}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="sany-fld" style={{ marginBottom: 0 }}>
              <div className="sany-row sany-mb8">
                <label>对负责人的要求</label>
                <span className="sany-spacer" />
                <button type="button" className="sany-link" onClick={() => setAddOpen(true)}>＋ 新增要求</button>
              </div>
              {reqs.map((item, index) => (
                <div className="sany-chkbx sany-chkbx--tight" key={`${item.t}-${index}`}>
                  <input type="checkbox" checked={item.on} onChange={() => toggleReq(index)} />
                  <span className={`sany-grow ${item.on ? '' : 'sany-muted'}`}>{item.t}</span>
                  {item.custom ? <Tag tone="c">自定义</Tag> : null}
                  <button type="button" className="sany-link sany-muted" onClick={() => delReq(index)}>✕</button>
                </div>
              ))}
              <div className="sany-fld__hint">要求会显示在负责人的上传页与任务书里，作为材料齐备度的判断依据；取消勾选则不随任务下发</div>
            </div>
            <Btn tone="pri" block style={{ marginTop: 16 }} disabled={!selected.length} onClick={() => setConfirmOpen(true)}>下发任务</Btn>
          </Card>
        </div>

        <div>
          <div className="sany-sec__h">
            <div className="sany-sec__t">已派发任务</div>
            <div className="sany-sec__a"><span className="sany-small">{tasks.length} 项</span></div>
          </div>
          <div className="sany-stack">
            {tasks.map(req => (
              <Card className="sany-card--pad" key={req.id}>
                <div className="sany-row sany-mb8">
                  <span className="sany-mono sany-small">{req.id}</span>
                  <Tag tone="v">{req.type}</Tag>
                  <span className="sany-spacer" />
                  <StatusTag status={req.status} />
                </div>
                <div className="sany-strong sany-mb4">{req.title}</div>
                <div className="sany-row sany-gap12">
                  <span className="sany-small">{req.owner}</span>
                  <span className="sany-small">截止 {req.deadline.slice(5)}</span>
                  <span className="sany-spacer" />
                  <span className="sany-small">{req.docs} 份材料 · 缺口 {req.gaps} 项</span>
                </div>
              </Card>
            ))}
          </div>
          {availableOwners.length ? (
            <div className="sany-mt12">
              <Alert tone="w" icon="!">{availableOwners.map(member => member.name).join('、')} 已加入组织但尚未派发任务。</Alert>
            </div>
          ) : null}
        </div>
      </div>

      <Modal
        open={addOpen}
        title="新增要求项"
        sub="会随任务一起下发给负责人"
        onClose={() => setAddOpen(false)}
        footer={(
          <>
            <Btn onClick={() => setAddOpen(false)}>取消</Btn>
            <Btn tone="pri" onClick={addReq}>添加</Btn>
          </>
        )}
      >
        <div className="sany-fld">
          <label>要求内容<span className="sany-req">*</span></label>
          <input value={reqText} onChange={event => setReqText(event.target.value)} placeholder="例：成本口径须与财务中心一致，不得自行调整" />
          <div className="sany-fld__hint">写成负责人能直接照做的一句话，不要用「规范」「合理」这类无法判断的词</div>
        </div>
        <Alert icon="i">要求会显示在负责人的上传页与任务书里，作为判断材料是否齐备的依据。</Alert>
      </Modal>

      <Modal
        open={!!noteTarget}
        title="个别要求"
        sub={`${noteTarget ?? ''} · 仅对这位负责人生效`}
        onClose={() => setNoteTarget(null)}
        footer={(
          <>
            <Btn onClick={() => setNoteTarget(null)}>取消</Btn>
            <Btn tone="pri" onClick={saveNote}>保存</Btn>
          </>
        )}
      >
        <div className="sany-fld">
          <label>补充要求</label>
          <textarea rows={4} value={noteText} onChange={event => setNoteText(event.target.value)} placeholder="例：物联平台属培育型业务，里程碑与客户数需分列，不要只报收入" />
          <div className="sany-fld__hint">个别要求会与通用要求一起出现在这位负责人的任务书里，优先级更高。</div>
        </div>
      </Modal>

      <Modal
        open={confirmOpen}
        title="确认下发任务"
        sub="负责人将收到通知，可立即开始上传材料"
        onClose={() => setConfirmOpen(false)}
        footer={(
          <>
            <Btn onClick={() => setConfirmOpen(false)}>取消</Btn>
            <Btn tone="pri" onClick={() => { if (doAssign()) setConfirmOpen(false); }}>确认下发</Btn>
          </>
        )}
      >
        <Alert tone="g" icon="✓">下发后负责人进入「上传材料」页，上传即触发材料解析，无需其他配置。</Alert>
        <Card className="sany-card--pad sany-card--soft sany-mt12">
            <div className="sany-small sany-mb8"><b>分析方式</b> 上传后自动解析 → 四模块内容生成 → 人工校验</div>
            <div className="sany-small sany-mb8"><b>生成范围</b> 经营回顾 / 市场洞察 / 业务澄清 / 三一规划</div>
            <div className="sany-small"><b>回收方式</b> 负责人校验完成后提交，管理员统一收束</div>
        </Card>
        <div className="sany-strong sany-mt12 sany-mb8">随任务下发的要求（{onReqs.length} 条）</div>
        {onReqs.map(item => (
          <div className="sany-bullet" key={item.t}><span>·</span><span>{item.t}</span></div>
        ))}
        {noteEntries.length ? (
          <>
            <div className="sany-strong sany-mt12 sany-mb8">个别要求</div>
            {noteEntries.map(([name, value]) => (
              <div className="sany-small sany-mb4" key={name}><b>{name}</b>：{value}</div>
            ))}
          </>
        ) : null}
      </Modal>
    </section>
  );
}
