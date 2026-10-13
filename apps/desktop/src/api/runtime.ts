import {klaApi} from './client';
import type {ConversationDto, CreateConversationRequest, ExecutionLocation} from '@kla-workstation/contracts';
export type RuntimeAgent={id:string;name:string;role:string;modelId?:string|null;model_id?:string|null;modelKeyId?:string|null;model_key_id?:string|null;modelMountInitialized?:boolean;executionLocation?:ExecutionLocation;execution_location?:ExecutionLocation;deviceId?:string|null;device_id?:string|null;enabled:boolean;type:string;version:number};
export type RuntimeDevice={id:string;name:string;platform:string;online:boolean};
export type RuntimeSkill={code:string;name:string;description:string;tool_codes:string[];enabled:boolean};
export type RuntimeTool={code:string;name:string;description:string;location:'server'|'local';deviceOnline:boolean|null};
/** 该 Key 在上游可用的模型；supported=false 表示平台模型目录未收录/已停用，无法挂载。 */
export type RuntimeKeyModel={id:string;name:string;supported:boolean};
export type RuntimeKeyModelSync={items:RuntimeKeyModel[];imported:number;total:number};
export type AgentCapabilities={skills:Array<RuntimeSkill & {mounted:boolean}>;tools:Array<RuntimeTool & {mounted:boolean}>;effectiveTools:string[]};
export const runtimeApi={
  agents:()=>klaApi.request<RuntimeAgent[]>('/v1/agents'),
  groupAgents:(projectId:string,identityId:string)=>klaApi.request<RuntimeAgent[]>(`/v1/projects/${projectId}/agents`,{headers:{'x-identity-id':identityId}}),
  createGroup:(input:CreateConversationRequest,identityId:string)=>klaApi.request<ConversationDto>('/v1/conversations',{method:'POST',body:JSON.stringify(input),headers:{'x-identity-id':identityId}}),
  devices:()=>klaApi.request<RuntimeDevice[]>('/v1/runtime/devices'),
  skills:()=>klaApi.request<RuntimeSkill[]>('/v1/skills'),
  tools:()=>klaApi.request<RuntimeTool[]>('/v1/runtime/tools'),
  agentCapabilities:(agentId:string)=>klaApi.request<AgentCapabilities>(`/v1/agents/${agentId}/capabilities`),
  saveAgentCapabilities:(agentId:string,skillCodes:string[],toolCodes:string[])=>klaApi.request<AgentCapabilities>(`/v1/agents/${agentId}/capabilities`,{method:'PUT',body:JSON.stringify({skillCodes,toolCodes})}),
  saveAgent:(id:string|null,input:{name:string;role:string;modelId:string|null;modelKeyId:string|null;executionLocation:ExecutionLocation;deviceId:string|null;enabled:boolean})=>klaApi.request<RuntimeAgent>(id?`/v1/agents/${id}`:'/v1/agents',{method:id?'PATCH':'POST',body:JSON.stringify(input)}),
  keyModels:(keyId:string)=>klaApi.request<RuntimeKeyModel[]>(`/v1/compute/keys/${keyId}/models`),
  syncKeyModels:(keyId:string)=>klaApi.request<RuntimeKeyModelSync>(`/v1/compute/keys/${keyId}/models/sync`,{method:'POST'}),
  toggleAgent:(id:string,enabled:boolean)=>klaApi.request<RuntimeAgent>(`/v1/agents/${id}`,{method:'PATCH',body:JSON.stringify({enabled})}),
  toggleSkill:(code:string,enabled:boolean)=>klaApi.request<RuntimeSkill>(`/v1/skills/${encodeURIComponent(code)}`,{method:'PATCH',body:JSON.stringify({enabled})}),
  members:(room:string)=>klaApi.request<RuntimeAgent[]>(`/v1/conversations/${room}/agents`),
  addMember:(room:string,agentId:string)=>klaApi.request(`/v1/conversations/${room}/agents`,{method:'POST',body:JSON.stringify({agentId})}),
  removeMember:(room:string,agentId:string)=>klaApi.request(`/v1/conversations/${room}/agents/${agentId}`,{method:'DELETE'}),
};
