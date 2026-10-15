// 只读诊断：用当前 COMPUTE_SECRET_ENCRYPTION_KEY 逐条尝试解密 compute_bindings.managed_password，
// 输出可解密/不可解密清单，用于托管凭据故障定位。不做任何写操作。
// 用法：node scripts/diagnose-managed-passwords.mjs
import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

// ---- 读取 .env（只取需要的键，不覆盖已有环境变量） ----
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const key = process.env.COMPUTE_SECRET_ENCRYPTION_KEY;
if (!key) { console.error('COMPUTE_SECRET_ENCRYPTION_KEY 未配置'); process.exit(1); }
const keyBuf = /^[0-9a-fA-F]{64}$/.test(key) ? Buffer.from(key, 'hex') : Buffer.from(key, 'base64');
if (keyBuf.length !== 32) { console.error(`密钥长度非法：${keyBuf.length} 字节（需 32）`); process.exit(1); }

function tryDecrypt(stored) {
  if (!stored) return { ok: false, reason: 'empty' };
  const parts = stored.split(':');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[1], 'base64')), decipher.final()]).toString('utf8');
    return { ok: true, plain };
  } catch {
    return { ok: false, reason: 'auth' };
  }
}

const client = new Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=kla,public' });
await client.connect();
const { rows } = await client.query(
  'SELECT identity_id, sub2api_user_id, sub2api_username, sub2api_status, managed_password FROM compute_bindings ORDER BY identity_id',
);
let okCount = 0;
const failed = [];
for (const row of rows) {
  const r = tryDecrypt(row.managed_password);
  if (r.ok) { okCount += 1; continue; }
  failed.push({ identity: row.identity_id, sub2apiUserId: row.sub2api_user_id, username: row.sub2api_username, status: row.sub2api_status, reason: r.reason });
}
console.log(`总 binding 数：${rows.length}`);
console.log(`当前密钥可解密：${okCount}`);
console.log(`解密失败：${failed.length}`);
if (failed.length > 0) {
  console.table(failed);
}
await client.end();
