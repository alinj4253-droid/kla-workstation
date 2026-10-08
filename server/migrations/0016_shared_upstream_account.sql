-- 共享上游算力账号模式（SUB2API_SHARED_ACCOUNT_EMAIL 配置启用）：
-- 多个 KLA 身份可映射到同一个 Sub2API 账号，因此 compute_bindings.sub2api_user_id 不再唯一。
-- 幂等：约束/索引不存在时跳过；可重复执行。
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'compute_bindings'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%(sub2api_user_id)%'
  LOOP
    EXECUTE format('ALTER TABLE compute_bindings DROP CONSTRAINT %I', target.conname);
  END LOOP;
END $$;

-- 兼容以唯一索引形式存在的情况（约束删除后其索引会一并消失，这里只兜底）。
DROP INDEX IF EXISTS compute_bindings_sub2api_user_id_key;