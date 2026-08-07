import type { ChannelAdapter, ChannelTestResult, ResolvedChannelConfig, ChannelEventSink, ExternalTarget, OutboundChannelMessage, DeliveryReceipt, ChannelHealth, ChannelType, InboundChannelEvent, ExternalConversationInfo } from './types';

const DINGTALK_API = 'https://oapi.dingtalk.com';

export class DingTalkAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'dingtalk';
  private _clientId = '';
  private _clientSecret = '';
  private _token: string | null = null;
  private _tokenExpiresAt = 0;
  private _sink: ChannelEventSink | null = null;
  private _started = false;
  private _startTime = 0;
  private _lastError: string | null = null;
  private _abortController: AbortController | null = null;

  async test(config: ResolvedChannelConfig, signal: AbortSignal): Promise<ChannelTestResult> {
    const clientId = (config.config.clientId as string) ?? '';
    const clientSecret = config.secrets.clientSecret ?? (config.config.clientSecret as string) ?? '';
    if (!clientId || !clientSecret) {
      return { success: false, message: '缺少 Client ID 或 Client Secret' };
    }
    const start = Date.now();
    try {
      const resp = await fetch(`${DINGTALK_API}/gettoken?appkey=${clientId}&appsecret=${clientSecret}`, { signal });
      const data = await resp.json() as { errcode: number; errmsg: string; access_token?: string };
      return {
        success: data.errcode === 0,
        message: data.errcode === 0 ? '钉钉验证成功' : `验证失败: ${data.errmsg}`,
        latencyMs: Date.now() - start,
        httpStatus: resp.status,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : '连接失败',
        latencyMs: Date.now() - start,
      };
    }
  }

  async start(config: ResolvedChannelConfig, sink: ChannelEventSink): Promise<void> {
    this._clientId = (config.config.clientId as string) ?? '';
    this._clientSecret = config.secrets.clientSecret ?? (config.config.clientSecret as string) ?? '';
    this._sink = sink;
    this._started = true;
    this._startTime = Date.now();
    this._abortController = new AbortController();
    await this._refreshToken();
    // DingTalk Stream mode would be established here
    // In MVP, this is a stub that logs the intent
    console.log('[DingTalkAdapter] Stream mode connection stub - real WS connection requires dingtalk-stream SDK');
  }

  async stop(): Promise<void> {
    this._started = false;
    this._abortController?.abort();
    this._abortController = null;
    this._sink = null;
  }

  async send(target: ExternalTarget, message: OutboundChannelMessage): Promise<DeliveryReceipt> {
    try {
      if (!this._token) await this._refreshToken();
      const token = this._token ?? '';
      const resp = await fetch(`${DINGTALK_API}/v1.0/robot/groupMessages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          target: { conversationId: target.conversationId },
          content: { msgType: 'text', text: { content: message.text } },
        }),
      });
      const data = await resp.json() as { ok: boolean; errmsg?: string; processQueryKey?: string };
      return {
        ok: data.ok ?? resp.ok,
        externalEventId: data.processQueryKey ?? null,
        error: data.errmsg ?? null,
        sentAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        ok: false,
        externalEventId: null,
        error: err instanceof Error ? err.message : '发送失败',
        sentAt: new Date().toISOString(),
      };
    }
  }

  health(): ChannelHealth {
    return {
      connected: this._started,
      lastPingAt: this._started ? new Date().toISOString() : null,
      lastError: this._lastError,
      uptimeMs: this._started ? Date.now() - this._startTime : 0,
    };
  }

  async getConversationInfo(target: ExternalTarget): Promise<ExternalConversationInfo> {
    // Best-effort: real verification requires the DingTalk Stream inbound link (MVP stub).
    // Message events carry openConversationId in the same `cid...` format used for sending.
    const valid = /^cid[a-zA-Z0-9_\-=]+$/.test(target.conversationId);
    return valid ? { exists: true } : { exists: false, error: '钉钉会话 ID 格式无效' };
  }

  private async _refreshToken(): Promise<void> {
    if (Date.now() < this._tokenExpiresAt - 60000) return;
    try {
      const resp = await fetch(`${DINGTALK_API}/gettoken?appkey=${this._clientId}&appsecret=${this._clientSecret}`);
      const data = await resp.json() as { errcode: number; access_token?: string; expires_in?: number };
      if (data.errcode === 0 && data.access_token) {
        this._token = data.access_token;
        this._tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
      }
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
    }
  }
}