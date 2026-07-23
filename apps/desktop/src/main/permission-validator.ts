/** 权限定义结构 */
export type PermissionDefinition = {
  read?: string[];
  write?: string[];
  network?: string;
  shell?: string;
};

/** 校验有效权限是否在最大权限范围内 */
export function validateEffectivePermissions(
  effective: PermissionDefinition,
  max: PermissionDefinition,
): { allowed: boolean; reason?: string } {
  const categories = ['read', 'write'] as const;
  for (const cat of categories) {
    const effectiveList = effective[cat] ?? [];
    const maxList = max[cat] ?? [];
    for (const item of effectiveList) {
      if (!maxList.includes(item)) {
        return {
          allowed: false,
          reason: `权限 ${cat}:${item} 超出了定义允许的最大范围`,
        };
      }
    }
  }

  const scalarFields = ['network', 'shell'] as const;
  for (const field of scalarFields) {
    if (effective[field] !== undefined && effective[field] !== max[field]) {
      return {
        allowed: false,
        reason: `权限 ${field}:${effective[field]} 超出了定义允许的最大值 (${max[field] ?? '未设置'})`,
      };
    }
  }

  return { allowed: true };
}