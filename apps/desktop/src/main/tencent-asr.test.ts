import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTencentAsrSignedUrl, createTencentCamAuthorization, getTencentAsrAppId, resetTencentAsrAppIdCache, resolveTencentAsrCredentials } from './tencent-asr';

describe('Tencent ASR V2 signing', () => {
  beforeEach(() => {
    process.env.TENCENT_ASR_SECRET_ID = 'test-secret-id';
    process.env.TENCENT_ASR_SECRET_KEY = 'test-secret-key';
  });

  afterEach(() => {
    resetTencentAsrAppIdCache();
    vi.restoreAllMocks();
    delete process.env.TENCENT_ASR_SECRET_ID;
    delete process.env.TENCENT_ASR_SECRET_KEY;
  });

  it('builds the documented sorted HMAC-SHA1 WebSocket URL', () => {
    const result = createTencentAsrSignedUrl({
      appId: '1250000000', secretId: 'test-secret-id', secretKey: 'test-secret-key', engineModelType: '16k_zh_en_speaker_2.0',
    }, { voiceId: 'voice-test', timestamp: 1_700_000_000, nonce: 123456 });
    const query = 'enable_speaker_context=1&engine_model_type=16k_zh_en_speaker_2.0&expired=1700000300&filter_dirty=1&filter_modal=1&filter_punc=0&needvad=1&nonce=123456&secretid=test-secret-id&timestamp=1700000000&voice_format=1&voice_id=voice-test';
    const signedContent = `asr.cloud.tencent.com/asr/v2/1250000000?${query}`;
    const signature = createHmac('sha1', 'test-secret-key').update(signedContent).digest('base64');
    expect(result).toEqual({
      voiceId: 'voice-test',
      url: `wss://${signedContent}&signature=${encodeURIComponent(signature)}`,
    });
  });

  it('carries a speaker context into resumed sessions', () => {
    const result = createTencentAsrSignedUrl({
      appId: '1250000000', secretId: 'test-secret-id', secretKey: 'test-secret-key', engineModelType: '16k_zh_en_speaker_2.0',
    }, { voiceId: 'voice-resumed', timestamp: 1_700_000_000, nonce: 1, speakerContextId: 'context-24h' });
    expect(result.url).toContain('speaker_context_id=context-24h');
  });

  it('queries and caches the account AppID without exposing credentials to the renderer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { OwnerAppId: 1250000000 } }), { status: 200 }));
    await expect(getTencentAsrAppId(fetchMock)).resolves.toBe('1250000000');
    await expect(getTencentAsrAppId(fetchMock)).resolves.toBe('1250000000');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('matches the Tencent TC3 canonical request format', () => {
    expect(createTencentCamAuthorization({ secretId: 'test-secret-id', secretKey: 'test-secret-key' }, 1_700_000_000)).toBe(
      'TC3-HMAC-SHA256 Credential=test-secret-id/2023-11-14/cam/tc3_request, SignedHeaders=content-type;host, Signature=9cf2d2712bb8488bb6a569586e8780a4d14f884a4cb440d48b318c0e75fbf40d',
    );
  });

  it('resolves credentials from environment without any embedded production secret', () => {
    expect(resolveTencentAsrCredentials()).toEqual({ secretId: 'test-secret-id', secretKey: 'test-secret-key' });
  });

  it('returns null when no credentials are configured', () => {
    delete process.env.TENCENT_ASR_SECRET_ID;
    delete process.env.TENCENT_ASR_SECRET_KEY;
    expect(resolveTencentAsrCredentials()).toBeNull();
  });

  it('does not embed the production secret in the module source', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(__filename, 'utf-8');
    const realFile = require('node:path').join(__dirname, 'tencent-asr.ts');
    const moduleSource = fs.existsSync(realFile) ? fs.readFileSync(realFile, 'utf-8') : source;
    expect(moduleSource).not.toContain('nNjrmW3LOE8sQjojPgkcGqRwSuIXZN6d');
    expect(moduleSource).not.toContain('AKIDGYTLfonZ8TZQ2OXyCBvQimoqlTxE1d1C');
  });
});
