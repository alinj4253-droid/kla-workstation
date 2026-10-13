import {klaApi} from './client';
import type {ConversationDto, CreateConversationRequest, ExecutionLocation} from '@kla-workstation/contracts';
export type RuntimeAgent={id:string;name:string;role:string;modelId?:string|null;model_id?:string|null;modelKeyId?:string|null;model_key_id?:string|null;modelMountInitialized?:boolean;executionLocation?:ExecutionLocation;execution_location?:ExecutionLocation;deviceId?:string|null;device_id?:string|null;enabled:boolean;type:string;version:number};
export type RuntimeDevice={id:string;name:string;platform:string;online:boolean};
export type RuntimeSkill={code:string;name:string;description:string;tool_codes:string[];enabled:boolean};
export type RuntimeTool={code:string;name:string;description:string;location:'server'|'local';deviceOnline:boolean|null};
export type AgentCapabilities={skills:Array<RuntimeSkill & {mounted:boolean}>;tools:Array<RuntimeTool & {mounted:boolean}>;effectiveTools:string[]};
export const runtimeApi={
  agents:()=>klaApi.request<RuntimeAgent[]>('/v1/agents'),
  groupAgents:(projectId:string,identityId:string)=>klaApi.request<RuntimeAgent[]>(`/v1/projects/${projectId}/agents`,{headers:{'x-identity-id':identityId}}),
  createGroup:(input:CreateConversationRequest,identityId:string)=>klaApi.request<ConversationDto>('/v1/conversations',{method:'POST',body:JSON.stringify(input),headers:{'x-identity-id':identityId}}),
  devices:()=>klaApi.request<RuntimeDevice[]>('/v1/runtime/devices'),
  skills:()=>klaApi.request<RuntimeSkill[]>('/v1/skills'),
  tools:()=>klaApi.request<RuntimeTool[]>('/v1/runtime/tools'),
  installHomeAi:()=>klaApi.request<{agentId:string;installed:boolean}>('/v1/runtime/market/home-ai-diagnosis/install',{method:'POST',body:JSON.stringify({}),headers:{'idempotency-key':crypto.randomUUID()}}),
  agentCapabilities:(agentId:string)=>klaApi.request<AgentCapabilities>(`/v1/agents/${agentId}/capabilities`),
  saveAgentCapabilities:(agentId:string,skillCodes:string[],toolCodes:string[])=>klaApi.request<AgentCapabilities>(`/v1/agents/${agentId}/capabilities`,{method:'PUT',body:JSON.stringify({skillCodes,toolCodes})}),
  saveAgent:(id:string|null,input:{name:string;role:string;modelId:string|null;modelKeyId:string|null;executionLocation:ExecutionLocation;deviceId:string|null;enabled:boolean})=>klaApi.request<RuntimeAgent>(id?`/v1/agents/${id}`:'/v1/agents',{method:id?'PATCH':'POST',body:JSON.stringify(input)}),
  keyModels:(keyId:string)=>klaApi.request<Array<{id:string;name:string}>>(`/v1/compute/keys/${keyId}/models`),
  toggleAgent:(id:string,enabled:boolean)=>klaApi.request<RuntimeAgent>(`/v1/agents/${id}`,{method:'PATCH',body:JSON.stringify({enabled})}),
  toggleSkill:(code:string,enabled:boolean)=>klaApi.request<RuntimeSkill>(`/v1/skills/${encodeURIComponent(code)}`,{method:'PATCH',body:JSON.stringify({enabled})}),
  members:(room:string)=>klaApi.request<RuntimeAgent[]>(`/v1/conversations/${room}/agents`),
  addMember:(room:string,agentId:string)=>klaApi.request(`/v1/conversations/${room}/agents`,{method:'POST',body:JSON.stringify({agentId})}),
  removeMember:(room:string,agentId:string)=>klaApi.request(`/v1/conversations/${room}/agents/${agentId}`,{method:'DELETE'}),
};
