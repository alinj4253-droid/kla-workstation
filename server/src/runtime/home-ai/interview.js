// Extracted from testintent/ai-opportunity/interview.js; browser and model transport excluded.
import {STAGES,evidenceFor} from "./catalog.js";
import {INDUSTRY_QUESTIONS} from "./industry.js";
export const VERSION='0.7.0';
export const QUESTIONS=[
{id:'role',section:'认识您的岗位',label:'组织位置与岗位',text:'先认识一下您：请输入您的岗位名称。',hint:'可输入岗位关键词，或从本机组织目录选择预设岗位。岗位名称不需要填写职责。'},
{id:'mission',section:'认识您的岗位',label:'职责、权限与痛点',text:'您的职责和决策边界是什么？最近最头疼的一次业务卡在哪里？',hint:'这里先说职责、协作对象、能决定和必须请他人确认的事；具体重复动作和交接下一题再聊。'},
{id:'handoff',section:'了解最近一次业务',label:'最小重复动作与交接',text:'选一笔最近的业务：您最不想重复做的一个动作是什么？它接收什么信息，交付什么结果给谁？',hint:'只聚焦一个动作，说明输入、输出和交接人即可；不必重复上一题的职责或痛点。'},
{id:'workflow',section:'了解最近一次业务',label:'当前基线与错误边界',text:'这个动作现在怎样完成、通常花多久、最容易在哪一步出错？',hint:'按实际顺序描述处理、复核和退回；请区分已有记录与个人估计。样本材料可留到最后一题再说明。'},
{id:'capability',section:'了解实际工作',label:'技能、工具与数据',text:'做好这项工作要会什么？您现在用哪些工具，能拿到哪些数据？',hint:'例如工艺经验、Excel、CAD、ERP；数据归谁所有、能否导出、更新频率和缺失情况。'},
{id:'kpi',section:'了解实际工作',label:'绩效与现状',text:'您现在用什么业务指标判断这项工作做得好不好？当前水平大约是多少？',hint:'例如耗时、返工率、交期或一次安装完成率。这里只记录现状口径，AI试点目标下一阶段再定；没有记录可说明是估计。'},
{id:'idea',section:'听听您的想法',label:'您希望AI做什么',text:'在刚才那个动作里，您希望AI帮您承担哪一部分？',hint:'不用了解技术。可以直接说希望AI做的辅助，不必再完整复述动作、交接和现有流程。'},
{id:'success',section:'听听您的想法',label:'目标与期望形式',text:'AI给出什么样的结果、以什么形式出现，您才愿意使用？',hint:'例如手机上传后得到待确认清单。这里描述使用体验和验收方式，不必重复当前绩效数字。'},
{id:'constraints',section:'先小范围试点',label:'负责人、兜底与复盘',text:'如果先小范围试点，谁负责推进？不符合预期时怎样退回人工，何时复盘决定推广或停用？',hint:'已有样本可直接引用前面提到的材料；这里只补试点边界、人工兜底和复盘，不需要再次说明全部样本。'},
{id:'materials',section:'看看实际材料',label:'材料说明',text:'若方便，能提供一两份脱敏材料来核对刚才的说法吗？',hint:'可选输入文件、作业规范或合格产出之一。说明它对应的环节和版本；暂时没有也可以继续。'}
];
export const CHECKS=[
{id:'data',label:'数据条件',text:s=>`做“${s.title}”时，相关输入材料是否可获得、可读取且有使用权限？`,yes:'具备，说明材料来源',no:'不具备，需要先补数据'},
{id:'rules',label:'规则与验收',text:s=>`“${s.name}”是否已有明确的作业规则、产出模板及验收要求？请说明适用版本和例外。`,yes:'具备，说明规则及验收',no:'不具备，需先梳理'},
{id:'review',label:'复核与责任',text:s=>`AI给出“${s.output}”后，谁在业务生效前复核？错误怎样阻断或退回？`,yes:'具备，可先人工复核',no:'无法复核或不允许人工把关'},
{id:'access',label:'试点条件',text:()=> '能否先用脱敏文件导入导出做小范围试点？谁负责、何时开始、需要什么系统配合？',yes:'可以，说明负责人和方式',no:'暂时不能，需要系统改造'}
];
export function freshInterview(){return {version:VERSION,answers:{},history:[],documents:[],documentsRevision:0,followups:[],custom:[],phase:'interview',index:0,round:1,profileConfirmed:false,selected:'',scenes:{},sceneStep:0,accepted:false,confirmedScenes:{},revision:0,navigation:[],ai:null,industry:null,industryConsent:false,industryConfirmed:[],industryModelConsent:false,organizationSelection:null,organizationDrafts:{},organizationEdited:{},manualRoleEnabled:false,manualRoleDescription:'',manualRoleDescriptionSeed:'',pendingDrafts:{},pendingFieldDrafts:{},pendingReportDrafts:{},pendingVoiceModes:{},preprocess:null,preprocessCache:{},timing:{version:1,stages:{}},demo:false};}
const inferenceNotice='岗位表未提供正式职责，以下按组织与岗位推断，请核实。';
function categoryFor(item){const leaf=String(item.path||'').split('_').at(-1)||'',specific=`${item.role} ${leaf}`,fallback=`${item.path} ${item.role}`,has=pattern=>pattern.test(specific)||(!/董事|财务|会计|采购|供应链|销售|营销|招商|设计|技术|研发|工程|生产|制造|工艺|设备|品质|质检|培训|人力/.test(specific)&&pattern.test(fallback));if(item.role==='董事长')return ['统筹董事会治理、战略方向与重大事项决策的组织安排','与董事会、经营管理层沟通事项，形成待决议材料和跟踪事项','核对议题资料、决策依据与责任人，保留复核和反馈记录','公司治理、战略判断、风险识别、沟通协调','以议题准备完整性、决议跟踪闭环和风险事项及时报告等实际口径核实'];if(item.role==='副董事长')return ['协助董事长推进董事会治理与分管事项的组织协调','承接分管议题资料，与董事长、董事及管理层协调','核对事项依据、进度和待确认问题，形成跟踪清单','公司治理、战略判断、风险识别、跨部门协调','以分管事项进展、议题准备和反馈闭环等实际口径核实'];if(item.role==='董事')return ['参与董事会治理和重大事项审议，提出独立或分工范围内的意见','接收议题材料，提出需澄清事项并反馈审议意见','核对议题资料、风险提示和后续落实情况','公司治理、业务判断、风险识别、沟通协调','以审议参与、意见反馈和事项跟踪等实际口径核实'];if(has(/审计|监审|监察|风控/))return ['围绕审计、监督或风险事项开展核查和跟踪','收集业务资料，输出问题清单和整改跟踪','按授权范围核对证据、例外和整改责任人','审计方法、证据整理、风险识别、沟通协调','以问题闭环、证据完整性和复核及时性等实际口径核实'];if(has(/财务|会计|资金|税/))return ['支持财务核算、资金或经营分析相关工作','接收业务单据和数据，输出核对结果或分析材料','核对口径、凭证、版本和待确认差异','财务基础、数据核对、表格与系统操作','以准确性、及时性、差异闭环等实际口径核实'];if(has(/采购|供应链/))return ['支持供应商、采购或供应链协同相关工作','接收需求、计划或供应信息，输出跟进记录和待确认事项','核对规格、数量、交期、版本和协同责任人','采购知识、供应协同、数据与表格处理','以交期、差异处理和协同闭环等实际口径核实'];if(has(/技术|研发|设计|工程|信息/))return ['支持技术、研发、设计或工程相关工作','接收需求、资料或任务，输出方案、记录或待确认事项','核对需求版本、技术依据、变更和复核责任人','专业技术、资料管理、问题分析、协同沟通','以交付及时性、变更闭环和复核质量等实际口径核实'];if(has(/生产|制造|工艺|设备|品质|质检|车间/))return ['支持生产制造、工艺、设备或质量相关的现场协同','接收订单、工艺或现场信息，输出记录、异常或交接事项','核对工艺版本、数量、异常原因和复核责任人','制造工艺、质量意识、现场协同、系统或表格操作','以异常闭环、交付及时性和质量记录等实际口径核实'];if(has(/销售|营销|招商|零售|渠道|客户|门店/))return ['支持客户、渠道、销售或营销活动的推进','接收客户需求、线索或活动信息，输出跟进记录和协同事项','核对客户需求、版本、来源和交接责任人','客户沟通、产品知识、业务系统或表格操作','以线索跟进、交接及时性和客户反馈等实际口径核实'];if(has(/培训|人力|组织|行政/))return ['支持组织、行政、人力或培训相关工作','接收需求、人员或培训信息，输出安排、记录和跟进事项','核对对象、版本、时间安排和责任人','组织协调、制度流程、沟通与资料管理','以完成及时性、参与反馈和问题闭环等实际口径核实'];return ['结合所在组织支持日常业务推进与跨部门协同','接收上游交办资料，输出处理结果、待确认事项或交接记录','核对输入来源、版本、责任边界和复核人','本岗位专业知识、沟通协调、资料与工具使用','以实际工作质量、时效、协同和问题闭环等口径核实'];}
export function organizationDraft(item){const [mission,handoff,workflow,capability,kpi]=categoryFor(item),label=`${item.path} · ${item.role}`,marker='（根据组织机构及岗位自动生成）';return {mission:`${marker}\n${inferenceNotice}\n组织路径：${label}\n推断职责：${mission}`,handoff:`${marker}\n${inferenceNotice}\n推断交接：${handoff}`,workflow:`${marker}\n${inferenceNotice}\n推断工作方式：${workflow}`,capability:`${marker}\n${inferenceNotice}\n推断能力：${capability}`,kpi:`${marker}\n${inferenceNotice}\n推断关注点：${kpi}`};}
export function selectOrganizationRole(state,item){const previous=state.organizationSelection;state.organizationSelection={id:item.id,path:item.path,department:item.department,role:item.role,headcount:item.headcount,sourceDate:item.sourceDate||''};const drafts=organizationDraft(item),kept=[];state.organizationDrafts=state.organizationDrafts||{};state.organizationEdited=state.organizationEdited||{};for(const [field,value] of Object.entries(drafts)){if(state.answers[field]!==undefined||state.organizationEdited[field]){kept.push(field);continue;}state.organizationDrafts[field]=value;}return {changed:!previous||previous.id!==item.id,kept};}
export function clearOrganizationRole(state){state.organizationSelection=null;state.organizationDrafts={};}
export function invalidate(s){s.accepted=false;s.confirmedScenes={};s.completed=false;s.ai=null;s.revision++;}
export function invalidateScene(s,id=s.selected){if(s.confirmedScenes)delete s.confirmedScenes[id];if(id===s.selected)s.accepted=false;s.completed=false;s.ai=null;s.revision++;}
export function stageMatches(s){
 const roleText=[s.answers.role,s.organizationSelection?.path,s.organizationSelection?.role].filter(Boolean).join(' ').toLowerCase();
 const taskText=[s.answers.mission,s.answers.handoff,s.answers.workflow,s.answers.idea,...s.followups.map(f=>f.answer)].filter(value=>typeof value==='string'&&!value.startsWith('（根据组织机构及岗位自动生成）')).join(' ').toLowerCase();
 const auditRole=/审计|内控|监审|监察|风控/.test(roleText),financialTask=/成本|收款|付款|发票|对账|毛利|采购|回款/.test(taskText),controlTask=/审批|权限|操作|日志|变更|合规|内控|风险|审计/.test(taskText);
 return STAGES.map((x,i)=>{let match=x.keys.reduce((v,k)=>v+(taskText.includes(k.toLowerCase())?3:0),0)+(taskText.includes(x.name)?5:0);if(roleText.includes(x.name.toLowerCase()))match+=10;if(auditRole&&x.id==='behavior')match+=controlTask?14:10;if(auditRole&&x.id==='economic')match+=financialTask?14:4;return {...x,match,order:i};}).sort((a,b)=>b.match-a.match||a.order-b.order);
}
export function candidates(s){return stageMatches(s).slice(0,3);}
export function currentStage(s){return STAGES.find(x=>x.id===s.selected)||candidates(s)[0];}
export function assessment(s,id=s.selected){return s.scenes[id]||(s.scenes[id]={checks:{},notes:{},numbers:{},source:'estimate',target:'',customTitle:'',action:'',goal:'',conditions:'',form:'',route:'',metric:'',trial:''});}
export function normalizedAnswer(value){return String(value??'').trim().replace(/\s+/g,' ').toLocaleLowerCase('zh-CN');}
export function record(s,q,answer,{sceneOnly=false}={}){const previous=q.id?s.answers[q.id]:[...(s.followups||[])].reverse().find(item=>item.question===q.text)?.answer;if(!sceneOnly&&String(previous??'').trim()===String(answer??'').trim())return false;if(sceneOnly)invalidateScene(s);else invalidate(s);s.history.push({question:q.text,answer,time:new Date().toISOString(),round:s.round});if(q.id)s.answers[q.id]=answer;else s.followups.push({question:q.text,answer});return true;}
export function followupQuestion(s){
 const missing=QUESTIONS.filter(q=>!s.answers[q.id]||/^(暂不清楚|待确认|暂时没有|跳过)$/.test(s.answers[q.id])).slice(0,3);
 if(s.custom.length)return {text:s.custom.shift(),hint:'这是结合您前面回答提出的追问。请说明事实依据，或直接纠正不准确的地方。'};
 const first=candidates(s)[0];const evidence=evidenceFor(first,s.documents)[0];
 const actualAuditWork=[s.answers.mission,s.answers.handoff,s.answers.workflow,s.answers.idea,...s.followups.map(item=>item.answer)].filter(value=>typeof value==='string'&&!value.startsWith('（根据组织机构及岗位自动生成）')).join(' ');
 if(/审计|内控|监审|监察|风控/.test(`${s.answers.role||''} ${s.organizationSelection?.path||''}`)&&!/审计|内控|审批|权限|操作日志|变更|合规|风险|成本|收款|付款|发票|对账|毛利|采购|回款/.test(actualAuditWork))return {text:'这次审计准备核查的对象和范围是什么？请说明可取得的资料、抽样口径，以及由谁复核和确认例外。',hint:'先从实际审计任务和证据边界开始，不预设订单或异常结论。'};
 return {text:INDUSTRY_QUESTIONS[first.id],hint:(evidence?`材料“${evidence.source}” / ${evidence.location}提到：“${evidence.quote.slice(0,90)}”。请解释它与实际流程的关系。`:'定制家居的订单、版本和交接关系会影响AI能否可靠工作。')+(missing.length?' 仍待明确：'+missing.map(x=>x.label).join('、')+'。':'' )};
}
export const NUMBERS=[['volume','每月任务量（次）'],['before','原来每次耗时（分钟）'],['after','使用后每次总耗时（含复核，分钟）'],['coverage','预计覆盖率（%）'],['hourly','综合人工成本（元/小时）'],['cash','可兑现为现金的比例（%）'],['cost','月运行维护费用（元）'],['setup','一次性投入（元）']];
export function valueEstimate(n){
 const needed=['volume','before','after','coverage'];
 const read=k=>n[k]!==''&&n[k]!==undefined&&n[k]!==null?Number(n[k]):null;
 const vals=Object.fromEntries(NUMBERS.map(([k])=>[k,read(k)]));
 if(Object.values(vals).some(v=>v!==null&&(!Number.isFinite(v)||v<0||v>1e9))||vals.coverage>100||vals.cash>100)return {error:'请填写有效的非负数；比例不能超过100%。'};
 if(needed.some(k=>vals[k]===null))return {complete:false,text:'待测算：需要任务量、前后耗时与覆盖率。'};
 const hours=vals.volume*(vals.before-vals.after)*vals.coverage/6000;
 const money=['hourly','cash','cost','setup'].every(k=>vals[k]!==null);
 const capacity=money?hours*vals.hourly:null;
 const net=money?(capacity<0?capacity:capacity*vals.cash/100)-vals.cost:null;
 const payback=net>0?vals.setup/net:null;
 return {complete:true,hours,net,payback,money,capacity,text:`预计每月${hours>=0?'节省':'增加'} ${Math.abs(hours).toFixed(1)} 小时`+(money?`；月净现金收益 ${Math.round(net).toLocaleString('zh-CN')} 元`:'；现金收益待核算')};
}
export const GRADES={I:'信息不足 · 暂不评级',S:'超级适合且价值明显',A:'A · 适合，优先试点',B:'B · 有条件适合',C:'C · 暂不优先',D:'D · 当前方式不适合'};
export const TIME_STAGES=['认识岗位','了解工作','找到机会','一起确认'];
export function timingStage(s){if(s.phase==='interview')return s.index<2?'认识岗位':s.index<6?'了解工作':'找到机会';return ['clarify','profile','refine','candidates'].includes(s.phase)?'找到机会':'一起确认';}
export function settleForegroundTime(s,{now=Date.now()}={}){const timing=s.timing;if(!timing?.last)return timing;const previous=timing.last,elapsed=now-previous.now;if(previous.active&&elapsed>=0&&elapsed<=5000)timing.stages[previous.stage]=(timing.stages[previous.stage]||0)+elapsed;timing.last=null;return timing;}
export function trackForegroundTime(s,{now=Date.now(),active=true}={}){const timing=s.timing||(s.timing={version:1,stages:{}});settleForegroundTime(s,{now});if(!active||s.completed)return timing;timing.last={now,stage:timingStage(s),active:true};return timing;}
export function timingSummary(s){const timing=s.timing;if(!timing?.stages)return TIME_STAGES.map(name=>[name,null]);return TIME_STAGES.map(name=>[name,Number.isFinite(timing.stages[name])?timing.stages[name]:null]);}
export function judge(s,stage){
 const a=assessment(s,stage.id),v=valueEstimate(a.numbers),ev=evidenceFor(stage,s.documents),checks=a.checks;
 if(checks.review==='no')return {grade:'D',reason:'当前方案无法在业务生效前复核和阻断错误，应先改为有人负责的辅助流程。',value:v};
 if(v.complete&&(v.hours<=0||(v.money&&v.net<0)))return {grade:'C',reason:'当前参数下未体现正向工时或现金收益；应缩小任务、改进流程或核实成本。',value:v};
 if(checks.access==='no')return {grade:'C',reason:'目前需要先解决系统或组织条件，小范围验证尚无法启动。',value:v};
 const ready=CHECKS.every(k=>checks[k.id]==='yes');
 if(!ready||!v.complete||v.error)return {grade:'I',reason:'信息不足，暂不评级；请补齐样本、规则、复核责任、试点访问条件和同口径工时基线。',value:v};
 if(a.source==='measured'&&ev.length&&v.money&&v.net>0&&Number(a.target)>0&&v.hours>=Number(a.target)&&checks.evidence==='yes')return {grade:'S',reason:'条件已逐项确认，有相关样本及用户标记的实测参数，达到其节省工时目标且月净收益为正；仍需试点验证代表性。',value:v};
 return {grade:'A',reason:'用户确认试点条件具备，工时测算为正；样本代表性、实际效果或完整经济性仍待验证。',value:v};
}
function pilotGaps(s,a,v){const gaps=[];if(a.checks?.data!=='yes')gaps.push('可用且脱敏的样本');if(a.checks?.rules!=='yes')gaps.push('规则版本和例外口径');if(a.checks?.review!=='yes')gaps.push('业务复核责任');if(a.checks?.access!=='yes')gaps.push('试点访问条件');if(a.checks?.evidence!=='yes')gaps.push('相关证据');if(!v.complete||v.error)gaps.push('同口径工时/成本基线');if(a.source!=='measured')gaps.push('实测数据');const trial=String(a.trial||s.answers.constraints||'');if(!/(负责人|责任人)/.test(trial))gaps.push('试点负责人');if(!/(样本|订单|单据|案例)/.test(trial))gaps.push('试点样本范围');if(!/(复盘|停用|退出|验收)/.test(trial))gaps.push('验收与退出条件');return [...new Set(gaps)];}
export function routeFor(id){
 if(['quote','economic'].includes(id))return '文档解析＋字段抽取＋确定性计算/勾稽＋证据定位＋人工签核';
 if(id==='split')return 'BOM解析＋工艺规则引擎＋CAD几何校验接口＋AI解释＋工艺复核';
 if(id==='schedule')return '订单/产能数据＋约束求解器＋AI解释＋计划员确认';
 if(['production','service'].includes(id))return '文档解析＋检索增强生成（RAG）＋出处引用＋人工确认';
 return '文档解析＋结构化抽取＋规则比对/知识检索＋出处引用＋人工确认';
}
export function report(s,id=s.selected){
 const stage=STAGES.find(x=>x.id===id)||currentStage(s),a=assessment(s,stage.id),j=judge(s,stage),v=j.value;
 const gaps=pilotGaps(s,a,v),evidence=evidenceFor(stage,s.documents);
 return {title:String(a.customTitle||stage.title),grade:GRADES[j.grade],rows:[
 ['场景与目标',`${stage.name}：${a.goal||s.answers.idea||'先验证重复动作能否减少人工耗时'}`],
 ['人机协作',a.action||`${stage.action}；${stage.verify}`],
 ['价值与验收',(v.complete?v.text:'收益待测算')+'；'+(a.metric||stage.metric)+(a.source==='measured'?'（用户标记实测）':'（用户估计，待验证）')],
 ['证据与数据口径',`${evidence.length?'已关联 '+evidence.length+' 条本地材料摘录（仍需核对版本和代表性）':'尚未关联本地材料'}；${a.source==='measured'?'数值由用户标记为实测，仍需按试点口径复核。':'数值为用户估计，不能作为实测结论。'}`],
 ['必要条件',a.conditions||`${stage.input}；规则版本明确；复核责任与数据权限落实`],
 ['应用形式',a.form||'手机/电脑网页：导入脱敏材料，查看带出处的结果并逐项确认'],
 ['技术路线',a.route||routeFor(stage.id)],
 ['试点闭环',a.trial||`${s.answers.constraints||'待业务负责人确认'}；先用脱敏样本，人工复核并可退回；按同口径基线验收，到期复盘决定推广或停用。`],
 ['试点缺口',gaps.length?`尚缺：${gaps.join('、')}。可作为受控小试点的准备项；推广前须补齐并按同口径复测。`:'必要试点字段已填写；仍须在试点中按同口径复测并记录退出决定。']
 ],accepted:!!s.confirmedScenes?.[stage.id]||(id===s.selected&&!!s.accepted),revision:s.revision,round:s.round,stageId:stage.id};
}
export function reportMarkdown(s){const ids=[s.selected,...Object.keys(s.confirmedScenes||{})].filter(Boolean).filter((id,index,all)=>all.indexOf(id)===index);const reports=ids.map(id=>report(s,id));const outcomes=reports.map(r=>`## ${r.title}\n\n${r.grade} · ${r.accepted?'用户已确认可行':'讨论稿，待用户确认'} · 第${r.round}轮\n\n`+r.rows.map(([k,v])=>`**${k}**：${v}`).join('\n\n')).join('\n\n');const groups=[['岗位与职责',['role','mission']],['实际工作',['handoff','workflow','capability','kpi']],['AI想法与试点',['idea','success','constraints','materials']]].map(([name,keys])=>[name,keys.map(k=>s.answers[k]?`- ${QUESTIONS.find(q=>q.id===k)?.label}：${s.answers[k]}`:'').filter(Boolean)]).filter(([,rows])=>rows.length);const summary=s.profileConfirmed?groups.map(([name,rows])=>`## 已确认的${name}\n\n${rows.join('\n')}`).join('\n\n'):'## 已确认的用户信息\n\n岗位画像尚未完成用户确认；不将草稿写入报告。';const followups=(s.followups||[]).filter(item=>typeof item?.question==='string'&&typeof item?.answer==='string'&&item.answer.trim()).map(item=>`- 用户补充（${item.question}）：${item.answer}`);const additions=followups.length?`\n\n## 进一步沟通的补充\n\n${followups.join('\n')}`:'';const timing=timingSummary(s).map(([name,ms])=>`- ${name}：${ms===null?'此前未记录':(ms/60000).toFixed(1)+' 分钟（页面前台停留时间）'}`).join('\n');return `# 家居 AI 诊断结果\n\n${outcomes}\n\n${summary}${additions}\n\n## 阶段耗时\n\n${timing}`;}
