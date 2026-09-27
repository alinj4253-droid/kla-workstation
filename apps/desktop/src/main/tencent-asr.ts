import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { safeStorage } from 'electron';

const TENCENT_ASR_HOST = 'asr.cloud.tencent.com';
const TENCENT_CAM_HOST = 'cam.tencentcloudapi.com';
const TENCENT_CAM_SERVICE = 'cam';
const TENCENT_CAM_VERSION = '2019-01-16';
const TENCENT_ASR_ENGINE_MODEL_TYPE = '16k_zh_en_speaker_2.0';
const SIGNATURE_TTL_SECONDS = 300;

// 腾讯云 ASR 凭据不再内嵌在生产源码。运行时从环境变量或加密 secrets 表解析，
// 二者都缺失时相关接口抛出明确的“未配置”错误，而不是回退到写死的密钥。
const TENCENT_ASR_ENV_SECRET_ID = 'TENCENT_ASR_SECRET_ID';
const TENCENT_ASR_ENV_SECRET_KEY = 'TENCENT_ASR_SECRET_KEY';
const TENCENT_ASR_SECRET_KIND = 'tool-tencent-asr';

export type TencentAsrConfig = {
  appId: string;
  secretId: string;
  secretKey: string;
  engineModelType: string;
};

type TencentAsrUrlOptions = {
  voiceId?: string;
  timestamp?: number;
  nonce?: number;
  speakerContextId?: string;
};

type TencentCamResponse = {
  Response?: {
    AppId?: number | string;
    OwnerAppId?: number | string;
    Error?: { Code?: string; Message?: string };
  };
};

let cachedAppId = '';
let appIdRequest: Promise<string> | null = null;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string): Buffer => createHmac('sha256', key).update(value).digest();

