import {klaApi} from './client';
import type {ExecutionLocation} from '@kla-workstation/contracts';
export type RuntimeAgent={id:string;name:string;role:string;modelId?:string|null;model_id?:string|null;executionLocation?:ExecutionLocation;execution_location?:ExecutionLocation;deviceId?:string|null;device_id?:string|null;enabled:boolean;type:string;version:number};
export type RuntimeDevice={id:string;name:string;platform:string;online:boolean};
export type RuntimeSkill={id:string;agent_id:string;agent_name:string;name:string;description:string;definition:{code?:string};enabled:boolean};
export type RuntimeTool={code:string;name:string;description:string;location:'server'|'local';agents:Array<{id:string;name:string;enabled:boolean;deviceOnline:boolean|null}>;deviceOnline:boolean|null};
export const runtimeApi={
  agents:()=>klaApi.request<RuntimeAgent[]>('/v1/agents'),
  devices:()=>klaApi.request<RuntimeDevice[]>('/v1/runtime/devices'),
  skills:()=>klaApi.request<RuntimeSkill[]>('/v1/skills'),
  tools:()=>klaApi.request<RuntimeTool[]>('/v1/runtime/tools'),
  saveAgent:(id:string|null,input:{name:string;role:string;modelId:string|null;executionLocation:ExecutionLocation;deviceId:string|null;enabled:boolean})=>klaApi.request<RuntimeAgent>(id?`/v1/agents/${id}`:'/v1/agents',{method:id?'PATCH':'POST',body:JSON.stringify(input)}),
  toggleAgent:(id:string,enabled:boolean)=>klaApi.request<RuntimeAgent>(`/v1/agents/${id}`,{method:'PATCH',body:JSON.stringify({enabled})}),
  toggleSkill:(id:string,enabled:boolean)=>klaApi.request<RuntimeSkill>(`/v1/skills/${id}`,{method:'PATCH',body:JSON.stringify({enabled})}),
  members:(room:string)=>klaApi.request<RuntimeAgent[]>(`/v1/conversations/${room}/agents`),
  addMember:(room:string,agentId:string)=>klaApi.request(`/v1/conversations/${room}/agents`,{method:'POST',body:JSON.stringify({agentId})}),
  removeMember:(room:string,agentId:string)=>klaApi.request(`/v1/conversations/${room}/agents/${agentId}`,{method:'DELETE'}),
};
