import { useEffect, useRef, useState } from 'react';
import type { HomeAiCurrent, HomeAiCurrentOperation, HomeAiSessionView } from '@kla-workstation/contracts';
import { homeAiApi } from '../api/home-ai';
import { MarkdownMessage } from '../components/MarkdownMessage';

type PendingAction = { key:string } & ({type:'binding';input:HomeAiCurrentOperation}|{type:'confirm';sessionId:string;revision:number;bindingVersion:number;kind:'profile'|'report';stageId?:string});
const shortRole=(name:string)=>name.length>24?`${name.slice(0,24)}…`:name||'未命名岗位';
const sessionLabel=(s:HomeAiCurrent['sessions'][number])=>`${s.sessionId.slice(0,8)} · ${shortRole(s.roleName)} · ${s.createdAt.replace('T',' ').slice(0,16)}`;

export function HomeAiReview({conversationId,identityId}:{conversationId:string;identityId:string}) {
  const [open,setOpen]=useState(false),[binding,setBinding]=useState<HomeAiCurrent|null>(null),[selected,setSelected]=useState('');
  const [history,setHistory]=useState<HomeAiSessionView|null>(null),[roleName,setRoleName]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[acknowledged,setAcknowledged]=useState(false),[retryable,setRetryable]=useState(false);
  const generation=useRef(0),pending=useRef<PendingAction|null>(null);
  useEffect(()=>{generation.current++;setOpen(false);setBinding(null);setSelected('');setHistory(null);setRoleName('');setMessage('');setAcknowledged(false);setBusy(false);setRetryable(false);pending.current=null;
    return ()=>{generation.current++;};},[conversationId,identityId]);
  const selectedId=selected||binding?.session?.sessionId||'';
  const viewed=selectedId===binding?.session?.sessionId?binding.session:history?.sessionId===selectedId?history:null;
  const canConfirm=Boolean(binding?.status==='active'&&viewed&&binding.session?.sessionId===viewed.sessionId&&binding.session.revision===viewed.revision);
  async function refresh(notice='') {
    const revision=++generation.current;setBusy(true);setMessage(notice);setAcknowledged(false);setHistory(null);
    try {
      const result=await homeAiApi.current(conversationId,identityId);
      if(revision!==generation.current)return;
      if(result.ok){
        setBinding(result.data);pending.current=null;setRetryable(false);
        const retained=selected&&result.data.sessions.some(s=>s.sessionId===selected)?selected:'';setSelected(retained);
        if(retained&&retained!==result.data.session?.sessionId){
          const previous=await homeAiApi.list(conversationId,identityId);
          if(revision!==generation.current)return;
          if(previous.ok)setHistory(previous.data.find(s=>s.sessionId===retained)??null);else setMessage(previous.message);
        }
      }else {setBinding(null);setMessage(result.message);}
    }catch{if(revision===generation.current){setBinding(null);setMessage('诊断读取失败，请刷新重试。');}}
    finally{if(revision===generation.current)setBusy(false);}
  }
  async function browse(sessionId:string) {
    const revision=++generation.current;setSelected(sessionId);setHistory(null);setAcknowledged(false);setMessage('');
    if(sessionId===binding?.session?.sessionId||!sessionId)return;
    setBusy(true);
    try {
      const result=await homeAiApi.list(conversationId,identityId);
      if(revision!==generation.current)return;
      if(result.ok)setHistory(result.data.find(s=>s.sessionId===sessionId)??null);else setMessage(result.message);
    }catch{if(revision===generation.current)setMessage('历史诊断读取失败，请刷新重试。');}
    finally{if(revision===generation.current)setBusy(false);}
  }
  async function submit(action:PendingAction) {
    const revision=++generation.current;pending.current=action;setBusy(true);setRetryable(false);setMessage('');setAcknowledged(false);
    try {
      if(action.type==='binding'){
        const result=await homeAiApi.updateCurrent(conversationId,identityId,action.input,action.key);
        if(revision!==generation.current)return;
        if(!result.ok){await refresh(result.message);return;}
        setBinding(result.data);
        if(action.input.action!=='rename'){setHistory(null);setSelected('');}
        setRoleName('');setMessage(action.input.action==='create'?'已新建空白诊断，旧会话资料未带入。':action.input.action==='activate'?'已设为当前诊断，请重新核对。':'诊断名称已更新。');
      }else{
        const result=await homeAiApi.confirm(conversationId,identityId,action.sessionId,action.revision,action.bindingVersion,action.kind,action.key,action.stageId);
        if(revision!==generation.current)return;
        if(!result.ok){await refresh(result.message);return;}
        setBinding(previous=>previous?{...previous,session:result.data,sessions:previous.sessions.map(s=>s.sessionId===result.data.sessionId?{...s,revision:result.data.revision,profileConfirmed:result.data.profileConfirmed}:s)}:previous);
        setMessage(action.kind==='profile'?'岗位画像已确认。':'报告已确认，请让诊断智能体读取最新报告并保存成果。');
      }
      pending.current=null;
    }catch{if(revision===generation.current){setRetryable(true);setMessage('操作结果尚未核实。可重试上次操作（不会重复创建或确认），或刷新查看服务端状态。');}}
    finally{if(revision===generation.current)setBusy(false);}
  }
  function changeCurrent(action:'create'|'activate'|'rename') {
    if(!binding||busy||retryable)return;
    const name=roleName.trim();
    const input:HomeAiCurrentOperation=action==='create'?{action,expectedBindingVersion:binding.bindingVersion,...(name?{roleName:name}:{})}:action==='activate'?{action,expectedBindingVersion:binding.bindingVersion,sessionId:selectedId}:{action,expectedBindingVersion:binding.bindingVersion,sessionId:selectedId,roleName:name};
    void submit({type:'binding',input,key:crypto.randomUUID()});
  }
  function confirm(kind:'profile'|'report',stageId?:string) {
    if(!viewed||!binding||!acknowledged||!canConfirm||busy||retryable)return;
    void submit({type:'confirm',sessionId:viewed.sessionId,revision:viewed.revision,bindingVersion:binding.bindingVersion,kind,stageId,key:crypto.randomUUID()});
  }
  return <div className="ws-home-ai-review">
    <button type="button" className="ws-text-button" onClick={()=>{setOpen(!open);if(!open)void refresh();}} aria-expanded={open}>诊断核对</button>
    {open&&<section aria-label="家居AI诊断核对">
      <button type="button" disabled={busy} onClick={()=>void refresh()}>刷新诊断</button>
      <p role="status">{busy?'正在处理…':message}</p>
      {retryable&&<button type="button" disabled={busy} onClick={()=>{if(pending.current)void submit(pending.current);}}>重试上次操作</button>}
      {binding&&<>
        <h4>当前诊断</h4>
        {binding.status==='active'&&binding.session&&<p>当前：{sessionLabel(binding.sessions.find(s=>s.sessionId===binding.session?.sessionId)??{sessionId:binding.session.sessionId,roleName:'',createdAt:'',updatedAt:'',revision:binding.session.revision,profileConfirmed:binding.session.profileConfirmed})}</p>}
        {binding.status==='empty'&&<p>暂无诊断。新建空白诊断，或让群聊中的诊断智能体开始首次访谈。</p>}
        {binding.status==='selection_required'&&<p>存在多份历史诊断，尚未设置当前诊断。请选择历史记录并点击“设为当前诊断”，或新建空白诊断。</p>}
        <label>诊断名称（新建时可留空）<input maxLength={60} value={roleName} disabled={busy||retryable} onChange={e=>setRoleName(e.target.value)}/></label>
        <button type="button" disabled={busy||retryable} onClick={()=>changeCurrent('create')}>新建空白诊断</button>
        <p>新建会开始独立访谈，旧岗位、材料和报告不会带入。更正当前岗位请在原会话中说明，无需新建。</p>
        {binding.sessions.length>0&&<>
          <label>查看诊断历史<select disabled={busy||retryable} value={selectedId} onChange={e=>void browse(e.target.value)}>
            <option value="">选择要查看的诊断</option>
            {binding.sessions.map(s=><option key={s.sessionId} value={s.sessionId}>{sessionLabel(s)}</option>)}
          </select></label>
          <p>选择历史记录仅供查看，不会改变当前诊断。</p>
          <button type="button" disabled={busy||retryable||!viewed||canConfirm} onClick={()=>changeCurrent('activate')}>设为当前诊断</button>
          <button type="button" disabled={busy||retryable||!selectedId||!roleName.trim()} onClick={()=>changeCurrent('rename')}>更新诊断名称</button>
        </>}
      </>}
      {viewed&&<>
        <h4>{canConfirm?'核对当前诊断':'历史诊断（只读）'}</h4>
        <dl>{Object.entries(viewed.answers).map(([key,value])=><div key={key}><dt>{({role:'岗位',mission:'职责',handoff:'交接',workflow:'当前流程',capability:'工具与数据',kpi:'绩效',idea:'AI想法',success:'期望',constraints:'试点边界',materials:'材料说明'} as Record<string,string>)[key]}</dt><dd>{value}</dd></div>)}</dl>
        <p>材料：{viewed.documents.map(d=>`${d.name}（${d.chunks}条摘录）`).join('、')||'未关联'}</p>
        <label><input type="checkbox" checked={acknowledged} disabled={busy||retryable||!canConfirm} onChange={e=>setAcknowledged(e.target.checked)}/>我已核对当前内容；确认报告时，我认可其中条件、数值和试点方式。</label>
        <button type="button" disabled={busy||retryable||!canConfirm||!acknowledged||viewed.profileConfirmed||!viewed.answers.role||!viewed.answers.mission} onClick={()=>void confirm('profile')}>{viewed.profileConfirmed?'岗位画像已确认':'确认岗位画像'}</button>
        {viewed.scenes.map(scene=><article key={scene.stageId}>
          <h4>{({needs:'需求对接',marketing:'营销锁客',design:'设计方案',quote:'报价',review:'审单',order:'下单',split:'拆单',schedule:'排单',production:'生产制造',quality:'质量检测',logistics:'物流',install:'安装',service:'售后',behavior:'行为审计',economic:'经济审计'} as Record<string,string>)[scene.stageId]} · {scene.grade} · {scene.accepted?'用户已确认':'讨论稿'}</h4>
          <p>{scene.reason}</p>
          <dl>{Object.entries(scene.checks).map(([key,value])=><div key={key}><dt>{({data:'数据条件',rules:'规则与验收',review:'复核责任',access:'试点条件',evidence:'证据核对'} as Record<string,string>)[key]}</dt><dd>{({yes:'具备',no:'不具备',unknown:'待核对'} as Record<string,string>)[value]}：{scene.notes[key]||'未补充说明'}</dd></div>)}</dl>
          <p>测算输入（{scene.source==='measured'?'用户标记实测':'用户估计'}）：{Object.entries(scene.numbers).map(([key,value])=>`${({volume:'月次数',before:'原分钟/次',after:'使用后分钟/次(含复核)',coverage:'覆盖率%',hourly:'人工元/小时',cash:'现金兑现%',cost:'月费用元',setup:'初期投入元'} as Record<string,string>)[key]}=${value===''?'待补':value}`).join('；')}</p>
          <MarkdownMessage content={scene.markdown}/>
          <button type="button" disabled={busy||retryable||!canConfirm||!acknowledged||!scene.canConfirm||scene.accepted} onClick={()=>void confirm('report',scene.stageId)}>确认此报告可试点</button>
        </article>)}
        <p>内容有误请在原诊断会话中纠正；修改会撤销相关确认，必须重新核对。历史记录须先设为当前诊断后才能确认。</p>
      </>}
    </section>}
  </div>;
}