export function createTencentCamAuthorization(credentials: Pick<TencentAsrConfig, 'secretId' | 'secretKey'>, timestamp: number): string {
  const action = 'GetUserAppId';
  const payload = '{}';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TENCENT_CAM_HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const date = new Date(timestamp * 1_000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${TENCENT_CAM_SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${credentials.secretKey}`, date);
  const secretService = hmac(secretDate, TENCENT_CAM_SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function createTencentCamHeaders(timestamp: number, credentials: Pick<TencentAsrConfig, 'secretId' | 'secretKey'>): Record<string, string> {
  const action = 'GetUserAppId';
  return {
    Authorization: createTencentCamAuthorization(credentials, timestamp),
    'Content-Type': 'application/json; charset=utf-8',
    Host: TENCENT_CAM_HOST,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': TENCENT_CAM_VERSION,
  };
}

type SecretRow = { id: string; ciphertext: Buffer | string };

/** 解析腾讯云 ASR 凭据：优先环境变量，其次加密 secrets 表，缺失返回 null。 */
export function resolveTencentAsrCredentials(db?: Database.Database): Pick<TencentAsrConfig, 'secretId' | 'secretKey'> | null {
  const envSecretId = process.env[TENCENT_ASR_ENV_SECRET_ID]?.trim();
  const envSecretKey = process.env[TENCENT_ASR_ENV_SECRET_KEY]?.trim();
  if (envSecretId && envSecretKey) return { secretId: envSecretId, secretKey: envSecretKey };

  if (db) {
    try {
      const row = db.prepare(
        'SELECT id, ciphertext FROM secrets WHERE kind = ? ORDER BY updated_at DESC LIMIT 1',
      ).get(TENCENT_ASR_SECRET_KIND) as SecretRow | undefined;
      if (row && safeStorage.isEncryptionAvailable()) {
        const [secretId, secretKey] = safeStorage.decryptString(row.ciphertext as Buffer).split(':');
        if (secretId && secretKey) return { secretId, secretKey };
      }
    } catch { /* 密钥解析失败按未配置处理 */ }
  }
  return null;
}

async function requestTencentAppId(fetchImpl: typeof fetch, credentials: Pick<TencentAsrConfig, 'secretId' | 'secretKey'>): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(`https://${TENCENT_CAM_HOST}`, {
      method: 'POST',
      headers: createTencentCamHeaders(timestamp, credentials),
      body: '{}',
      signal: controller.signal,
    });
    const payload = await response.json() as TencentCamResponse;
    const apiError = payload.Response?.Error;
    if (!response.ok || apiError) {
      throw new Error(apiError?.Message || `腾讯云账号信息查询失败（HTTP ${response.status}）`);
    }
    const appId = String(payload.Response?.AppId ?? payload.Response?.OwnerAppId ?? '').trim();
    if (!/^\d+$/.test(appId)) throw new Error('腾讯云账号信息中未返回有效的数字 AppID');
    return appId;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('腾讯云账号信息查询超时', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getTencentAsrAppId(fetchImpl: typeof fetch = globalThis.fetch, opts: { credentials?: Pick<TencentAsrConfig, 'secretId' | 'secretKey'>; db?: Database.Database } = {}): Promise<string> {
  if (cachedAppId) return cachedAppId;
  if (!appIdRequest) {
    const credentials = opts.credentials ?? resolveTencentAsrCredentials(opts.db);
    if (!credentials) throw new Error('腾讯云实时语音识别未配置凭据，请在设置或环境变量中配置 TENCENT_ASR_SECRET_ID/KEY');
    appIdRequest = requestTencentAppId(fetchImpl, credentials)
      .then((appId) => {
        cachedAppId = appId;
        return appId;
      })
      .finally(() => { appIdRequest = null; });
  }
  return appIdRequest;
}

export function resetTencentAsrAppIdCache(): void {
  cachedAppId = '';
  appIdRequest = null;
}

export function createTencentAsrSignedUrl(config: TencentAsrConfig, options: TencentAsrUrlOptions = {}): { url: string; voiceId: string } {
  if (!/^\d+$/.test(config.appId)) throw new Error('腾讯实时语音识别需要有效的数字 AppID');
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1_000);
  const voiceId = options.voiceId ?? randomUUID();
  const nonce = options.nonce ?? randomInt(1, 2_147_483_647);
  const params: Record<string, string> = {
    enable_speaker_context: '1',
    engine_model_type: config.engineModelType,
    expired: String(timestamp + SIGNATURE_TTL_SECONDS),
    filter_dirty: '1',
    filter_modal: '1',
    filter_punc: '0',
    needvad: '1',
    nonce: String(nonce),
    secretid: config.secretId,
    timestamp: String(timestamp),
    voice_format: '1',
    voice_id: voiceId,
  };
  const speakerContextId = options.speakerContextId?.trim();
  if (speakerContextId) params.speaker_context_id = speakerContextId;
  const query = Object.keys(params).sort().map((key) => `${key}=${encodeURIComponent(params[key]!)}`).join('&');
  const signedContent = `${TENCENT_ASR_HOST}/asr/v2/${config.appId}?${query}`;
  const signature = createHmac('sha1', config.secretKey).update(signedContent).digest('base64');
  return {
    url: `wss://${signedContent}&signature=${encodeURIComponent(signature)}`,
    voiceId,
  };
}

export async function createTencentAsrSession(options: Pick<TencentAsrUrlOptions, 'speakerContextId'> = {}, db?: Database.Database): Promise<{ url: string; voiceId: string; engineModelType: string }> {
  const credentials = resolveTencentAsrCredentials(db);
  if (!credentials) throw new Error('腾讯云实时语音识别未配置凭据，请在设置或环境变量中配置 TENCENT_ASR_SECRET_ID/KEY');
  const appId = await getTencentAsrAppId(globalThis.fetch, db
    ? { credentials, db }
    : { credentials });
  const config: TencentAsrConfig = {
    appId,
    secretId: credentials.secretId,
    secretKey: credentials.secretKey,
    engineModelType: TENCENT_ASR_ENGINE_MODEL_TYPE,
  };
  return { ...createTencentAsrSignedUrl(config, options), engineModelType: config.engineModelType };
}
