// 给账号补一个企业身份 + 复制同组织参照身份的角色授权（幂等，可重复执行）
// 用法：node scripts/grant-org-identity.mjs <邮箱> [组织名]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(here, '..', '.env'), 'utf8');
const val = (k) => {
  const line = env.split(/\r?\n/).find((l) => l.trim().startsWith(k + '='));
  return line ? line.slice(k.length + 1).trim().replace(/^["']|["']$/g, '') : undefined;
};
const email = process.argv[2];
const orgName = process.argv[3] || '鲲鹭制造';
if (!email) { console.error('用法：node scripts/grant-org-identity.mjs <邮箱> [组织名]'); process.exit(1); }

const pool = new pg.Pool({ connectionString: val('DATABASE_URL') });
await pool.query(`SET search_path TO "${val('DATABASE_SCHEMA') || 'public'}"`);

const user = (await pool.query('SELECT id, email FROM users WHERE email=$1', [email])).rows[0];
if (!user) { console.error('未找到账号', email); process.exit(1); }
const org = (await pool.query('SELECT id, name, status FROM organizations WHERE name=$1', [orgName])).rows[0];
if (!org) { console.error('未找到组织', orgName); process.exit(1); }
if (org.status !== 'active') { console.error('组织状态非 active：', org.status); process.exit(1); }

// ① 身份：已存在则激活，否则创建（同 user+org 只能有一个 active 企业身份）
let identityId = (await pool.query(
  'SELECT id FROM identities WHERE user_id=$1 AND organization_id=$2 AND type=$3',
  [user.id, org.id, 'enterprise'])).rows[0]?.id;
if (identityId) {
  await pool.query("UPDATE identities SET status='active' WHERE id=$1", [identityId]);
  console.log(`✓ 企业身份已存在并激活：${identityId}`);
} else {
  identityId = (await pool.query(
    `INSERT INTO identities (user_id, type, display_name, organization_id, status, is_default)
     VALUES ($1, 'enterprise', $2, $3, 'active', false) RETURNING id`,
    [user.id, user.email.split('@')[0], org.id])).rows[0].id;
  console.log(`✓ 已创建「${orgName}」企业身份：${identityId}`);
}

// ② 角色：企业身份必须显式授权（hasPermission 对 personal 免检、企业身份必须有角色）
//    复制同组织内角色最多的活跃企业身份的角色授权作为参照
const refRole = (await pool.query(`
  SELECT ir.identity_id, count(*) AS n FROM identity_roles ir
  JOIN identities i ON i.id = ir.identity_id
  WHERE i.organization_id = $1 AND i.type = 'enterprise' AND i.status = 'active'
    AND i.id <> $2
  GROUP BY ir.identity_id ORDER BY n DESC LIMIT 1`, [org.id, identityId])).rows[0];
if (refRole) {
  const roles = (await pool.query(
    'SELECT role_id FROM identity_roles WHERE identity_id=$1', [refRole.identity_id])).rows;
  let granted = 0;
  for (const { role_id } of roles) {
    const r = await pool.query(
      `INSERT INTO identity_roles (identity_id, role_id)
       VALUES ($1, $2) ON CONFLICT (identity_id, role_id) DO NOTHING`, [identityId, role_id]);
    granted += r.rowCount;
  }
  console.log(`✓ 参照 ${refRole.identity_id.slice(0, 8)} 复制 ${roles.length} 个角色（新增 ${granted}）`);
} else {
  console.log('⚠ 该组织内没有已授权角色的企业身份可参照，请手动授予角色');
}

// ③ 复核：可见知识库
const vis = await pool.query(`
  SELECT k.name, k.collection FROM knowledge_bases k
  JOIN identities i2 ON i2.user_id=$1 AND i2.status='active'
  LEFT JOIN organizations o ON o.id=i2.organization_id
  WHERE k.status='active' AND (i2.type='personal' OR o.status='active')
    AND (k.owner_identity_id=i2.id
      OR (i2.type='enterprise' AND k.scope='company' AND k.organization_id=i2.organization_id)
      OR (k.scope='project' AND EXISTS (SELECT 1 FROM project_members pm
           WHERE pm.project_id=k.project_id AND pm.identity_id=i2.id)))
  ORDER BY k.name`, [user.id]);
console.log('该账号当前可见知识库：',
  vis.rows.map((r) => `${r.name}(${r.collection})`).join(', ') || '（空）');

// ④ 顺带把已存连接配置的超时放宽到 600s（老配置仍是 120s）
const rows = (await pool.query(
  "SELECT identity_id, name, value FROM knowledge_client_state WHERE name LIKE '%connection%'")).rows;
let touched = 0;
for (const row of rows) {
  const v = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  const s = v?.settings;
  if (s && s.requestTimeoutMs && s.requestTimeoutMs < 600000) {
    s.requestTimeoutMs = 600000;
    if (typeof s.uploadTimeoutMs === 'number' && s.uploadTimeoutMs < 900000) s.uploadTimeoutMs = 900000;
    await pool.query('UPDATE knowledge_client_state SET value=$3, updated_at=now() WHERE identity_id=$1 AND name=$2',
      [row.identity_id, row.name, JSON.stringify(v)]);
    touched += 1;
  }
}
console.log(touched ? `✓ 已把 ${touched} 条连接配置的超时放宽到 600s/900s` : '连接配置无需调整（或已是 600s）');
await pool.end();