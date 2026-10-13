import { klaApi } from './client';
import { homeAiSessionViewSchema, type HomeAiSessionView } from '@kla-workstation/contracts';
export const homeAiApi={
  list:(conversationId:string,identityId:string)=>klaApi.request<HomeAiSessionView[]>(`/v1/conversations/${conversationId}/home-ai/sessions`,{headers:{'x-identity-id':identityId}}),
  confirm:async(conversationId:string,identityId:string,sessionId:string,expectedRevision:number,kind:'profile'|'report',stageId?:string)=>{
    const result=await klaApi.request<HomeAiSessionView>(`/v1/conversations/${conversationId}/home-ai/sessions/${sessionId}/confirm`,{
      method:'POST',headers:{'x-identity-id':identityId,'idempotency-key':crypto.randomUUID()},
      body:JSON.stringify({expectedRevision,kind,stageId}),
    });
    if(result.ok) return {...result,data:homeAiSessionViewSchema.parse(result.data)};
    return result;
  },
};
