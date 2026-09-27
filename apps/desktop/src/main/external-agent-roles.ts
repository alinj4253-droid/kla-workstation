/** Stable product roles for externally connected CLI agents. */
export type ExternalAgentRole = {
  definitionId: string;
  defaultName: string;
  roleLabel: string;
};

const ROLES: Record<string, ExternalAgentRole> = {
  codebuddy: { definitionId: 'custom.codebuddy', defaultName: 'CodeBuddy', roleLabel: '验收智能体' },
  kimi: { definitionId: 'custom.kimi-code', defaultName: 'Kimi Code', roleLabel: '代码编写智能体' },
};

export function getExternalAgentRole(adapterType: string): ExternalAgentRole {
  return ROLES[adapterType] ?? {
    definitionId: `custom.${adapterType}`,
    defaultName: adapterType,
    roleLabel: '外接三方智能体',
  };
}

export function resolveExternalAgentName(adapterType: string, requestedName?: string | null): string {
  const name = requestedName?.trim();
  return name && name.toLowerCase() !== adapterType.toLowerCase() ? name : getExternalAgentRole(adapterType).defaultName;
}
