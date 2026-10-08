-- Repair built-in roles after the compute merge without replacing existing
-- grants or modifying user-defined roles. New identities receive the same
-- business permissions in PostgresAccountRepository.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.is_system
  AND (
    (r.organization_id IS NULL AND r.name IN ('个人用户', '个人默认')
      AND p.code IN ('read', 'write', 'execute', 'manage', 'export'))
    OR (r.organization_id IS NOT NULL AND r.name = '管理员'
      AND p.code IN ('read', 'write', 'execute', 'manage', 'export'))
    OR (r.organization_id IS NOT NULL AND r.name = '成员'
      AND p.code IN ('read', 'write', 'execute', 'export'))
    OR (r.name IN ('个人用户', '个人默认', '管理员', '成员')
      AND p.code IN ('compute.view', 'compute.key.view', 'compute.key.create',
        'compute.key.update', 'compute.key.disable', 'compute.usage.view',
        'model.use', 'model.catalog.view'))
    OR (r.organization_id IS NOT NULL AND r.name = '管理员'
      AND p.code IN ('compute.organization.usage.view', 'compute.allocate', 'compute.reclaim'))
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;
