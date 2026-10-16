import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { HomeAiCurrent, HomeAiCurrentOperation, HomeAiSessionView } from '@kla-workstation/contracts';
import { homeAiApi } from '../api/home-ai';
import { MarkdownMessage } from '../components/MarkdownMessage';

type PendingAction = { key:string } & ({type:'binding';input:HomeAiCurrentOperation}|{type:'confirm';sessionId:string;revision:number;bindingVersion:number;kind:'profile'|'report';stageId?:string});
const shortRole=(name:string)=>name.length>24?`${name.slice(0,24)}…`:name||'未命名岗位';
const sessionLabel=(s:HomeAiCurrent['sessions'][number])=>`${s.sessionId.slice(0,8)} · ${shortRole(s.roleName)} · ${s.createdAt.replace('T',' ').slice(0,16)}`;
const stageLabels:Record<string,string>={needs:'需求对接',marketing:'营销锁客',design:'设计方案',quote:'报价',review:'审单',order:'下单',split:'拆单',schedule:'排单',production:'生产制造',quality:'质量检测',logistics:'物流',install:'安装',service:'售后',behavior:'行为审计',economic:'经济审计'};
const answerLabels:Record<string,string>={role:'岗位',mission:'职责',handoff:'交接',workflow:'当前流程',capability:'工具与数据',kpi:'绩效',idea:'AI想法',success:'期望',constraints:'试点边界',materials:'材料说明'};

