export type EnterpriseProject = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  tokenUsed: number;
  completedNodes: number;
  totalNodes: number;
};

export type EnterpriseProjectAssociations = Record<string, string>;
export type ProjectNodeKind = 'group' | 'operation' | 'meeting';

export function normalizeEnterpriseProject(value: unknown): EnterpriseProject | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<EnterpriseProject>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  const now = new Date().toISOString();
  return {
    id: item.id,
    name: item.name,
    description: typeof item.description === 'string' ? item.description : `${item.name}的目标、范围、协作节点与执行成果统一在此管理。`,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    tokenUsed: Number.isFinite(item.tokenUsed) ? Number(item.tokenUsed) : 128_640,
    completedNodes: Number.isFinite(item.completedNodes) ? Number(item.completedNodes) : 8,
    totalNodes: Number.isFinite(item.totalNodes) ? Number(item.totalNodes) : 12,
  };
}

export function normalizeEnterpriseProjects(value: unknown): EnterpriseProject[] {
  return Array.isArray(value)
    ? value.map(normalizeEnterpriseProject).filter((item): item is EnterpriseProject => !!item)
    : [];
}

export function normalizeProjectAssociations(value: unknown): EnterpriseProjectAssociations {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, projectId]) => key.includes(':') && typeof projectId === 'string'));
}

export function associationKey(kind: ProjectNodeKind, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

export function projectAssociationLabel(
  projects: EnterpriseProject[],
  associations: EnterpriseProjectAssociations,
  kind: ProjectNodeKind,
  resourceId: string,
): { name: string; linked: boolean } {
  const projectId = associations[associationKey(kind, resourceId)];
  const project = projects.find((item) => item.id === projectId);
  return project ? { name: project.name, linked: true } : { name: '未关联项目', linked: false };
}
