// 字段级加密：AES-256-GCM，用于托管密码等敏感字段
// 输出格式：base64(iv) + ':' + base64(ciphertext) + ':' + base64(authTag)

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function parseKey(key: string): Buffer {
  // 支持 32 字节 hex（64 字符）或 base64 字符串
  const buf = Buffer.from(key, 'hex');
  if (buf.length === 32) return buf;
  const b64 = Buffer.from(key, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('COMPUTE_SECRET_ENCRYPTION_KEY 必须是 32 字节（hex 或 base64）');
}

export function encryptField(plaintext: string, key: string): string {
  const keyBuf = parseKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${ciphertext.toString('base64')}:${authTag.toString('base64')}`;
}

export function decryptField(encoded: string | null, key: string): string | null {
  if (!encoded) return null;
  const [ivB64, ciphertextB64, authTagB64] = encoded.split(':');
  if (!ivB64 || !ciphertextB64 || !authTagB64) throw new Error('密文格式非法');
  const keyBuf = parseKey(key);
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * 解析身份的托管密码：可能是密文（iv:cipher:tag），也可能是明文——
 * A 侧建号在未配置加密密钥时直接落明文（base64url，不含冒号），可安全按段数判别。
 */
export function resolveManagedPassword(encoded: string | null, encryptionKey: string): string | null {
  if (!encoded) return null;
  if (encoded.split(':').length === 3) {
    if (!encryptionKey) return null;
    try {
      return decryptField(encoded, encryptionKey);
    } catch {
      return null;
    }
  }
  return encoded;
}