export function HomeAiReview({conversationId,identityId,processing=false}:{conversationId:string;identityId:string;processing?:boolean}) {
  const [open,setOpen]=useState(false),[binding,setBinding]=useState<HomeAiCurrent|null>(null),[selected,setSelected]=useState('');
  const [history,setHistory]=useState<HomeAiSessionView|null>(null),[roleName,setRoleName]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[acknowledged,setAcknowledged]=useState(false),[retryable,setRetryable]=useState(false);
  const generation=useRef(0),pending=useRef<PendingAction|null>(null);
  const [tab,setTab]=useState<'profile'|'reports'|'materials'>('profile'),[stage,setStage]=useState<string|null>(null);
  useEffect(()=>{generation.current++;setOpen(false);setBinding(null);setSelected('');setHistory(null);setRoleName('');setMessage('');setAcknowledged(false);setBusy(false);setRetryable(false);pending.current=null;
    setTab('profile');setStage(null);
    return ()=>{generation.current++;};},[conversationId,identityId]);
  const selectedId=selected||binding?.session?.sessionId||'';
  const viewed=selectedId===binding?.session?.sessionId?binding.session:history?.sessionId===selectedId?history:null;
  const canConfirm=Boolean(binding?.status==='active'&&viewed&&binding.session?.sessionId===viewed.sessionId&&binding.session.revision===viewed.revision);
  const scene=viewed?.scenes.find(item=>item.stageId===stage);
  const currentName=binding?.sessions.find(item=>item.sessionId===binding.session?.sessionId)?.roleName||binding?.session?.answers.role||'未命名诊断';
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
    const revision=++generation.current;setSelected(sessionId);setHistory(null);setAcknowledged(false);setMessage('');setStage(null);
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
        if(action.input.action!=='rename'){setHistory(null);setSelected('');setStage(null);setTab('profile');}
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
  return <Dialog.Root modal={false} open={open} onOpenChange={value=>{setOpen(value);setAcknowledged(false);if(value)void refresh();}}>
    <div className="ws-home-ai-review">
      {processing&&<span role="status">诊断处理中 · </span>}
      <Dialog.Trigger asChild><button type="button" className="ws-text-button">诊断核对</button></Dialog.Trigger>
    </div>
    <Dialog.Portal>
      <Dialog.Content className="ws-home-ai-review-panel" aria-describedby={undefined} onInteractOutside={event=>event.preventDefault()}>
        <header className="ws-home-ai-review-panel__header">
          <div><Dialog.Title>诊断核对</Dialog.Title><p>{binding?.status==='active'?currentName:'当前诊断'}</p></div>
          <div className="ws-home-ai-review-panel__actions">
            <button type="button" disabled={busy} onClick={()=>void refresh()}>刷新诊断</button>
            <Dialog.Close asChild><button type="button" aria-label="关闭诊断核对">关闭</button></Dialog.Close>
          </div>
        </header>
        <div className="ws-home-ai-review-panel__body" aria-busy={busy}>
          {(busy||message)&&<p role="status" className="ws-home-ai-review-panel__notice">{busy?'正在处理…':message}</p>}
          {retryable&&<button type="button" disabled={busy} onClick={()=>{if(pending.current)void submit(pending.current);}}>重试上次操作</button>}
          {binding&&<>
            <h3 className="ws-home-ai-review-panel__eyebrow">当前诊断</h3>
            {binding.status==='empty'&&<p>暂无诊断。新建空白诊断，或让群聊中的诊断智能体开始首次访谈。</p>}
            {binding.status==='selection_required'&&<p className="ws-home-ai-review-panel__notice">存在多份历史诊断，尚未设置当前诊断。请选择历史记录并点击“设为当前诊断”，或新建空白诊断。</p>}
            <details className="ws-home-ai-review-panel__management" open={binding.status!=='active'?true:undefined}>
              <summary>管理诊断</summary>
              {binding.session&&<details><summary>当前诊断详情</summary><p>{sessionLabel(binding.sessions.find(s=>s.sessionId===binding.session?.sessionId)??{sessionId:binding.session.sessionId,roleName:currentName,createdAt:'',updatedAt:'',revision:binding.session.revision,profileConfirmed:binding.session.profileConfirmed})}</p></details>}
              <label>诊断名称（新建时可留空）<input maxLength={60} value={roleName} disabled={busy||retryable} onChange={e=>setRoleName(e.target.value)}/></label>
              <button type="button" disabled={busy||retryable} onClick={()=>changeCurrent('create')}>新建空白诊断</button>
              <p className="ws-home-ai-review-panel__hint">新建独立访谈，不带入旧岗位、材料和报告。更正当前岗位请在原会话中说明。</p>
              {binding.sessions.length>0&&<>
                <label>查看诊断历史<select disabled={busy||retryable} value={selectedId} onChange={e=>void browse(e.target.value)}>
                  <option value="">选择要查看的诊断</option>
                  {binding.sessions.map(s=><option key={s.sessionId} value={s.sessionId}>{sessionLabel(s)}</option>)}
                </select></label>
                <p className="ws-home-ai-review-panel__hint">选择历史记录仅供查看，不会改变当前诊断。</p>
                <div className="ws-home-ai-review-panel__actions">
                  <button type="button" disabled={busy||retryable||!viewed||canConfirm} onClick={()=>changeCurrent('activate')}>设为当前诊断</button>
                  <button type="button" disabled={busy||retryable||!selectedId||!roleName.trim()} onClick={()=>changeCurrent('rename')}>更新诊断名称</button>
                </div>
              </>}
            </details>
          </>}
          {viewed&&<>
            <p className="ws-home-ai-review-panel__state">{canConfirm?'核对当前诊断':'历史诊断（只读）'} · {viewed.profileConfirmed?'画像已确认':'画像待确认'} · {viewed.scenes.filter(item=>!item.accepted).length} 份报告待核对</p>
            <nav className="ws-home-ai-review-panel__tabs" aria-label="诊断核对分类">
              {(['profile','reports','materials'] as const).map(value=><button type="button" key={value} aria-pressed={tab===value} onClick={()=>{setTab(value);setAcknowledged(false);}}>{value==='profile'?'岗位画像':value==='reports'?`场景报告（${viewed.scenes.length}）`:`关联材料（${viewed.documents.length}）`}</button>)}
            </nav>
            {tab==='profile'&&<section aria-label="岗位画像">
              <h3>岗位画像</h3>
              <dl>{Object.entries(viewed.answers).filter(([key])=>key==='role'||key==='mission').map(([key,value])=><div key={key}><dt>{answerLabels[key]}</dt><dd>{value}</dd></div>)}</dl>
              {!viewed.answers.role&&!viewed.answers.mission&&<p>暂无岗位画像，请先在诊断会话中补充岗位与职责。</p>}
              {Object.keys(viewed.answers).some(key=>key!=='role'&&key!=='mission')&&<details><summary>展开完整画像</summary><dl>{Object.entries(viewed.answers).filter(([key])=>key!=='role'&&key!=='mission').map(([key,value])=><div key={key}><dt>{answerLabels[key]||key}</dt><dd>{value}</dd></div>)}</dl></details>}
              <div className="ws-home-ai-review-panel__confirmation">
                <label><input type="checkbox" checked={acknowledged} disabled={busy||retryable||!canConfirm||viewed.profileConfirmed} onChange={e=>setAcknowledged(e.target.checked)}/>我已核对本次岗位画像。</label>
                <button className="ws-home-ai-review-panel__primary" type="button" disabled={busy||retryable||!canConfirm||!acknowledged||viewed.profileConfirmed||!viewed.answers.role||!viewed.answers.mission} onClick={()=>void confirm('profile')}>{viewed.profileConfirmed?'岗位画像已确认':'确认岗位画像'}</button>
              </div>
            </section>}
            {tab==='reports'&&<section aria-label="场景报告">
              <h3>场景报告</h3>
              {!viewed.scenes.length&&<p>暂无场景报告，完成访谈后可在此核对。</p>}
              {!scene&&<div className="ws-home-ai-review-panel__reports">{viewed.scenes.map(item=><button type="button" key={item.stageId} onClick={()=>{setStage(item.stageId);setAcknowledged(false);}}>
                <strong>{stageLabels[item.stageId]||item.stageId}</strong><span>{item.grade} · {item.accepted?'用户已确认':item.canConfirm?'待核对':'条件待补充'}</span><span>查看报告 →</span>
              </button>)}</div>}
              {scene&&<article key={`${viewed.sessionId}:${scene.stageId}`}>
                <button type="button" onClick={()=>{setStage(null);setAcknowledged(false);}}>返回报告列表</button>
                <h3>{stageLabels[scene.stageId]||scene.stageId} · {scene.grade} · {scene.accepted?'用户已确认':'讨论稿'}</h3>
                <p>{scene.reason}</p>
                <h4>核对条件</h4>
                <dl>{Object.entries(scene.checks).map(([key,value])=><div key={key}><dt>{({data:'数据条件',rules:'规则与验收',review:'复核责任',access:'试点条件',evidence:'证据核对'} as Record<string,string>)[key]}</dt><dd>{({yes:'具备',no:'不具备',unknown:'待核对'} as Record<string,string>)[value]}：{scene.notes[key]||'未补充说明'}</dd></div>)}</dl>
                <h4>测算输入（{scene.source==='measured'?'用户标记实测':'用户估计'}）</h4>
                <dl className="ws-home-ai-review-panel__numbers">{Object.entries(scene.numbers).map(([key,value])=><div key={key}><dt>{({volume:'月次数',before:'原分钟/次',after:'使用后分钟/次(含复核)',coverage:'覆盖率%',hourly:'人工元/小时',cash:'现金兑现%',cost:'月费用元',setup:'初期投入元'} as Record<string,string>)[key]}</dt><dd>{value===''?'待补':value}</dd></div>)}</dl>
                <details><summary>阅读完整报告与依据</summary><MarkdownMessage content={scene.markdown}/></details>
                {!scene.canConfirm&&!scene.accepted&&<p className="ws-home-ai-review-panel__notice">此报告尚未满足确认条件，请在诊断会话中补充后刷新。</p>}
                <div className="ws-home-ai-review-panel__confirmation">
                  <label><input type="checkbox" checked={acknowledged} disabled={busy||retryable||!canConfirm||!scene.canConfirm||scene.accepted} onChange={e=>setAcknowledged(e.target.checked)}/>我已阅读完整报告，认可其中条件、数值和试点方式。</label>
                  <button className="ws-home-ai-review-panel__primary" type="button" disabled={busy||retryable||!canConfirm||!acknowledged||!scene.canConfirm||scene.accepted} onClick={()=>void confirm('report',scene.stageId)}>{scene.accepted?'此报告已确认':'确认此报告可试点'}</button>
                </div>
              </article>}
            </section>}
            {tab==='materials'&&<section aria-label="关联材料"><h3>关联材料</h3>{viewed.documents.length?<ul>{viewed.documents.map((d,index)=><li key={index}>{d.name}（{d.chunks}条摘录）</li>)}</ul>:<p>未关联材料。</p>}</section>}
            <p className="ws-home-ai-review-panel__hint">内容有误请在原诊断会话中纠正；修改会撤销相关确认，必须重新核对。历史记录须先设为当前诊断后才能确认。</p>
          </>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
