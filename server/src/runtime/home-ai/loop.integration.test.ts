import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { runMigrations } from '../../database/migrations.js';
import { PostgresAccountRepository } from '../../repositories/postgres-account-repository.js';
import { ShortTermMemoryService } from '../../memories/short-term.js';
import { AgentLoopWorker } from '../../infrastructure/agent-loop.js';
import { installHomeAi } from './install.js';
import { HomeAiService } from './service.js';
const config=loadConfig();
describe('home AI conversation loop',()=>{
  it.skipIf(!config.databaseUrl)('returns actual tool results to a fixture model and delivers draft then human-confirmed artifacts',async()=>{
    const schema=`kla_home_ai_loop_${randomUUID().replaceAll('-','')}`;
    const pool=new Pool({connectionString:config.databaseUrl,options:`-c search_path=${schema},public`,max:6,connectionTimeoutMillis:5000});
    let worker:AgentLoopWorker|undefined;
    try {
      await runMigrations(pool,schema);const accounts=new PostgresAccountRepository(pool);
      const account=await accounts.register({email:'loop-home@example.test',nickname:'诊断循环',password:'TestPass2026!'});
      const project=await accounts.createProject(account.identity.id,'循环测试'),room=await accounts.createConversation(project.id,'诊断');
      const installed=await installHomeAi(pool,account.identity.id);
      await pool.query("INSERT INTO conversation_agents(conversation_id,agent_id,role) VALUES($1,$2,'member')",[room.id,installed.agentId]);
      let confirmedSession='';const toolNames:string[]=[];
      const completeChat=vi.fn(async(_identity:any,input:any)=>{
        let message:any;
        if(input.requestId.endsWith(':plan')) message={tool_calls:[{id:'plan',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{title:'诊断',instruction:'使用用户提供的审单职责和参数生成报告',agentId:installed.agentId,dependsOn:[]}]})}}]};
        else {
          expect(JSON.stringify(input.messages)).toContain('你没有确认工具');
          expect(input.tools.some((tool:any)=>tool.function.name==='home_ai_session_open')).toBe(true);
          expect(input.tools.some((tool:any)=>tool.function.name==='home_ai_confirm')).toBe(false);
          const replies=input.messages.filter((m:any)=>m.role==='tool').map((m:any)=>JSON.parse(m.content));
          const last=replies.at(-1),sessionId=confirmedSession||last?.sessionId,expectedRevision=last?.revision;
          const draftSteps=[['home_ai_session_open',{}],['home_ai_interview_update',{sessionId,expectedRevision,answerId:'role',answer:'审单主管'}],
            ['home_ai_interview_update',{sessionId,expectedRevision,answerId:'mission',answer:'负责订单复核并由主管签核'}],
            ['home_ai_conditions_update',{sessionId,expectedRevision,stageId:'review',checks:{data:'yes',rules:'yes',review:'yes',access:'yes'},notes:{review:'主管签核'}}],
            ['home_ai_value_estimate',{sessionId,expectedRevision,stageId:'review',numbers:{volume:200,before:25,after:10,coverage:80}}],
            ['home_ai_report_build',{sessionId,stageId:'review'}],['artifact_write',{fileName:'诊断讨论稿.md',content:last?.markdown,mimeType:'text/markdown'}]];
          const confirmedSteps=[['home_ai_report_build',{sessionId:confirmedSession,stageId:'review'}],['artifact_write',{fileName:'诊断确认报告.md',content:last?.markdown,mimeType:'text/markdown'}]];
          const next=(confirmedSession?confirmedSteps:draftSteps)[replies.length];
          if(next){toolNames.push(String(next[0]));message={tool_calls:[{id:`tool-${replies.length}`,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]};}
          else message={content:`报告已保存，成果编号：${last.artifactId}`};
        }
        return {payload:{choices:[{message}]},usage:{inputTokens:1,outputTokens:1},amountUsd:0};
      });
      worker=new AgentLoopWorker(pool,accounts,{completeChat} as never,new ShortTermMemoryService(pool));worker.start(25);
      const trigger=await accounts.createMessage(room.id,account.user.id,'审单主管，负责复核；四项条件具备，月200次，原25分钟，使用后10分钟，覆盖80%。');
      const run=await worker.reserveRun(room.id,trigger.id,'balanced');
      await vi.waitFor(async()=>expect((await accounts.listConversationRuns(room.id)).find(r=>r.id===run.id)?.status).toBe('completed'),{timeout:25000,interval:100});
      const draft=(await accounts.listArtifacts(account.identity.id,room.id))[0];expect(draft.content).toContain('讨论稿');expect(draft.content).toContain('40.0');
      const service=new HomeAiService(pool),scope={identityId:account.identity.id,conversationId:room.id};
      let view=(await service.list(scope))[0];view=await service.confirm(scope,view.sessionId,{expectedRevision:view.revision,kind:'profile'},randomUUID());
      view=await service.confirm(scope,view.sessionId,{expectedRevision:view.revision,kind:'report',stageId:'review'},randomUUID());confirmedSession=view.sessionId;
      const followup=await accounts.createMessage(room.id,account.user.id,'已在界面确认，请保存确认版。');
      const nextRun=await worker.reserveRun(room.id,followup.id,'balanced');
      await vi.waitFor(async()=>expect((await accounts.listConversationRuns(room.id)).find(r=>r.id===nextRun.id)?.status).toBe('completed'),{timeout:15000,interval:100});
      const artifacts=await accounts.listArtifacts(account.identity.id,room.id);
      expect(artifacts).toHaveLength(2);expect(artifacts.find(a=>a.name==='诊断确认报告.md')?.content).toContain('用户已确认可行');
      expect((await accounts.listMessages(room.id)).at(-1)?.metadata?.artifactIds).toHaveLength(1);
      expect(toolNames).toContain('home_ai_report_build');expect(completeChat).toHaveBeenCalled();
    }finally{await worker?.stop();await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
  },60000);
});
