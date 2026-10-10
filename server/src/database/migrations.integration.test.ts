import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { runMigrations } from './migrations.js';

const config = loadConfig();
const testCase = config.databaseUrl ? it : it.skip;

describe('complete database initialization', () => {
  testCase('initializes collaboration and compute tables in an empty schema and can run twice', async () => {
    const schema = `kla_merge_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 2, connectionTimeoutMillis: 5000 });
    try {
      await runMigrations(pool, schema);
      await runMigrations(pool, schema);
      const tables = await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [schema]);
      expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(['users', 'identities', 'projects', 'messages', 'conversation_runs', 'artifacts', 'compute_bindings', 'compute_keys', 'compute_model_pricing', 'outbox_events', 'knowledge_client_state']));
      const applied = await pool.query('SELECT id FROM schema_migrations ORDER BY id');
      expect(applied.rows.map((row) => row.id)).toEqual(expect.arrayContaining(['0013_compute_sub2api', '0014_extend_compute_schema', '0015_compute_model_pricing', '0016_shared_upstream_account', '0017_system_role_business_permissions', '0018_knowledge_client_state']));
      const permissions = await pool.query("SELECT p.code FROM roles r JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE r.name='个人用户'");
      expect(permissions.rows.map((row) => row.code)).toEqual(expect.arrayContaining(['write', 'execute', 'compute.view', 'model.use']));

      // Simulate a database that applied the merged migration under its old ID.
      // Running again must preserve that record and must not re-grant permissions.
      expect(applied.rows.map((row) => row.id)).toContain('0037_compute_points_and_tools');
      await pool.query("UPDATE schema_migrations SET id='0036_compute_points_and_tools' WHERE id='0037_compute_points_and_tools'");
      await pool.query("DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code='tool.search.use')");
      await runMigrations(pool, schema);
      const legacy = await pool.query("SELECT id FROM schema_migrations WHERE id IN ('0036_compute_points_and_tools','0037_compute_points_and_tools')");
      expect(legacy.rows).toEqual([{ id: '0036_compute_points_and_tools' }]);
      const toolGrants = await pool.query("SELECT 1 FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code='tool.search.use')");
      expect(toolGrants.rowCount).toBe(0);
    } finally {
      // Only this test's newly created, randomly named schema is removed.
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 30_000);
});
