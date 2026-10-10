import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { PostgresDatabase } from './postgres.js';

/**
 * 给指定身份批量授予 knowledge_documents 里的全部文档（幂等，可重复执行）。
 *
 * 用法：
 *   pnpm db:grant -- "显示名或邮箱" ["另一个" ...]
 *   pnpm db:grant -- --all            # 授权给所有身份（谨慎）
 *   pnpm db:grant -- --list           # 只列出可授权的身份与当前授权数
 *   pnpm db:grant -- --clear "老K"    # 撤销某身份的全部授权
 *
 * scope 决定归属语义：
 *   company  公司知识库，owner/project 皆空（全员可见）
 *   project  项目知识库，写入 project_id（仅该项目成员可见）
 *   personal 个人知识库，owner_identity_id = 本人（仅本人可见）
 *
 * 授权粒度是文档，集合名只是冗余标注，便于「按集合批量授权」时不必 join。
 */

const config = loadConfig();
const args = process.argv.slice(2);
const flag = args.find(arg => /^--(all|list|clear)$/.test(arg)) ?? '';
const targets = args.filter(arg => !arg.startsWith('--'));
const scope = (process.env.GRANT_SCOPE ?? 'company') as 'company' | 'project' | 'personal';
if (!['company', 'project', 'personal'].includes(scope)) throw new Error('GRANT_SCOPE 只能是 company / project / personal');
const projectId = process.env.GRANT_PROJECT_ID || null;

const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
try {
  await database.migrate(config.databaseSchema);
  const pool = database.rawPool;
  if (!pool) throw new Error('DATABASE_URL 未配置');

  if (flag === '--list' || !targets.length) {
    const rows = await pool.query(`SELECT i.id, i.display_name, i.type, u.email,
        (SELECT count(*)::int FROM document_access_policy p WHERE p.identity_id = i.id) AS granted,
        (SELECT count(*)::int FROM knowledge_documents) AS total
      FROM identities i JOIN users u ON u.id = i.user_id
      ORDER BY granted DESC, i.created_at DESC`);
    console.log('身份 | 类型 | 邮箱 | 已授权文档数');
    for (const row of rows.rows) {
      const mark = row.type === 'enterprise' ? '[企业]' : row.type === 'personal' ? '[个人]' : '      ';
      console.log(`  ${row.display_name.padEnd(14)}${mark} ${String(row.email).padEnd(32)} ${row.granted}/${row.total}`);
    }
    // --clear 不带目标 = 撤销全部授权（比逐个身份撤销更实用，且可随时重新授权）
    if (flag === '--clear') {
      const removed = await pool.query('DELETE FROM document_access_policy');
      console.log(`\n已撤销全部授权：${removed.rowCount} 条`);
      await database.close();
      process.exit(0);
    }
    console.log('\n用 pnpm db:grant -- "显示名或邮箱" 授权；加 --all 授权全部身份；加 --clear 撤销（不带目标=全清）。');
    await database.close();
    process.exit(0);
  }

  /**
   * 匹配规则：目标写成「显示名」或「邮箱」都可；两者都可时按 **AND** 精确锁定这一个身份。
   * 库里同一个邮箱常挂着多个身份（如 klzz@qq.com 同时有个人与企业身份），
   * 只按邮箱匹配会一次授权多个身份，粒度就不可控了。
   */
  const identities = flag === '--all'
    ? (await pool.query('SELECT i.id, i.display_name, i.type, u.email FROM identities i JOIN users u ON u.id = i.user_id ORDER BY i.created_at')).rows
    : (await Promise.all(targets.map(async target => {
      // 目标写成 identity UUID 时精确命中单个身份——库里同名/同邮箱常挂多个身份，
      // 靠名字匹配会一次授权到无关主体，所以 UUID 是唯一可靠的精确入口。
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
        return (await pool.query('SELECT i.id, i.display_name, i.type, u.email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.id = $1', [target])).rows;
      }
      const exact = await pool.query(
        'SELECT i.id, i.display_name, i.type, u.email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.display_name = $1 AND u.email = $2',
        [target, target],
      );
      if (exact.rowCount) return exact.rows;
      const loose = await pool.query(
        'SELECT i.id, i.display_name, i.type, u.email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.display_name = $1 OR u.email = $1 OR u.nickname = $1 ORDER BY i.created_at',
        [target],
      );
      if (loose.rows.length > 1) throw new Error(`「${target}」匹配到 ${loose.rows.length} 个身份，请改用 identity UUID 精确授权`);
      return loose.rows;
    }))).flat();
  if (!identities.length) throw new Error(`未找到身份：${targets.join('、')}`);

  const documents = await pool.query('SELECT doc_id, collection FROM knowledge_documents');
  if (!documents.rowCount) {
    console.log('knowledge_documents 为空，请先执行 pnpm db:sync-documents');
    await database.close();
    process.exit(0);
  }

  if (flag === '--clear') {
    const removed = await pool.query('DELETE FROM document_access_policy WHERE identity_id = ANY($1::uuid[])', [identities.map(row => row.id)]);
    console.log(`已撤销 ${identities.length} 个身份共 ${removed.rowCount} 条授权`);
    await database.close();
    process.exit(0);
  }

  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    for (const identity of identities) {
      for (const document of documents.rows) {
        await client.query(
          `INSERT INTO document_access_policy (identity_id, doc_id, collection, scope, owner_identity_id, project_id, granted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$1)
           ON CONFLICT (identity_id, doc_id) DO UPDATE SET collection = EXCLUDED.collection, scope = EXCLUDED.scope,
             owner_identity_id = EXCLUDED.owner_identity_id, project_id = EXCLUDED.project_id`,
          [identity.id, document.doc_id, document.collection, scope, scope === 'personal' ? identity.id : null, scope === 'project' ? projectId : null],
        );
        written++;
      }
      console.log(`  ✔ ${identity.display_name}（${identity.type}/${identity.email}）-> ${documents.rowCount} 个文档`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const stat = await pool.query(`SELECT p.scope, count(*)::int AS grants, count(DISTINCT p.identity_id)::int AS identities
    FROM document_access_policy p GROUP BY p.scope ORDER BY grants DESC`);
  console.log(`\n共写入 ${written} 条授权（scope=${scope}${projectId ? `, project_id=${projectId}` : ''}）`);
  for (const row of stat.rows) console.log(`  ${row.scope}: ${row.grants} 条授权 / ${row.identities} 个身份`);
} finally {
  await database.close();
}
