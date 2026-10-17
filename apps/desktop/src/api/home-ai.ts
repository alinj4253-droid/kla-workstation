import { klaApi } from './client';
import { homeAiCurrentSchema, homeAiSessionViewSchema, homeAiReviewEntrySchema, type HomeAiReviewEntry, type HomeAiCurrent, type HomeAiCurrentOperation, type HomeAiSessionView } from '@kla-workstation/contracts';
export const homeAiApi={
  reviewEntry:async(conversationId:string,identityId:string)=>{
    const result=await klaApi.request<HomeAiReviewEntry>(`/v1/conversations/${conversationId}/home-ai/review-entry`,{headers:{'x-identity-id':identityId}});
    return result.ok?{...result,data:homeAiReviewEntrySchema.parse(result.data)}:result;
  },
  list:(conversationId:string,identityId:string)=>klaApi.request<HomeAiSessionView[]>(`/v1/conversations/${conversationId}/home-ai/sessions`,{headers:{'x-identity-id':identityId}}),
  current:async(conversationId:string,identityId:string)=>{
    const result=await klaApi.request<HomeAiCurrent>(`/v1/conversations/${conversationId}/home-ai/current`,{headers:{'x-identity-id':identityId}});
    return result.ok?{...result,data:homeAiCurrentSchema.parse(result.data)}:result;
  },
  updateCurrent:async(conversationId:string,identityId:string,input:HomeAiCurrentOperation,idempotencyKey:string)=>{
    const result=await klaApi.request<HomeAiCurrent>(`/v1/conversations/${conversationId}/home-ai/current`,{
      method:'POST',headers:{'x-identity-id':identityId,'idempotency-key':idempotencyKey},body:JSON.stringify(input),
    });
    return result.ok?{...result,data:homeAiCurrentSchema.parse(result.data)}:result;
  },
  confirm:async(conversationId:string,identityId:string,sessionId:string,expectedRevision:number,expectedBindingVersion:number,kind:'profile'|'report',idempotencyKey:string,stageId?:string)=>{
    const result=await klaApi.request<HomeAiSessionView>(`/v1/conversations/${conversationId}/home-ai/sessions/${sessionId}/confirm`,{
      method:'POST',headers:{'x-identity-id':identityId,'idempotency-key':idempotencyKey},
      body:JSON.stringify({expectedRevision,expectedBindingVersion,kind,stageId}),
    });
    if(result.ok) return {...result,data:homeAiSessionViewSchema.parse(result.data)};
    return result;
  },
};
