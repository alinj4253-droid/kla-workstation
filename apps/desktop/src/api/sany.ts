import { klaApi, type ApiResult } from './client';

export type SanyRole = 'admin' | 'owner';
export type SanyModuleKey = 'review' | 'market' | 'biz' | 'plan';
export type SanyFieldStatus = 'pending' | 'accepted' | 'edited' | 'rejected' | 'missing';

export type SanyProjectDto = {
  id: string;
  name: string;
  orgName: string;
  planningPeriod: string;
  planYear: string;
  deadline: string | null;
  intent: string;
  status: 'active' | 'archived';
  outputGenerated: boolean;
  outputReleased: boolean;
  deliveryChecks: Record<string, boolean>;
  decisions: Record<string, string>;
  conclusion: string;
};

export type SanyMemberDto = {
  id: string;
  empNo: string;
  name: string;
  title: string;
  unit: string;
  role: SanyRole;
  color: string;
  joined: string;
  status: string;
};

export type SanyTaskDto = {
  id: string;
  code: string;
  title: string;
  unit: string;
  owner: string;
  type: string;
  typeName: string;
  deadline: string;
  assignedAt: string;
  status: string;
  intent: string;
  requirements: string[];
  docs: number;
  prefill: number;
  verified: number;
  gaps: number;
};

export type SanyDocumentDto = {
  id: string;
  taskId: string | null;
  scope: 'company' | 'unit';
  moduleKey: SanyModuleKey;
  name: string;
  ext: string;
  size: string;
  color: string;
  pages: number;
  claims: number;
  fields: number;
};

export type SanyFieldDto = {
  id: string;
  taskId: string | null;
  scope: 'company' | 'unit';
  moduleKey: SanyModuleKey;
  k: string;
  n: string;
  type: 'num' | 'text' | 'table';
  ai: string;
  conf: number;
  src: string;
  status: SanyFieldStatus;
  human?: string;
  gap?: string;
  removed: boolean;
  removedReason?: string;
  custom: boolean;
};

export type SanyIssueDto = {
  id: string;
  code: string;
  level: '阻断' | '重要' | '一般';
  title: string;
  detail: string;
  owner: string;
  status: string;
};

export type SanyOutputVersionDto = {
  v: number;
  at: string;
  by: string;
  status: string;
  summary: string;
  changes: string;
  size: string;
  file: string;
  audit?: string;
  pageNames?: string[];
};

export type SanyOutputDto = {
  key: 'doc' | 'ppt' | 'diag' | 'package';
  name: string;
  description: string;
  note: string;
  versions: SanyOutputVersionDto[];
};

export type SanyFeedbackDto = { id: string; author: string; content: string; createdAt: string };

export type SanyBootstrapDto = {
  project: SanyProjectDto;
  members: SanyMemberDto[];
  tasks: SanyTaskDto[];
  documents: SanyDocumentDto[];
  fields: SanyFieldDto[];
  issues: SanyIssueDto[];
  outputs: SanyOutputDto[];
  feedback: SanyFeedbackDto[];
};

export type SanyDocumentInput = {
  scope: 'company' | 'unit';
  moduleKey: SanyModuleKey;
  taskId?: string | null;
  name: string;
  ext: string;
  size: string;
  color: string;
  pages: number;
  claims: number;
  fields: number;
};

const unwrap = <T,>(result: ApiResult<T>): T => {
  if (!result.ok) throw new Error(result.message || '请求失败');
  return result.data;
};

export const sanyApi = {
  bootstrap: () => klaApi.request<SanyBootstrapDto>('/v1/sany/bootstrap').then(unwrap),
  addMember: (input: { empNo: string; name: string; title: string; unit: string; role?: SanyRole }) =>
    klaApi.request<SanyMemberDto>('/v1/sany/members', { method: 'POST', body: JSON.stringify(input) }).then(unwrap),
  removeMember: (memberId: string) =>
    klaApi.request<null>(`/v1/sany/members/${memberId}`, { method: 'DELETE' }).then(unwrap),
  addDocument: (input: SanyDocumentInput) =>
    klaApi.request<SanyDocumentDto>('/v1/sany/documents', { method: 'POST', body: JSON.stringify(input) }).then(unwrap),
  removeDocument: (documentId: string) =>
    klaApi.request<null>(`/v1/sany/documents/${documentId}`, { method: 'DELETE' }).then(unwrap),
  addField: (input: { scope: 'company' | 'unit'; moduleKey: SanyModuleKey; taskId?: string | null; label: string; type?: string; ai?: string; human?: string | null }) =>
    klaApi.request<SanyFieldDto>('/v1/sany/fields', { method: 'POST', body: JSON.stringify(input) }).then(unwrap),
  patchField: (fieldId: string, patch: { status?: SanyFieldStatus; human?: string | null; removed?: boolean; removedReason?: string | null }) =>
    klaApi.request<SanyFieldDto>(`/v1/sany/fields/${fieldId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: patch.status,
        humanContent: patch.human,
        removed: patch.removed,
        removedReason: patch.removedReason,
      }),
    }).then(unwrap),
  createTask: (input: { title: string; intent: string; deadline: string; owners: Array<{ name: string; unit: string }>; requirements: string[] }) =>
    klaApi.request<{ created: number }>('/v1/sany/tasks', { method: 'POST', body: JSON.stringify(input) }).then(unwrap),
  patchIssue: (issueId: string, status: string) =>
    klaApi.request<{ id: string; status: string }>(`/v1/sany/issues/${issueId}`, { method: 'PATCH', body: JSON.stringify({ status }) }).then(unwrap),
  patchProject: (input: { conclusion?: string; decisions?: Record<string, string>; outputGenerated?: boolean; outputReleased?: boolean; deliveryChecks?: Record<string, boolean> }) =>
    klaApi.request<unknown>('/v1/sany/project', { method: 'PATCH', body: JSON.stringify(input) }).then(unwrap),
  addFeedback: (content: string) =>
    klaApi.request<SanyFeedbackDto>('/v1/sany/feedback', { method: 'POST', body: JSON.stringify({ content }) }).then(unwrap),
  addVersion: (outputKey: string, input: { summary: string; changes: string; size: string; file: string; status?: string }) =>
    klaApi.request<SanyOutputVersionDto>(`/v1/sany/outputs/${outputKey}/versions`, { method: 'POST', body: JSON.stringify(input) }).then(unwrap),
};
