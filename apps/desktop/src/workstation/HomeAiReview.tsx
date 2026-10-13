import { useEffect, useRef, useState } from 'react';
import type { HomeAiSessionView } from '@kla-workstation/contracts';
import { homeAiApi } from '../api/home-ai';
import { MarkdownMessage } from '../components/MarkdownMessage';

export function HomeAiReview({conversationId,identityId}:{conversationId:string;identityId:string}) {
  const [open,setOpen]=useState(false),[sessions,setSessions]=useState<HomeAiSessionView[]>([]),[selected,setSelected]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[acknowledged,setAcknowledged]=useState(false);
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setOpen(false);setSessions([]);setSelected('');setMessage('');setAcknowledged(false);setBusy(false);
    return ()=>{generation.current++;};},[conversationId,identityId]);
  const current=sessions.find(s=>s.sessionId===selected)??sessions[0];
  async function refresh() {
    const revision=++generation.current;setBusy(true);setMessage('');setAcknowledged(false);
    try {
      const result=await homeAiApi.list(conversationId,identityId);
      if(revision!==generation.current)return;
      if(result.ok){setSessions(result.data);setSelected(previous=>result.data.some(s=>s.sessionId===previous)?previous:result.data[0]?.sessionId??'');}
      else setMessage(result.message);
    }catch{if(revision===generation.current)setMessage('诊断读取失败，请刷新重试。');}
    finally{if(revision===generation.current)setBusy(false);}
  }
  async function confirm(kind:'profile'|'report',stageId?:string) {
    if(!current||!acknowledged)return;
    const revision=++generation.current;setBusy(true);setMessage('');
    try {
      const result=await homeAiApi.confirm(conversationId,identityId,current.sessionId,current.revision,kind,stageId);
      if(revision!==generation.current)return;
      if(result.ok){setSessions(items=>items.map(s=>s.sessionId===result.data.sessionId?result.data:s));setMessage(kind==='profile'?'岗位画像已确认。':'报告已确认，请让诊断智能体读取最新报告并保存成果。');}
      else {setMessage(result.message);setSessions([]);}
      setAcknowledged(false);
    }catch{if(revision===generation.current)setMessage('确认结果尚未核实，请刷新查看当前状态，不要重复确认。');}
    finally{if(revision===generation.current)setBusy(false);}
  }
  return <div className="ws-home-ai-review">
    <button type="button" className="ws-text-button" onClick={()=>{setOpen(!open);if(!open)void refresh();}} aria-expanded={open}>诊断核对</button>
    {open&&<section aria-label="家居AI诊断核对">
      <button type="button" disabled={busy} onClick={()=>void refresh()}>刷新诊断</button>
      <p role="status">{busy?'正在处理…':message}</p>
      {!busy&&!current&&!message&&<p>暂无诊断。请先从智能体市场安装“家居 AI 机会诊断”，加入群聊后开始访谈。</p>}
      {current&&<>
        <label>诊断会话<select disabled={busy} value={current.sessionId} onChange={e=>{setSelected(e.target.value);setAcknowledged(false);}}>
          {sessions.map((s,index)=><option key={s.sessionId} value={s.sessionId}>诊断 {index+1} · {s.answers.role||'尚未填写岗位'}</option>)}
        </select></label>
        <dl>{Object.entries(current.answers).map(([key,value])=><div key={key}><dt>{({role:'岗位',mission:'职责',handoff:'交接',workflow:'当前流程',capability:'工具与数据',kpi:'绩效',idea:'AI想法',success:'期望',constraints:'试点边界',materials:'材料说明'} as Record<string,string>)[key]}</dt><dd>{value}</dd></div>)}</dl>
        <p>材料：{current.documents.map(d=>`${d.name}（${d.chunks}条摘录）`).join('、')||'未关联'}</p>
        <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e=>setAcknowledged(e.target.checked)}/>我已核对当前内容；确认报告时，我认可其中条件、数值和试点方式。</label>
        <button type="button" disabled={busy||!acknowledged||current.profileConfirmed||!current.answers.role||!current.answers.mission} onClick={()=>void confirm('profile')}>{current.profileConfirmed?'岗位画像已确认':'确认岗位画像'}</button>
        {current.scenes.map(scene=><article key={scene.stageId}>
          <h4>{({needs:'需求对接',marketing:'营销锁客',design:'设计方案',quote:'报价',review:'审单',order:'下单',split:'拆单',schedule:'排单',production:'生产制造',quality:'质量检测',logistics:'物流',install:'安装',service:'售后',behavior:'行为审计',economic:'经济审计'} as Record<string,string>)[scene.stageId]} · {scene.grade} · {scene.accepted?'用户已确认':'讨论稿'}</h4>
          <p>{scene.reason}</p>
          <dl>{Object.entries(scene.checks).map(([key,value])=><div key={key}><dt>{({data:'数据条件',rules:'规则与验收',review:'复核责任',access:'试点条件',evidence:'证据核对'} as Record<string,string>)[key]}</dt><dd>{({yes:'具备',no:'不具备',unknown:'待核对'} as Record<string,string>)[value]}：{scene.notes[key]||'未补充说明'}</dd></div>)}</dl>
          <p>测算输入（{scene.source==='measured'?'用户标记实测':'用户估计'}）：{Object.entries(scene.numbers).map(([key,value])=>`${({volume:'月次数',before:'原分钟/次',after:'使用后分钟/次(含复核)',coverage:'覆盖率%',hourly:'人工元/小时',cash:'现金兑现%',cost:'月费用元',setup:'初期投入元'} as Record<string,string>)[key]}=${value===''?'待补':value}`).join('；')}</p>
          <MarkdownMessage content={scene.markdown}/>
          <button type="button" disabled={busy||!acknowledged||!scene.canConfirm||scene.accepted} onClick={()=>void confirm('report',scene.stageId)}>确认此报告可试点</button>
        </article>)}
        <p>内容有误请在聊天中纠正；修改会撤销相关确认，必须重新核对。</p>
      </>}
    </section>}
  </div>;
}
