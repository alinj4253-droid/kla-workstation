// 算力与模型权限集（系统角色自动绑定用）
//
// 权限码与迁移 0014_extend_compute_schema.sql 中种子化的 permissions.code 一一对应。
// 此文件放在 repositories/ 下，供 postgres-account-repository 在 register /
// createOrganization / joinOrganization 时自动绑定，避免 repositories → compute 反向依赖。
// compute/permissions.ts 维护了同名常量副本，原因见其文件头注释（契约包运行时入口问题）。

/** 个人默认角色：可查看余额、管理本人 Key、查看本人用量、调用模型、浏览模型广场。 */
export const PERSONAL_DEFAULT_PERMISSIONS = [
  'compute.view',
  'compute.key.view',
  'compute.key.create',
  'compute.key.update',
  'compute.key.disable',
  'compute.usage.view',
  'model.use',
  'model.catalog.view',
] as const;

/** 企业管理员角色：个人默认全部权限 + 查看企业汇总 + 分配/回收成员额度。 */
export const ENTERPRISE_ADMIN_PERMISSIONS = [
  ...PERSONAL_DEFAULT_PERMISSIONS,
  'compute.organization.usage.view',
  'compute.allocate',
  'compute.reclaim',
] as const;

/** 企业成员角色：与个人默认一致（企业额度由管理员分配，成员仅使用本人配额）。 */
export const ENTERPRISE_MEMBER_PERMISSIONS = [...PERSONAL_DEFAULT_PERMISSIONS] as const;
