import { loadConfig } from '../config.js';
import { PostgresDatabase } from './postgres.js';

/**
 * 建立一个公司知识库记录，并把现有文档与授权挂到该库上（幂等，可重复执行）。
 *
 * 用途：knowledge_documents / document_access_policy 有 knowledge_base_id 外键，
 * 但知识库目录本身还没有任何记录，导致关联链断在 NULL 上。这里建一个「公司知识库」
 * 记录并回填，让「库 → 文档 → 授权」三层能串起来读。
 *
 * 用法：
 *   pnpm db:seed-company-base -- --org<organizations.id> --creator <identities.id> [--collection 金牌知识库]
 *
 * 参数：
 *   --org       企业ID（organizations.id），必填
 *   --creator   创建者身份ID（identities.id），必填
 *   --collection 远端集合名，默认「金牌知识库」
 *   --name      库名，默认「公司知识库」
 *   --dry-run   只打印将要执行的语句，不落库
 *
 * 说明：scope 固定为 company，因此 organization_id 必填、project_id 与
 * owner_identity_id 必须为空（knowledge_bases 的 CHECK 约束保证互斥）。
 * 该脚本**不读写 knowledge_library_scopes**，与那张表的维护方互不干扰。
 */

const config = loadConfig();
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const organizationId = value('--org');
const creatorId = value('--creator');
const collection = value('--collection') ?? '金牌知识库';
const name = value('--name') ?? '公司知识库';
const dryRun = args.includes('--dry-run');
if (!organizationId || !creatorId) {
  console.error('用法：pnpm db:seed-company-base -- --org <organizations.id> --creator <identities.id> [--collection 金牌知识库] [--dry-run]');
  process.exit(1);
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const [label, value] of [['--org', organizationId], ['--creator', creatorId]] as const) {
  if (!uuidPattern.test(value)) throw new Error(`${label} 不是合法 UUID：${value}`);
}

const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
try {
  await database.migrate(config.databaseSchema);
  const pool = database.rawPool;
  if (!pool) throw new Error('DATABASE_URL 未配置');

  // 校验归属：企业必须存在且有效；创建者必须是有效身份
  const organization = (await pool.query('SELECT id, name, status FROM organizations WHERE id=$1', [organizationId])).rows[0];
  if (!organization) throw new Error(`企业不存在：${organizationId}`);
  if (organization.status !== 'active') throw new Error(`企业已停用：${organization.name}`);
  const creator = (await pool.query('SELECT id, display_name, type, status FROM identities WHERE id=$1', [creatorId])).rows[0];
  if (!creator) throw new Error(`身份不存在：${creatorId}`);
  if (creator.status !== 'active') throw new Error(`身份已停用：${creator.display_name}`);

  const existing = (await pool.query(
    `SELECT id FROM knowledge_bases WHERE scope='company' AND organization_id=$1 AND collection=$2`, [organizationId, collection])).rows[0];
  const libraryId = existing?.id ?? crypto.randomUUID();
  const statements = [
    {
      label: existing ? '更新已有库记录' : '新建库记录',
      sql: `INSERT INTO knowledge_bases (id, name, description, collection, scope, organization_id, project_id, owner_identity_id, created_by_identity_id)
            VALUES ($1,$2,$3,$4,'company',$5,NULL,NULL,$6)
            ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, status='active', updated_at=now()`,
      values: [libraryId, name, `${collection} 的企业共享知识库`, collection, organizationId, creatorId],
    },
    {
      label: '回填 knowledge_documents.knowledge_base_id',
      sql: `UPDATE knowledge_documents SET knowledge_base_id=$1 WHERE collection=$2 AND (knowledge_base_id IS DISTINCT FROM $1)`,
      values: [libraryId, collection],
    },
    {
      label: '回填 document_access_policy.knowledge_base_id',
      sql: `UPDATE document_access_policy SET knowledge_base_id=$1 WHERE collection=$2 AND (knowledge_base_id IS DISTINCT FROM $1)`,
      values: [libraryId, collection],
    },
  ];

  console.log(`企业：${organization.name}（${organizationId}）`);
  console.log(`创建者：${creator.display_name}（${creator.type}/${creatorId}）`);
  console.log(`集合：${collection}｜库名：${name}｜库ID：${libraryId}`);
  console.log(`库记录：${existing ? '已存在，将更新' : '将新建'}`);
  if (dryRun) {
    for (const statement of statements) console.log(`  [dry-run] ${statement.label}: ${statement.sql}`);
    await database.close();
    process.exit(0);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) {
      const result = await client.query(statement.sql, statement.values);
      console.log(`  ✔ ${statement.label}：${result.rowCount} 行`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log('\n=== 关联结果 ===');
  const documents = await pool.query('SELECT count(*)::int AS total, count(knowledge_base_id)::int AS linked FROM knowledge_documents');
  console.log(`knowledge_documents：${documents.rows[0]?.linked}/${documents.rows[0]?.total} 已关联`);
  const policies = await pool.query('SELECT count(*)::int AS total, count(knowledge_base_id)::int AS linked FROM document_access_policy');
  console.log(`document_access_policy：${policies.rows[0]?.linked}/${policies.rows[0]?.total} 已关联`);
  const bases = await pool.query('SELECT id, name, scope, collection, status FROM knowledge_bases');
  console.log(`knowledge_bases：${bases.rowCount} 行`);
  for (const row of bases.rows) console.log(`  ${row.name} | ${row.scope} | ${row.collection} | ${row.status} | ${row.id}`);
} finally {
  await database.close();
}